import { defineAsyncComponent } from "vue";
import type { PluginRegister } from "./host/runtime";
import { HeaderMenuType } from "./host/runtime";
import { pluginActive, stopPlugin } from "./host/lifecycle";
import { hostGlobal, PANEL_KEY, PANEL_LABEL, PANEL_VALUE } from "./presentation/panel";

const openActionKey = "agent.OpenAgentAction";
const addToChatActionKey = "agent.AddToChatAction";
const treeMenuKey = "agent.treeMenu";
const assistantWindowName = "AgentAssistantWindow";

interface MenuItem {
  label: string;
  value: string;
  icon?: string;
  disabledWhenReadonly?: boolean;
  index?: number;
  children?: MenuItem[];
}

let resourceBase = "";

class AgentMenu {
  pluginId = "agent";

  async modifyTreeContextMenu(items: MenuItem[]): Promise<void> {
    // 模型树右键：AI 建模助手是多级菜单，节点级动作放在子菜单里
    items.push({
      label: "AI 建模助手",
      value: treeMenuKey,
      icon: resourceBase + "/agent.svg",
      index: 100,
      children: [
        { label: "打开助手", value: openActionKey },
        { label: "添加到聊天", value: addToChatActionKey }
      ]
    });
  }

  modifySystemToolbarMenu(items: MenuItem[], parent: string): void {
    if (parent === HeaderMenuType.Tool) items.push({ label: "AI 建模助手", value: openActionKey, icon: resourceBase + "/agent.svg" });
  }
}

/** 安装菜单、Action 与右侧面板；业务界面按需加载 */
export function install(register: PluginRegister, resourceBaseURL: string): void {
  resourceBase = resourceBaseURL;
  pluginActive.value = true;
  register.registerWindow({
    pluginId: "agent",
    windowName: assistantWindowName,
    width: 1120,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    modal: false,
    lazy: true,
    resizable: true,
    moveCenter: true,
    skipTaskbar: false,
    setParent: true,
    component: () => import("./components/modals/assistantWindow/index.vue")
  });

  const panelComponent = defineAsyncComponent(() => import("./components/panels/aiAssistant/index.vue"));
  register.registerPanelComponent({
    key: PANEL_KEY,
    label: PANEL_LABEL,
    icon: resourceBase + "/agent.svg",
    pluginId: "agent",
    comp: panelComponent,
    // 宿主 RightTabs 用 comps 渲染内容、用 value 匹配当前激活页签、用 comps/name/tip 渲染标签
    comps: panelComponent,
    value: PANEL_VALUE,
    name: PANEL_LABEL,
    tip: "AI 建模助手：对话、提案与画布操作",
    compsName: "AgentAiAssistantPanel"
  });

  register.registerMenu(new AgentMenu());
  register.registerActions([
    { key: openActionKey, loader: () => import("./actions/open-agent").then(module => ({ OpenAgentAction: module.OpenAgentAction })) },
    {
      key: addToChatActionKey,
      loader: () => import("./actions/add-to-chat").then(module => ({ AddToChatAction: module.AddToChatAction }))
    }
  ]);
}

/** 停用后终止 AI 请求、关闭面板并注销注册项 */
export function uninstall(register: PluginRegister): void {
  stopPlugin();
  const global = hostGlobal();
  if (global?.activeRightTab === PANEL_VALUE) global.setActiveRightTab?.(undefined);
  register.unregisterPanelComponent(PANEL_KEY);
  register.unregisterWindow(assistantWindowName);
  register.unregisterMenu("agent");
  register.unregisterAction([openActionKey, addToChatActionKey]);
}
