import { Action, notify } from "../host/runtime";
import { pluginActive } from "../host/lifecycle";
import { assistantPresentation, hostGlobal, PANEL_VALUE, requestAssistantPresentation } from "../presentation/panel";

/**
 * “工具 → AI 建模助手”与模型树右键菜单的入口动作。
 *
 * 面板常驻在右侧页签（registerPanelComponent 注册，见 main.ts）：
 * - 工具菜单点击 = 开关（已激活时收起）；
 * - 模型树右键菜单点击 = 只打开，不收起（右键菜单里出现“收起”会很意外）。
 */
export class OpenAgentAction extends Action {
  keyName = "agent.OpenAgentAction";

  async run(): Promise<void> {
    setAgentPanelActive(!isPanelActive());
  }

  onTreeMenuClick(): void {
    setAgentPanelActive(true);
  }

  onSysMenuClick(): void {
    void this.run();
  }
}

/** 打开/收起右侧 AI 面板；插件未激活或宿主未就绪时提示错误而不是抛异常 */
export function setAgentPanelActive(active: boolean): void {
  if (!pluginActive.value) return;
  try {
    const global = hostGlobal();
    if (!global?.setActiveRightTab) throw new Error("请在 M-Design 中打开此插件");
    if (active && assistantPresentation() === "window") {
      // 已挂载时直接打开独立窗口，不触发宿主侧栏布局。
      // 首次挂载时先登记请求，Frame 会隐藏启动中的面板。
      if (!requestAssistantPresentation()) global.setActiveRightTab(PANEL_VALUE);
      return;
    }
    global.setActiveRightTab(active ? PANEL_VALUE : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify({ title: "AI 建模助手", message, type: "error", forbidTranslate: true });
  }
}

function isPanelActive(): boolean {
  return hostGlobal()?.activeRightTab === PANEL_VALUE;
}
