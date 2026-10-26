"use strict";
const test = require("node:test");
const assert = require("node:assert");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * 插件入口测试：安装时注册右侧面板与菜单、Action，停用时对称清理。
 *
 * 面板能出现在右侧页签的关键约定：注册项必须带 comps（宿主 RightTabs 用它渲染内容）
 * 与 value（宿主用它匹配 activeRightTab）。这里把它固化成断言。
 */

function transpile(relativePath) {
  const source = fs.readFileSync(require.resolve(relativePath), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

function loadPlugin(global) {
  const modules = {};
  const sandbox = {
    console,
    Error,
    Promise,
    JSON,
    Object,
    window: { app: { global } },
    require: name => {
      if (name === "vue") return { defineAsyncComponent: componentLoader => ({ __asyncComponent: componentLoader }) };
      if (name === "./host/runtime") return { HeaderMenuType: { Tool: "tool" } };
      if (name === "./host/lifecycle") return { pluginActive: { value: false }, stopPlugin: () => undefined };
      if (name === "./presentation/panel") return modules.panel;
      return {};
    }
  };
  vm.createContext(sandbox);

  sandbox.exports = {};
  vm.runInContext(transpile("../src/presentation/panel.ts"), sandbox);
  modules.panel = sandbox.exports;

  sandbox.exports = {};
  vm.runInContext(transpile("../src/main.ts"), sandbox);
  return { plugin: sandbox.exports, panel: modules.panel };
}

function createRegister() {
  const calls = {
    panelComponent: [],
    windows: [],
    unregisteredWindows: [],
    menus: [],
    actions: [],
    unregisteredPanel: [],
    unregisteredMenu: [],
    unregisteredAction: []
  };
  return {
    calls,
    registerPanelComponent: config => calls.panelComponent.push(config),
    registerWindow: config => calls.windows.push(config),
    unregisterWindow: name => calls.unregisteredWindows.push(name),
    registerMenu: modifier => calls.menus.push(modifier),
    registerActions: list => calls.actions.push(...list),
    unregisterPanelComponent: key => calls.unregisteredPanel.push(key),
    unregisterMenu: id => calls.unregisteredMenu.push(id),
    unregisterAction: keys => calls.unregisteredAction.push(...keys)
  };
}

test("安装时注册右侧面板（含 comps 与激活值）、菜单与 Action", () => {
  const global = { activeRightTab: undefined, setActiveRightTab: () => undefined };
  const { plugin, panel } = loadPlugin(global);
  const register = createRegister();

  plugin.install(register, "http://host/resources/agent");

  assert.equal(register.calls.panelComponent.length, 1);
  assert.equal(register.calls.windows[0].windowName, "AgentAssistantWindow");
  assert.equal(register.calls.windows[0].modal, false);
  assert.equal(register.calls.windows[0].resizable, true);
  const config = register.calls.panelComponent[0];
  assert.equal(config.key, panel.PANEL_KEY);
  assert.equal(config.value, panel.PANEL_VALUE);
  // 宿主 RightTabs 用 comps 渲染内容、comp 只是 PluginPanelConfig 的字段名，两者都要给
  assert.ok(config.comps);
  assert.equal(config.comp, config.comps);
  assert.equal(config.pluginId, "agent");
  assert.ok(config.compsName);
  assert.match(config.icon, /agent\.svg$/);

  assert.equal(register.calls.menus.length, 1);
  assert.equal(register.calls.menus[0].pluginId, "agent");

  assert.equal(register.calls.actions.length, 2);
  assert.deepEqual(
    register.calls.actions.map(item => item.key),
    ["agent.OpenAgentAction", "agent.AddToChatAction"]
  );
  assert.equal(typeof register.calls.actions[0].loader, "function");
  assert.equal(typeof register.calls.actions[1].loader, "function");
});

test("模型树菜单是子菜单：打开助手 + 添加到聊天；工具菜单保持直开", async () => {
  const global = { activeRightTab: undefined, setActiveRightTab: () => undefined };
  const { plugin, panel } = loadPlugin(global);
  const register = createRegister();
  plugin.install(register, "http://host/resources/agent");

  const modifier = register.calls.menus[0];
  const treeItems = [];
  await modifier.modifyTreeContextMenu(treeItems, {});
  assert.equal(treeItems.length, 1);
  assert.equal(treeItems[0].label, "AI 建模助手");
  const children = treeItems[0].children ?? [];
  assert.deepEqual(
    children.map(item => item.label),
    ["打开助手", "添加到聊天"]
  );
  assert.deepEqual(
    children.map(item => item.value),
    ["agent.OpenAgentAction", "agent.AddToChatAction"]
  );

  const toolbarItems = [];
  modifier.modifySystemToolbarMenu(toolbarItems, "tool");
  assert.equal(toolbarItems.length, 1);
  assert.equal(toolbarItems[0].value, "agent.OpenAgentAction");

  // 非“工具”父菜单不插入
  const otherItems = [];
  modifier.modifySystemToolbarMenu(otherItems, "settings");
  assert.equal(otherItems.length, 0);

  assert.equal(panel.PANEL_VALUE, "aiAssistant");
});

test("停用时关闭面板并注销注册项", () => {
  const global = { activeRightTab: "aiAssistant", setActiveRightTab: value => (global.activeRightTab = value) };
  const { plugin, panel } = loadPlugin(global);
  const register = createRegister();
  plugin.install(register, "http://host/resources/agent");

  plugin.uninstall(register);

  assert.equal(global.activeRightTab, undefined);
  assert.deepEqual(register.calls.unregisteredPanel, [panel.PANEL_KEY]);
  assert.deepEqual(register.calls.unregisteredWindows, ["AgentAssistantWindow"]);
  assert.deepEqual(register.calls.unregisteredMenu, ["agent"]);
  assert.deepEqual(register.calls.unregisteredAction, ["agent.OpenAgentAction", "agent.AddToChatAction"]);
});

test("面板未激活时停用不误关其他右侧页签", () => {
  const global = { activeRightTab: "task", setActiveRightTab: value => (global.activeRightTab = value) };
  const { plugin } = loadPlugin(global);
  const register = createRegister();
  plugin.install(register, "http://host/resources/agent");

  plugin.uninstall(register);

  assert.equal(global.activeRightTab, "task");
});

test("入口动作：工具菜单开关面板，模型树菜单只打开不收起", async () => {
  const global = { activeRightTab: undefined, setActiveRightTab: value => (global.activeRightTab = value) };
  const notifications = [];
  const modules = {};
  const sandbox = {
    console,
    Error,
    Promise,
    JSON,
    Object,
    window: { app: { global } },
    require: name => {
      if (name === "../host/runtime") {
        return {
          Action: class {},
          notify: options => notifications.push(options)
        };
      }
      if (name === "../host/lifecycle") return { pluginActive: { value: true } };
      if (name === "../presentation/panel") return modules.panel;
      return {};
    }
  };
  vm.createContext(sandbox);

  sandbox.exports = {};
  vm.runInContext(transpile("../src/presentation/panel.ts"), sandbox);
  modules.panel = sandbox.exports;

  sandbox.exports = {};
  vm.runInContext(transpile("../src/actions/open-agent.ts"), sandbox);
  const action = new sandbox.exports.OpenAgentAction();

  await action.run();
  assert.equal(global.activeRightTab, "aiAssistant");

  await action.run();
  assert.equal(global.activeRightTab, undefined);

  action.onTreeMenuClick();
  assert.equal(global.activeRightTab, "aiAssistant");

  // 已激活时再点树菜单仍然是打开状态，不收起
  action.onTreeMenuClick();
  assert.equal(global.activeRightTab, "aiAssistant");

  assert.equal(notifications.length, 0);
});

test("宿主未就绪时入口动作给出错误通知而不是抛异常", async () => {
  const notifications = [];
  const sandbox = {
    console,
    Error,
    Promise,
    JSON,
    Object,
    window: { app: {} },
    require: name => {
      if (name === "../host/runtime") {
        return {
          Action: class {},
          notify: options => notifications.push(options)
        };
      }
      if (name === "../host/lifecycle") return { pluginActive: { value: true } };
      if (name === "../presentation/panel") return { PANEL_VALUE: "aiAssistant", hostGlobal: () => undefined };
      return {};
    }
  };
  vm.createContext(sandbox);
  sandbox.exports = {};
  vm.runInContext(transpile("../src/actions/open-agent.ts"), sandbox);

  const action = new sandbox.exports.OpenAgentAction();
  await assert.doesNotReject(action.run());
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
});

test("添加到聊天：打开面板并把节点入队，无 id 时提示且不入队", () => {
  const global = { activeRightTab: undefined, setActiveRightTab: value => (global.activeRightTab = value) };
  const notifications = [];
  const enqueued = [];
  const sandbox = {
    console,
    Error,
    Promise,
    JSON,
    Object,
    window: { app: { global } },
    require: name => {
      if (name === "../host/runtime") {
        return {
          Action: class {},
          notify: options => notifications.push(options)
        };
      }
      if (name === "../host/lifecycle") return { pluginActive: { value: true } };
      if (name === "./open-agent") return { setAgentPanelActive: active => global.setActiveRightTab(active ? "aiAssistant" : undefined) };
      if (name === "../presentation/chat-context") return { enqueueChatMention: mention => enqueued.push(mention) };
      return {};
    }
  };
  vm.createContext(sandbox);

  sandbox.exports = {};
  vm.runInContext(transpile("../src/actions/add-to-chat.ts"), sandbox);
  const action = new sandbox.exports.AddToChatAction();

  action.onTreeMenuClick({ id: "m-1", data: { id: "m-1", name: "车", metaclass: "Block" } });
  assert.equal(global.activeRightTab, "aiAssistant");
  assert.deepEqual(enqueued, [{ id: "m-1", title: "车", type: "Block" }]);

  // 根节点等没有 id 的节点：提示而不入队
  action.onTreeMenuClick({ data: { name: "根" } });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "warning");
  assert.equal(enqueued.length, 1);
});
