/** 本机自动记忆领域。仅从当前用户正文提取可验证原句，不改变模型工具权限。 */
export type MemoryIdentity = { kind: "account"; authority: string; userId: string } | { kind: "local-profile" };

/** 一条记忆的真实用户消息来源，删除会话后仍保留原句。 */
export interface MemorySource {
  conversationId: string;
  messageId: string;
  quote: string;
  createdAt: number;
}

/** 用户域 projectId=null；项目域仅能在原项目召回。 */
export interface MemoryEntry {
  id: string;
  revision: number;
  projectId: string | null;
  text: string;
  mode: "automatic" | "manual";
  updatedAt: number;
  source: MemorySource;
}

/** owner 和镜像共享的管理快照。contextKey 防止旧界面修改另一身份或项目。 */
export interface MemoryState {
  contextKey: string;
  identityLabel: string;
  projectId: string;
  enabled: boolean;
  available: boolean;
  entries: MemoryEntry[];
  status: "idle" | "extracting" | "saved" | "error";
  error: string;
}

/** 人工管理使所有旧提取票据失效；编辑额外校验条目版本。 */
export type MemoryCommand =
  | { kind: "enabled"; enabled: boolean }
  | { kind: "edit"; id: string; expectedRevision: number; text: string }
  | { kind: "delete"; id: string }
  | { kind: "clear"; projectId: string | null | "all" };

/** 模型只能选择原句区间及同域自动条目的替换目标。 */
export interface MemoryCandidate {
  start: number;
  end: number;
  quote: string;
  scope: "user" | "project";
  category: "preference" | "convention";
  supersedesId?: string;
}

/** 提取时固定的控制版本和来源，所有写入仍需在事务内核验。 */
export interface MemoryTicket {
  controlRevision: number;
  projectId: string;
  source: MemorySource;
  entries: MemoryEntry[];
}

/** 安全解析宿主身份。代理用户 0 和缺少 authority 的账号归此设备配置。 */
export function memoryIdentity(user?: { id?: string | number; host?: string }): MemoryIdentity {
  const userId = String(user?.id ?? "").trim();
  const authority = user?.host?.trim();
  return userId && userId !== "0" && authority ? { kind: "account", authority, userId } : { kind: "local-profile" };
}

/** 稳定身份键只用于本机数据库命名和上下文校验，不是认证凭据。 */
export function memoryIdentityKey(identity: MemoryIdentity): string {
  return JSON.stringify(identity.kind === "account" ? [identity.kind, identity.authority, identity.userId] : [identity.kind]);
}

/** 首次启用之前不读入任何历史对话。 */
export function emptyMemoryState(): MemoryState {
  return {
    contextKey: "",
    identityLabel: "此设备配置",
    projectId: "",
    enabled: false,
    available: true,
    entries: [],
    status: "idle",
    error: ""
  };
}

/** 凭据和权限指令不能被自动存储或通过记忆扩大权限。 */
export function unsafeMemoryText(text: string): boolean {
  return /(?:api[ _-]?(?:key|token)|access[ _-]?token|refresh[ _-]?token|password|passwd|secret|bearer|私钥|密钥|密码|口令|验证码|身份证|信用卡|银行卡)|(?:authorization|token|credential)\s*[:=]|https?:\/\/[^\s:]+:[^\s@]+@|sk-[\w-]{8,}|-----BEGIN|eyJ[\w-]+\.[\w-]+|(?:忽略|绕过|覆盖|提升|扩大|跳过|无需|不必).{0,18}(?:指令|规则|权限|授权|确认|安全)|(?:ignore|bypass|override|skip|elevate).{0,30}(?:instructions?|rules?|permissions?|approvals?|confirmation)|(?:system|developer)\s*(?:prompt|message)|始终.{0,8}(?:编辑模式|执行工具)|always.{0,20}(?:edit mode|execute tools)/i.test(
    text
  );
}

/** 保留字符索引，屏蔽代码、引用、外部资料区及敏感行；这些文字不会发送给提取模型。 */
export function memoryExtractionInput(raw: string): string {
  const text = raw.slice(0, 6000);
  let fence = "";
  let external = false;
  return text
    .split(/(?<=\n)/)
    .map(line => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      const inFence = !!fence;
      if (marker) fence = fence ? (marker[0] === fence[0] && marker.length >= fence.length ? "" : fence) : marker;
      if (
        /(?:以下|下面|如下).{0,12}(?:外部|引用|文档|资料|工具结果|附件)|【(?:附件|上下文|较早会话摘要)|^\s*(?:#{1,6}\s*)?(?:引用(?:内容|资料|文档)?|外部资料|文档(?:内容|原文)|(?:参考)?资料|摘录|原文|来源)\s*[:：]|<blockquote\b/i.test(
          line
        )
      )
        external = true;
      if (marker || inFence || /^\s*>/.test(line) || external || unsafeMemoryText(line)) return line.replace(/[^\r\n]/g, " ");
      return line.replace(/`[^`\n]*`|“[^”\n]*”|「[^」\n]*」|"[^"\n]*"/g, quote => " ".repeat(quote.length));
    })
    .join("");
}

/** 严格解析提取结果。伪造原句、越界、引用、敏感内容和人工覆盖均被拒绝。 */
export function parseMemoryCandidates(output: string, raw: string, projectId: string, entries: MemoryEntry[]): MemoryCandidate[] {
  const value: unknown = JSON.parse(
    output
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
  );
  if (!Array.isArray(value) || value.length > 6) throw new Error("记忆提取结果必须为最多 6 项的数组");
  const allowed = memoryExtractionInput(raw);
  const candidates: MemoryCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row: Record<string, unknown> = item;
    const { quote, scope, category, supersedesId } = row;
    const start = typeof quote === "string" ? allowed.indexOf(quote) : -1;
    const end = start + (typeof quote === "string" ? quote.length : 0);
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > allowed.length ||
      typeof quote !== "string" ||
      quote.length > 160 ||
      !quote.trim() ||
      raw.slice(start, end) !== quote ||
      allowed.slice(start, end) !== quote ||
      unsafeMemoryText(quote)
    )
      continue;
    if ((scope !== "user" && scope !== "project") || (category !== "preference" && category !== "convention")) continue;
    if (scope === "project" && !projectId) continue;
    if (
      scope === "user" &&
      (category !== "preference" ||
        !/我.{0,15}(?:喜欢|偏好|习惯|希望)|(?:以后|始终|总是).{0,16}(?:回答|回复)|(?:以后|始终).{0,8}(?:用中文|使用中文|称呼我)/.test(
          quote
        ))
    )
      continue;
    if (supersedesId !== undefined) {
      const target = entries.find(entry => entry.id === supersedesId);
      if (
        typeof supersedesId !== "string" ||
        !target ||
        target.mode !== "automatic" ||
        target.projectId !== (scope === "user" ? null : projectId) ||
        !/纠正|改为|改用|不再|以后|现在|不是|而是/.test(quote)
      )
        continue;
    }
    candidates.push({ start, end, quote, scope, category, ...(typeof supersedesId === "string" ? { supersedesId } : {}) });
  }
  return candidates;
}

/** 规范化仅用于同域精确去重，不据此改写用户原句。 */
export function normalizedMemory(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
}

function searchTerms(text: string): Set<string> {
  const terms = new Set(text.toLocaleLowerCase().match(/[a-z0-9_]+/g) ?? []);
  for (const run of text.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2));
  }
  return terms;
}

/** 非空任务召回用户偏好和相关项目约定，补充最多两项近期约定；上限8项、正文1200字。 */
export function recallMemories(entries: MemoryEntry[], projectId: string, query: string): string {
  const terms = searchTerms(query);
  if (!query.trim()) return "";
  const ranked = entries
    .filter(entry => entry.projectId === null || entry.projectId === projectId)
    .map(entry => ({
      entry,
      score: [...searchTerms(entry.text)].filter(term => terms.has(term)).length + (entry.projectId === null ? 1 : 0)
    }))
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
  const selected: string[] = [];
  let length = 0;
  let unrelatedProjects = 0;
  for (const { entry, score } of ranked) {
    if (selected.length >= 8) break;
    if (score === 0 && unrelatedProjects++ >= 2) continue;
    if (length + entry.text.length > 1200) continue;
    selected.push(
      JSON.stringify({
        scope: entry.projectId === null ? "用户偏好" : "当前项目",
        text: entry.text,
        mode: entry.mode,
        source: entry.source.messageId
      })
    );
    length += entry.text.length;
  }
  return selected.join("\n");
}
