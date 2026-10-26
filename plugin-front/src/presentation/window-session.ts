import { reactive, watch } from "vue";
import type { AiAssistantStore } from "../ai-assistant/conversation/store";
import type { AiAttachment, AiProviderSettings } from "../ai-assistant/types";
import { configureAiAssistant, getAiAssistantHost } from "../ai-assistant/host";
import { loadAiProviderSettings, saveAiProviderSettings } from "../ai-assistant/provider/providerConfig";
import { emptyMemoryState } from "../ai-assistant/memory";
import type { MemoryCommand, MemoryState } from "../ai-assistant/memory";

export const ASSISTANT_WINDOW_NAME = "AgentAssistantWindow";
export const SETTINGS_CHANGED = "agent-assistant-settings-changed";
const SESSION_PROTOCOL_VERSION = 3;
const actions = [
  "setConversationOptions",
  "setDraft",
  "createConversation",
  "selectConversation",
  "setExecutionStrategy",
  "deleteConversation",
  "sendMessage",
  "executeProposal",
  "executePlan",
  "rejectPlan",
  "rollbackProposal",
  "answerChoicePrompt",
  "stop"
] as const;
const configKeys = ["activeProfileId", "profiles", "permissionMode", "skills", "favoriteModels", "dataSharingConfirmedProfileIds"] as const;

export interface AssistantDraft {
  html: string;
  attachments: AiAttachment[];
  notice: string;
  scrollTop: number;
  conversationId?: string;
  projectId?: string;
}

interface Snapshot {
  protocolVersion: number;
  messages: AiAssistantStore["messages"];
  conversations: AiAssistantStore["conversations"];
  activeConversationId: string;
  isRunning: boolean;
  runningConversationId: string;
  runningConversationIds: string[];
  drafts: AiAssistantStore["drafts"];
  errorMessage: string;
  hasMessages: boolean;
  projectId: string;
  projectName: string;
  settings: AiProviderSettings;
  memoryState: MemoryState;
}

type Packet = {
  type: string;
  conversationId?: string;
  projectId?: string;
  id?: number;
  method?: string;
  args?: unknown[];
  value?: unknown;
  error?: string;
};
type DraftAccess = { read(): AssistantDraft; write(value: AssistantDraft): void };
let draftAccess: DraftAccess | undefined;
let applyRemoteDraft = false;
let ownerDraftSender: ((draft: AssistantDraft) => void) | undefined;

export function registerDraftAccess(access: DraftAccess): () => void {
  draftAccess = access;
  return () => {
    if (draftAccess === access) draftAccess = undefined;
  };
}

export function publishDraft(): void {
  if (applyRemoteDraft || !draftAccess) return;
  const draft = draftAccess.read();
  if (detachedSession) detachedSession.send({ type: "draft", value: draft });
  else ownerDraftSender?.(draft);
}

function receiveDraft(value: AssistantDraft): void {
  applyRemoteDraft = true;
  try {
    draftAccess?.write(value);
  } finally {
    applyRemoteDraft = false;
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export const webWindowTargets = new Map<string, (target: HTMLElement, close: () => void) => void>();

/** 只有白名单命令在原项目执行；独立窗口不能直接调用任意宿主方法。 */
export function createOwnerSession(store: AiAssistantStore, onReady: () => void, onDock: () => void) {
  const id = crypto.randomUUID();
  const channel = new BroadcastChannel(`agent-window-${id}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;
  let disposed = false;
  const send = (packet: Packet) => {
    if (!disposed) channel.postMessage(packet);
  };
  const snapshot = (): Snapshot => {
    const settings = clone(loadAiProviderSettings());
    delete settings.conversationsByProject;
    const host = getAiAssistantHost();
    return clone({
      protocolVersion: SESSION_PROTOCOL_VERSION,
      messages: store.messages.map(({ modelContext, ...message }) => message),
      conversations: store.conversations.map(conversation => ({ ...conversation, messages: [] })),
      activeConversationId: store.activeConversationId,
      isRunning: store.isRunning,
      runningConversationId: store.runningConversationId,
      runningConversationIds: store.runningConversationIds,
      drafts: store.drafts,
      errorMessage: store.errorMessage,
      hasMessages: store.hasMessages,
      projectId: host.getActiveProjectId?.() ?? "",
      projectName: host.getActiveProjectName?.() ?? "",
      settings,
      memoryState: store.memoryState
    });
  };
  const sendState = () => {
    timer = undefined;
    if (!disposed) send({ type: "state", value: snapshot() });
  };
  const schedule = () => {
    if (ready && !timer) timer = setTimeout(sendState, 120);
  };
  const stopWatch = watch(
    () => [
      store.messages,
      store.conversations,
      store.activeConversationId,
      store.isRunning,
      store.runningConversationIds,
      store.errorMessage,
      store.memoryState
    ],
    schedule,
    { deep: true }
  );
  const settingsChanged = () => {
    if (ready) sendState();
  };
  window.addEventListener(SETTINGS_CHANGED, settingsChanged);
  const heartbeat = setInterval(schedule, 1000);
  ownerDraftSender = draft => {
    store.setDraft(draft.conversationId ?? store.activeConversationId, clone(draft));
    send({ type: "draft", value: clone(draft) });
  };
  channel.onmessage = async ({ data }: MessageEvent<Packet>) => {
    try {
      if (data.type === "ready") {
        sendState();
        send({
          type: "draft",
          value: clone(draftAccess?.read() ?? { html: "", attachments: [], notice: "", scrollTop: 0 })
        });
      } else if (data.type === "mounted") {
        ready = true;
        onReady();
      } else if (data.type === "draft") {
        const draft = data.value as AssistantDraft;
        if (draft.projectId && draft.projectId !== getAiAssistantHost().getActiveProjectId?.()) return;
        store.setDraft(draft.conversationId ?? store.activeConversationId, clone(draft));
        if (!draft.conversationId || draft.conversationId === store.activeConversationId) receiveDraft(draft);
      } else if (data.type === "dock") onDock();
      else if (data.type === "call") {
        let result: unknown;
        if (data.method === "pickMentions") result = await getAiAssistantHost().model.pickMentions();
        else if (data.method === "refreshMemory" || data.method === "changeMemory") {
          if (data.projectId !== getAiAssistantHost().getActiveProjectId?.()) throw new Error("项目已切换，请重新操作");
          if (data.method === "refreshMemory") await store.refreshMemory();
          else {
            const command = data.args?.[0] as MemoryCommand;
            const contextKey = data.args?.[1];
            if (!command || typeof command !== "object" || typeof contextKey !== "string") throw new Error("记忆操作参数无效");
            await store.changeMemory(command, contextKey);
          }
        } else if (data.method === "settings") {
          const incoming = data.args?.[0] as AiProviderSettings;
          const current = loadAiProviderSettings();
          for (const key of configKeys) Object.assign(current, { [key]: incoming[key] });
          saveAiProviderSettings(current);
          window.dispatchEvent(new Event(SETTINGS_CHANGED));
        } else if (actions.includes(data.method as (typeof actions)[number])) {
          const action = store[data.method as (typeof actions)[number]] as (...args: unknown[]) => unknown;
          // 长任务由原窗口继续执行，立即回执，避免跨窗口请求等待整轮结束。
          if (data.projectId && data.projectId !== getAiAssistantHost().getActiveProjectId?.()) throw new Error("项目已切换，请重新操作");
          const args = [...(data.args ?? [])];
          const targetArgument: Record<string, number> = {
            sendMessage: 2,
            executeProposal: 2,
            executePlan: 2,
            rejectPlan: 1,
            rollbackProposal: 1,
            answerChoicePrompt: 3,
            stop: 0,
            setExecutionStrategy: 1,
            setConversationOptions: 1
          };
          if (data.conversationId !== undefined && data.method! in targetArgument && args[targetArgument[data.method!]] === undefined)
            args[targetArgument[data.method!]] = data.conversationId;
          Promise.resolve(action(...args)).catch(error => {
            if (store.activeConversationId === data.conversationId) store.errorMessage = String(error);
          });
        } else throw new Error("不支持的助手窗口操作");
        sendState();
        send({ type: "reply", id: data.id, value: clone(result ?? null) });
      }
    } catch (error) {
      send({ type: "reply", id: data.id, error: error instanceof Error ? error.message : String(error) });
    }
  };
  return {
    id,
    close: () => send({ type: "close" }),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopWatch();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      window.removeEventListener(SETTINGS_CHANGED, settingsChanged);
      ownerDraftSender = undefined;
      channel.close();
    }
  };
}

export interface DetachedSession {
  store: AiAssistantStore;
  send(packet: Packet): void;
  mounted(): void;
  draft?: AssistantDraft;
  dispose(): void;
}
export let detachedSession: DetachedSession | undefined;

/** 独立渲染进程只展示镜像，模型查询、写入和 Agent 循环仍由原窗口负责。 */
export async function connectDetachedSession(id: string, close: () => void): Promise<DetachedSession> {
  const channel = new BroadcastChannel(`agent-window-${id}`);
  const state = reactive({} as Snapshot);
  let closed = false;
  let sequence = 0;
  let initialSettings = "";
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const call = (method: string, args: unknown[] = []): Promise<any> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("助手窗口已关闭"));
        return;
      }
      const requestId = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("原项目窗口未响应"));
      }, 60000);
      pending.set(requestId, { resolve, reject, timer });
      channel.postMessage({
        type: "call",
        id: requestId,
        method,
        args: clone(args),
        conversationId: store.activeConversationId,
        projectId: state.projectId
      });
    });
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimer = setTimeout(() => rejectReady(new Error("无法连接原项目窗口，请返回原窗口重试")), 10000);
  const store = reactive({
    messages: [],
    conversations: [],
    activeConversationId: "",
    isRunning: false,
    runningConversationId: "",
    runningConversationIds: [],
    drafts: {},
    errorMessage: "",
    hasMessages: false,
    memoryState: emptyMemoryState(),
    refreshMemory: () => call("refreshMemory"),
    changeMemory: (command: MemoryCommand, contextKey: string) => call("changeMemory", [command, contextKey]),
    loadProject() {},
    persistConversations() {},
    ...Object.fromEntries(
      actions.map(method => [
        method,
        (...args: unknown[]) =>
          call(method, args).catch(error => {
            store.errorMessage = error.message;
          })
      ])
    )
  }) as unknown as AiAssistantStore;
  const session: DetachedSession = {
    store,
    send: packet => {
      if (!closed) channel.postMessage(clone(packet));
    },
    mounted() {
      if (!closed) channel.postMessage({ type: "mounted" });
    },
    dispose() {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      channel.close();
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("助手窗口已关闭"));
      }
      pending.clear();
      if (detachedSession === session) detachedSession = undefined;
    }
  };
  channel.onmessage = ({ data }: MessageEvent<Packet>) => {
    if (data.type === "state") {
      const snapshot = data.value as Snapshot;
      if (snapshot.protocolVersion !== SESSION_PROTOCOL_VERSION) {
        clearTimeout(readyTimer);
        rejectReady(new Error("助手窗口与主窗口版本不一致，请关闭独立窗口，重新加载插件后再打开"));
        return;
      }
      Object.assign(state, snapshot);
      const { projectId, projectName, settings, protocolVersion, ...storeState } = snapshot;
      store.drafts = storeState.drafts;
      Object.assign(store, storeState);
      const config = JSON.stringify(settings);
      if (initialSettings && config !== initialSettings) window.dispatchEvent(new Event(SETTINGS_CHANGED));
      initialSettings = config;
      if (session.draft) {
        clearTimeout(readyTimer);
        resolveReady();
      }
    } else if (data.type === "draft") {
      session.draft = data.value as AssistantDraft;
      if (!session.draft.conversationId || session.draft.conversationId === store.activeConversationId) receiveDraft(session.draft);
      if (state.settings) {
        clearTimeout(readyTimer);
        resolveReady();
      }
    } else if (data.type === "reply" && data.id) {
      const request = pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    } else if (data.type === "close") close();
  };
  channel.postMessage({ type: "ready" });
  try {
    await ready;
  } catch (error) {
    session.dispose();
    throw error;
  }
  detachedSession = session;
  configureAiAssistant({
    model: { pickMentions: () => call("pickMentions") } as ReturnType<typeof getAiAssistantHost>["model"],
    getActiveProjectId: () => state.projectId,
    getActiveProjectName: () => state.projectName,
    settingsStorage: {
      get: () => clone(state.settings),
      set: value => {
        state.settings = clone(value);
        void call("settings", [value]).catch(error => {
          store.errorMessage = error.message;
        });
      }
    }
  });
  return session;
}
