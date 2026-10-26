import { memoryIdentityKey, normalizedMemory, unsafeMemoryText } from "./index";
import type { MemoryCandidate, MemoryCommand, MemoryEntry, MemoryIdentity, MemorySource, MemoryTicket } from "./index";

interface Control {
  id: "control";
  enabled: boolean;
  revision: number;
}
const initialControl = (): Control => ({ id: "control", enabled: false, revision: 0 });

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("记忆数据库请求失败"));
  });
}

/** 同一身份多个 owner 以 IndexedDB 原生事务提交。网络请求必须在事务之外。 */
export class MemoryDatabase {
  private connection?: Promise<IDBDatabase>;

  constructor(private identity: MemoryIdentity) {}

  private open(): Promise<IDBDatabase> {
    if (!this.connection)
      this.connection = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("当前环境无法使用本机记忆数据库"));
          return;
        }
        const opening = indexedDB.open(`m-design-agent-memory-v1-${encodeURIComponent(memoryIdentityKey(this.identity))}`, 1);
        opening.onupgradeneeded = () => {
          opening.result.createObjectStore("control", { keyPath: "id" });
          opening.result.createObjectStore("entries", { keyPath: "id" });
          opening.result.createObjectStore("sources", { keyPath: "id" });
        };
        opening.onsuccess = () => {
          const db = opening.result;
          db.onversionchange = () => {
            db.close();
            this.connection = undefined;
          };
          resolve(db);
        };
        opening.onerror = () => reject(opening.error ?? new Error("无法打开本机记忆数据库"));
        opening.onblocked = () => reject(new Error("记忆数据库被旧窗口占用，请关闭旧窗口后重试"));
      }).catch(error => {
        this.connection = undefined;
        throw error;
      });
    return this.connection;
  }

  private async transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(["control", "entries", "sources"], mode);
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("记忆事务已取消"));
      tx.onerror = () => reject(tx.error ?? new Error("记忆写入失败"));
    });
    try {
      const result = await action(tx);
      await completed;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* The transaction may already have aborted. */
      }
      await completed.catch(() => undefined);
      throw error;
    }
  }

  /** 读取控制状态和当前用户域、项目域条目，绝不返回其他项目内容。 */
  async snapshot(projectId: string): Promise<{ enabled: boolean; revision: number; entries: MemoryEntry[] }> {
    return this.transaction("readonly", async tx => {
      const [control, entries] = await Promise.all([
        request<Control | undefined>(tx.objectStore("control").get("control")),
        request<MemoryEntry[]>(tx.objectStore("entries").getAll())
      ]);
      const current = control ?? initialControl();
      return {
        enabled: current.enabled,
        revision: current.revision,
        entries: entries.filter(entry => entry.projectId === null || entry.projectId === projectId)
      };
    });
  }

  /** 捕获来源票据。已删除来源和关闭状态不会产生提取任务。 */
  async begin(projectId: string, source: MemorySource): Promise<MemoryTicket | undefined> {
    return this.transaction("readonly", async tx => {
      const [control, tombstone, entries] = await Promise.all([
        request<Control | undefined>(tx.objectStore("control").get("control")),
        request(tx.objectStore("sources").get(JSON.stringify([projectId, source.conversationId]))),
        request<MemoryEntry[]>(tx.objectStore("entries").getAll())
      ]);
      if (!control?.enabled || tombstone) return undefined;
      return {
        controlRevision: control.revision,
        projectId,
        source,
        entries: entries.filter(entry => entry.projectId === null || entry.projectId === projectId)
      };
    });
  }

  /** 每次管理操作都使旧票据失效，事务完成才返回成功。 */
  async change(projectId: string, command: MemoryCommand): Promise<void> {
    await this.transaction("readwrite", async tx => {
      const controls = tx.objectStore("control");
      const entries = tx.objectStore("entries");
      const control = (await request<Control | undefined>(controls.get("control"))) ?? initialControl();
      if (command.kind === "enabled") {
        if (typeof command.enabled !== "boolean") throw new Error("记忆开关参数无效");
        control.enabled = command.enabled;
      } else if (command.kind === "clear") {
        if (command.projectId !== "all" && command.projectId !== null && command.projectId !== projectId) throw new Error("记忆范围已切换");
        const all = await request<MemoryEntry[]>(entries.getAll());
        for (const entry of all) if (command.projectId === "all" || entry.projectId === command.projectId) entries.delete(entry.id);
      } else {
        const entry = await request<MemoryEntry | undefined>(entries.get(command.id));
        if (!entry || (entry.projectId !== null && entry.projectId !== projectId)) throw new Error("记忆已删除或范围已切换");
        if (command.kind === "delete") entries.delete(entry.id);
        else if (command.kind === "edit") {
          const text = command.text.trim();
          if (entry.revision !== command.expectedRevision) throw new Error("记忆已被其他窗口修改，请刷新后重试");
          if (!text || text.length > 160 || unsafeMemoryText(text)) throw new Error("记忆需为 1 至 160 字，不能包含凭据或权限指令");
          entries.put({ ...entry, text, mode: "manual", revision: entry.revision + 1, updatedAt: Date.now() } satisfies MemoryEntry);
        } else throw new Error("不支持的记忆操作");
      }
      controls.put({ ...control, revision: control.revision + 1 });
    });
  }

  /** 删除会话前先墓碑来源。已保存记忆保留原句，供用户独立管理。 */
  async forgetConversation(projectId: string, conversationId: string): Promise<void> {
    await this.transaction("readwrite", async tx => {
      tx.objectStore("sources").put({ id: JSON.stringify([projectId, conversationId]), deletedAt: Date.now() });
    });
  }

  /** 在同一事务中检查票据、来源及替换版本，然后合并去重；达到200项停止新增。 */
  async commit(
    ticket: MemoryTicket,
    candidates: MemoryCandidate[],
    isCurrent: () => boolean
  ): Promise<{ saved: number; full: boolean; stale: boolean }> {
    return this.transaction("readwrite", async tx => {
      const entriesStore = tx.objectStore("entries");
      const [control, tombstone, entries] = await Promise.all([
        request<Control | undefined>(tx.objectStore("control").get("control")),
        request(tx.objectStore("sources").get(JSON.stringify([ticket.projectId, ticket.source.conversationId]))),
        request<MemoryEntry[]>(entriesStore.getAll())
      ]);
      if (!isCurrent() || !control?.enabled || control.revision !== ticket.controlRevision || tombstone)
        return { saved: 0, full: false, stale: true };
      let saved = 0;
      let full = false;
      for (const candidate of candidates) {
        const projectId = candidate.scope === "user" ? null : ticket.projectId;
        const duplicate = entries.find(
          entry => entry.projectId === projectId && normalizedMemory(entry.text) === normalizedMemory(candidate.quote)
        );
        const target = candidate.supersedesId ? entries.find(entry => entry.id === candidate.supersedesId) : undefined;
        if (candidate.supersedesId) {
          const captured = ticket.entries.find(entry => entry.id === candidate.supersedesId);
          if (
            !target ||
            !captured ||
            target.mode !== "automatic" ||
            target.revision !== captured.revision ||
            target.projectId !== projectId
          )
            continue;
        }
        if (duplicate) {
          if (target && target.id !== duplicate.id) {
            entriesStore.delete(target.id);
            entries.splice(entries.indexOf(target), 1);
            saved++;
          }
          continue;
        }
        if (!target && entries.length >= 200) {
          full = true;
          continue;
        }
        const entry: MemoryEntry = {
          id: target?.id ?? crypto.randomUUID(),
          revision: (target?.revision ?? 0) + 1,
          projectId,
          text: candidate.quote,
          mode: "automatic",
          updatedAt: Date.now(),
          source: { ...ticket.source, quote: candidate.quote }
        };
        entriesStore.put(entry);
        if (target) entries[entries.indexOf(target)] = entry;
        else entries.push(entry);
        saved++;
      }
      return { saved, full, stale: false };
    });
  }
}
