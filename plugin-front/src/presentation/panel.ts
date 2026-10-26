/** 右侧 AI 助手面板的注册值与宿主激活接口（main 与打开动作共用） */

/** 面板在右侧页签里的激活值：与宿主 activeRightTab 比较，用来开关面板 */
export const PANEL_VALUE = "aiAssistant";

/** 面板在宿主 pluginRegister.panelComponentMap 里的唯一 key */
export const PANEL_KEY = "agent.aiAssistant";

/** 面板在右侧页签上显示的名称 */
export const PANEL_LABEL = "AI 助手";

/** 宿主全局对象里面板激活所需的最小接口 */
export interface HostGlobal {
  activeRightTab?: string;
  setActiveRightTab?(value?: string): void;
}

export function hostGlobal(): HostGlobal | undefined {
  return (window as Window & { app?: { global?: HostGlobal } }).app?.global;
}

const PRESENTATION_KEY = "agent.assistant.presentation";
const OPEN_EVENT = "agent-assistant-open-presentation";
export const pendingAssistantOpen = () => document.documentElement.hasAttribute("data-agent-open-requested");

export function assistantPresentation(): "window" | "panel" {
  try {
    return window.localStorage.getItem(PRESENTATION_KEY) === "window" ? "window" : "panel";
  } catch {
    return "panel";
  }
}

export function rememberAssistantPresentation(value: "window" | "panel"): void {
  try {
    window.localStorage.setItem(PRESENTATION_KEY, value);
  } catch {
    /* 存储不可用时仍允许正常打开 */
  }
}

/** 打开动作可以早于面板首次挂载，挂载后消费一次请求。 */
export function requestAssistantPresentation(): boolean {
  document.documentElement.setAttribute("data-agent-open-requested", "");
  return !window.dispatchEvent(new Event(OPEN_EVENT, { cancelable: true }));
}

export function registerAssistantPresentation(open: () => void): () => void {
  const receive = (event?: Event) => {
    event?.preventDefault();
    document.documentElement.removeAttribute("data-agent-open-requested");
    open();
  };
  window.addEventListener(OPEN_EVENT, receive);
  if (pendingAssistantOpen()) receive();
  return () => window.removeEventListener(OPEN_EVENT, receive);
}
