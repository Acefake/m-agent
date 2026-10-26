// 用 Electron 22 和真实宿主 IpcWindow 类验证跨渲染进程同步；模型服务为模拟实现。
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
async function screenshot(win, name) {
  if (!process.env.AGENT_UI_SCREENSHOTS) return;
  await win.webContents.executeJavaScript(`Promise.all(document.getAnimations()
    .filter(animation => animation.effect.getTiming().iterations !== Infinity)
    .map(animation => animation.finished.then(() => undefined, () => undefined)))`);
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  // 隐藏窗口的合成器晚于 DOM 更新提交画面，等待一次绘制再捕获。
  await new Promise(resolve => setTimeout(resolve, 120));
  fs.mkdirSync(process.env.AGENT_UI_SCREENSHOTS, { recursive: true });
  fs.writeFileSync(path.join(process.env.AGENT_UI_SCREENSHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function waitFor(win, expression) {
  for (let n = 0; n < 150; n++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("等待界面超时：" + expression);
}
async function clickMode(win, label) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const button = Array.from(document.querySelectorAll('.ai-popover--mode button')).find(item => item.textContent.includes(${JSON.stringify(label)}));
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    return { x: Math.round(x), y: Math.round(y), hit: button.contains(document.elementFromPoint(x, y)) };
  })()`);
  assert.equal(point.hit, true, "模式菜单必须能被鼠标点到");
  win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
}
async function checkModes(win) {
  for (const label of ["聊天模式", "提案模式", "编辑模式"]) {
    await win.webContents.executeJavaScript("document.querySelector('.ai-composer__chip--mode').click()", true);
    await waitFor(win, "Boolean(document.querySelector('.ai-popover--mode'))");
    await win.webContents.executeJavaScript(
      "Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.then(() => undefined)))"
    );
    await clickMode(win, label);
    await waitFor(win, `document.querySelector('.ai-composer__chip--mode').textContent.includes(${JSON.stringify(label)})`);
  }
}
app.whenReady().then(async () => {
  const owner = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  owner.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.log("owner:", message);
  });
  let child;
  ipcMain.on("OpenWindow", async (_event, { windowName, query }) => {
    child = new BrowserWindow({
      show: false,
      parent: owner,
      width: 1120,
      height: 900,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
    });
    child.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) console.log("child:", message);
    });
    child.on("closed", () => {
      if (!owner.isDestroyed() && owner.webContents && !owner.webContents.isDestroyed())
        owner.webContents.send("WindowClose", { windowName });
    });
    await child.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?desktop&productionVue&assistantWindow=" + query.sessionId);
  });
  ipcMain.on("WindowClose", () => child?.close());
  ipcMain.on("ManulCloseWindow", () => child?.close());
  try {
    await owner.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?desktop&productionVue&slow");
    await waitFor(owner, "Boolean(document.querySelector('.ai-panel__presentation'))");
    await checkModes(owner);
    await screenshot(owner, "assistant-docked");
    await owner.webContents.executeJavaScript(
      "(async () => { document.querySelector('.composer-add__trigger').click(); await window.api.vue.nextTick(); document.querySelectorAll('.composer-add__nav button')[2].click(); })()",
      true
    );
    await waitFor(owner, "Boolean(document.querySelector('.composer-add__submenu'))");
    assert.equal(
      await owner.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('.composer-add__popup').getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= document.querySelector('.ai-panel__chat').getBoundingClientRect().top && box.bottom <= innerHeight;
    })()`),
      true,
      "窄面板菜单不应超出窗口"
    );
    await screenshot(owner, "add-skills-docked");
    await owner.webContents.executeJavaScript("document.querySelector('.composer-add__mask').click()", true);
    await waitFor(owner, "!document.querySelector('.composer-add__popup')");

    await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__quick button').click()", true);
    await waitFor(owner, "document.querySelector('.ai-composer__input').textContent.includes('模块定义图')");
    assert.equal(await owner.webContents.executeJavaScript("Boolean(document.querySelector('.ai-welcome'))"), true);
    const source = fs.readFileSync(path.resolve(__dirname, "../../../../m-design-client/src/util/IpcWindow/IpcWindow.ts"), "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
    }).outputText;
    await owner.webContents.executeJavaScript(
      `(() => {
      const module = { exports: {} };
      const mocks = {
        '@electron/remote': {default:{getCurrentWindow:()=>({focus(){}})}},
        '@/../electron/appInstance/enums': {IpcMsg:{OpenWindow:'OpenWindow',WindowClose:'WindowClose',WindowChange:'WindowChange',ManulCloseWindow:'ManulCloseWindow'}},
        '@/constants/envConfig': {isElectron:true}, electron: window.require('electron')
      };
      new Function('require','module','exports',${JSON.stringify(code)})(name=>mocks[name]||{},module,module.exports);
      window.api.IpcWindow = module.exports.IpcWindow;
    })()`,
      true
    );
    await owner.webContents.executeJavaScript(
      `(async () => {
      const { useAiAssistantStore } = await import('/src/ai-assistant/conversation/store.ts?agentRevision=' + window.__AGENT_DEV_REVISION__);
      const store = useAiAssistantStore();
      window.__conversationA = store.createConversation().id;
      store.conversations.find(item => item.id === window.__conversationA).messages = [{id:'a-user',role:'user',content:'会话A',toolCalls:[],createdAt:Date.now()},
        {id:'a-reply',role:'assistant',content:'会话A独有回复',toolCalls:[],createdAt:Date.now()}];
      window.__conversationB = store.createConversation().id;
      store.conversations.find(item => item.id === window.__conversationB).messages = [{id:'b-user',role:'user',content:'会话B',toolCalls:[],createdAt:Date.now()},
        {id:'b-reply',role:'assistant',content:'会话B独有回复',toolCalls:[],createdAt:Date.now()}];
      store.persistConversations();
      window.__ownerStore = store;
    })()`,
      true
    );
    await waitFor(owner, "document.body.innerText.includes('会话B独有回复')");
    await owner.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('.ai-composer__input');
      input.textContent = 'ipc-draft'; input.dispatchEvent(new Event('input',{bubbles:true}));
      window.__originalAgentInput = input;
      document.querySelector('.ai-panel__presentation').click();
    })()`,
      true
    );
    await waitFor(owner, "window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    assert.ok(child && child !== owner);
    await checkModes(child);
    await waitFor(child, "document.querySelector('.ai-composer__input')?.textContent === 'ipc-draft'");
    await child.webContents.executeJavaScript(
      "(async () => { document.querySelector('.composer-add__trigger').click(); await window.api.vue.nextTick(); document.querySelectorAll('.composer-add__nav button')[2].click(); })()",
      true
    );
    await waitFor(child, "Boolean(document.querySelector('[aria-label=\"搜索技能\"]'))");
    await child.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('[aria-label="搜索技能"]');
      input.value = 'not-a-skill'; input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`,
      true
    );
    await waitFor(child, "document.querySelector('.composer-add__empty')?.textContent.includes('没有匹配')");
    await child.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('[aria-label="搜索技能"]');
      input.value = 'sysml'; input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`,
      true
    );
    await waitFor(child, "document.querySelectorAll('.composer-add__item').length === 1");
    await screenshot(child, "add-skills");
    await child.webContents.executeJavaScript("document.querySelector('.composer-add__item').click()", true);
    await waitFor(child, "Boolean(document.querySelector('.ai-composer__input [data-skill-name=\"sysml-modeling\"]'))");
    assert.equal(
      await child.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent.includes('ipc-draft')"),
      true
    );
    await child.webContents.executeJavaScript(
      "(async () => { document.querySelector('.composer-add__trigger').click(); await window.api.vue.nextTick(); document.querySelectorAll('.composer-add__nav button')[1].click(); })()",
      true
    );
    await waitFor(child, "document.querySelectorAll('.composer-add__item').length === 7");
    await screenshot(child, "add-experts");
    await child.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.composer-add__item')).find(button => button.textContent.includes('SysML 专家团')).click()",
      true
    );
    await waitFor(child, "Boolean(document.querySelector('.team-selector__remove'))");
    assert.equal(await child.webContents.executeJavaScript("document.querySelectorAll('.team-selector button').length"), 1);
    assert.equal(await child.webContents.executeJavaScript("Boolean(document.querySelector('.team-selector .ai-select'))"), false);

    await waitFor(
      owner,
      "window.__ownerStore.conversations.find(item => item.id === window.__ownerStore.activeConversationId)?.strategy === 'sysml-team'"
    );
    await child.webContents.executeJavaScript(
      "(async () => { document.querySelector('.composer-add__trigger').click(); await window.api.vue.nextTick(); document.querySelectorAll('.composer-add__nav button')[1].click(); })()",
      true
    );
    await waitFor(child, "Boolean(document.querySelector('.composer-add__item'))");
    await child.webContents.executeJavaScript(
      "document.querySelector('.composer-add__mask').click(); document.querySelector('.team-selector__remove').click()",
      true
    );
    await waitFor(child, "!document.querySelector('.team-selector')");

    await child.webContents.executeJavaScript(
      "document.querySelector('.composer-add__trigger').click(); document.querySelector('.composer-add__trigger').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
      true
    );
    await waitFor(child, "!document.querySelector('.composer-add__popup')");

    await child.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('.ai-composer__input');
      input.textContent='ipc-draft-edited'; input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('.ai-panel__presentation').click();
    })()`,
      true
    );
    await waitFor(owner, "!window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    assert.equal(
      await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent"),
      "ipc-draft-edited"
    );
    assert.equal(
      await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__input') === window.__originalAgentInput"),
      true
    );
    await owner.webContents.executeJavaScript("document.querySelector('.ai-conversations__select[title=\"会话A\"]').click()", true);
    await waitFor(owner, "document.body.innerText.includes('会话A独有回复') && !document.body.innerText.includes('会话B独有回复')");
    assert.equal(await owner.webContents.executeJavaScript("window.__ownerStore.activeConversationId === window.__conversationA"), true);
    await owner.webContents.executeJavaScript("document.querySelector('.ai-conversations__select[title=\"会话B\"]').click()", true);
    await waitFor(owner, "document.body.innerText.includes('会话B独有回复') && !document.body.innerText.includes('会话A独有回复')");
    await owner.webContents.executeJavaScript(
      "document.querySelector('.ai-composer__submit').click(); document.querySelector('.ai-panel__presentation').click()",
      true
    );
    await waitFor(owner, "window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    await waitFor(child, "document.body.innerText.includes('工作中')");
    child.close();
    await waitFor(owner, "!window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    await waitFor(owner, "window.__ownerStore.messages.some(message => message.content.includes('模拟回复结束'))");
    assert.equal(await owner.webContents.executeJavaScript("document.querySelector('#log').textContent.includes('abort')"), false);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(await owner.webContents.executeJavaScript("localStorage.getItem('agent.assistant.presentation')"), "window");
    await owner.webContents.executeJavaScript(
      "import('/src/presentation/panel').then(module => { if (module.assistantPresentation() === 'panel') module.hostGlobal().setActiveRightTab(module.PANEL_VALUE); module.requestAssistantPresentation(); })",
      true
    );
    await waitFor(owner, "window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    await waitFor(child, "Boolean(document.querySelector('.ai-panel__presentation'))");
    await child.webContents.executeJavaScript("document.querySelector('.ai-panel__presentation').click()", true);
    await waitFor(owner, "!window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    assert.equal(await owner.webContents.executeJavaScript("localStorage.getItem('agent.assistant.presentation')"), "panel");
    await owner.webContents.executeJavaScript(
      "import('/src/presentation/panel').then(module => { if (module.assistantPresentation() === 'panel') module.hostGlobal().setActiveRightTab(module.PANEL_VALUE); module.requestAssistantPresentation(); })",
      true
    );
    assert.equal(BrowserWindow.getAllWindows().length, 1);

    await owner.webContents.executeJavaScript(
      `(() => {
      window.__ownerStore.createConversation();
      const input = document.querySelector('.ai-composer__input');
      input.replaceChildren(); input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('.ai-panel__presentation').click();
    })()`,
      true
    );
    await waitFor(child, "Boolean(document.querySelector('.ai-welcome__title'))");
    assert.equal(
      await child.webContents.executeJavaScript("document.querySelector('.ai-panel').getBoundingClientRect().height > 400"),
      true
    );
    await screenshot(child, "assistant-window");
    assert.equal(
      await child.webContents.executeJavaScript("Boolean(document.querySelector('.team-selector'))"),
      false,
      "默认助手不显示底部选择器"
    );

    await child.webContents.executeJavaScript("document.querySelector('.ai-composer__model').click()", true);
    await waitFor(child, "Boolean(document.querySelector('.ai-popover--model'))");
    assert.equal(
      await child.webContents.executeJavaScript(`(() => {
      const box = document.querySelector('.ai-popover--model').getBoundingClientRect();
      return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0;
    })()`),
      true
    );
    await child.webContents.executeJavaScript("document.querySelector('.ai-popover-mask').click()", true);
    await child.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.ai-conversations__navigation button')).find(button => button.textContent.includes('专家与技能')).click()",
      true
    );
    await waitFor(child, "document.querySelectorAll('.expert-center__card').length === 5");
    await screenshot(child, "experts-page");
    await child.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('[aria-label="搜索专家"]');
      input.value = '语义'; input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`,
      true
    );
    await waitFor(child, "document.querySelectorAll('.expert-center__card').length === 1");
    await child.webContents.executeJavaScript("document.querySelectorAll('.expert-center__categories button')[1].click()", true);
    await waitFor(child, "Boolean(document.querySelector('.expert-center__enable'))");
    await screenshot(child, "expert-team-page");
    await child.webContents.executeJavaScript("document.querySelector('.expert-center__enable').click()", true);
    await waitFor(child, "document.querySelector('.team-selector')?.textContent.includes('SysML 专家团')");
    await waitFor(
      owner,
      "window.__ownerStore.conversations.find(item => item.id === window.__ownerStore.activeConversationId)?.strategy === 'sysml-team'"
    );
    await owner.webContents.executeJavaScript("window.__fastMock = true; window.__ownerStore.sendMessage('分析电脑系统BDD方案');", true);
    await waitFor(child, "Boolean(document.querySelector('.team-progress')) && document.body.innerText.includes('协作完成')");
    assert.equal(
      await child.webContents.executeJavaScript(`(() => {
      const stats = document.querySelector('.session-statistics').getBoundingClientRect();
      const metaElement = document.querySelector('.ai-composer__meta');
      const meta = metaElement.getBoundingClientRect();
      const effort = document.querySelector('.ai-composer__effort').getBoundingClientRect();
      const style = getComputedStyle(metaElement);
      const right = effort.top < stats.bottom && effort.bottom > stats.top
        ? effort.left - parseFloat(style.columnGap)
        : meta.right - parseFloat(style.paddingRight);
      return Boolean(metaElement.querySelector('.session-statistics')) && Math.abs(stats.right - right) < 2 && stats.top >= meta.top && stats.bottom <= meta.bottom;
    })()`),
      true,
      "统计入口位于输入框底栏右侧"
    );
    await child.webContents.executeJavaScript("document.querySelector('.team-progress').open = true", true);
    await waitFor(child, "document.querySelectorAll('.team-progress__member').length === 6");
    assert.equal(
      await child.webContents.executeJavaScript(`(() => {
      const team = document.querySelector('.team-progress');
      const summary = team.closest('.turn__body').querySelector('.trace__row--summary');
      return summary.getBoundingClientRect().bottom <= team.getBoundingClientRect().top;
    })()`),
      true,
      "专家团显示在执行状态下方"
    );
    await child.webContents.executeJavaScript(
      "document.querySelector('.team-progress').closest('.turn__body').querySelector('.trace__row--summary').click()",
      true
    );
    await waitFor(child, "getComputedStyle(document.querySelector('.team-progress')).display === 'none'");
    await child.webContents.executeJavaScript(
      "document.querySelector('.team-progress').closest('.turn__body').querySelector('.trace__row--summary').click()",
      true
    );
    await waitFor(child, "getComputedStyle(document.querySelector('.team-progress')).display !== 'none'");
    await screenshot(child, "expert-team-progress");
    assert.equal(
      await owner.webContents.executeJavaScript(
        "window.__ownerStore.messages.at(-1).team.members.filter(member => member.status === 'completed').length"
      ),
      6
    );
    await child.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.ai-conversations__navigation button')).find(button => button.textContent.includes('专家与技能')).click()",
      true
    );
    await waitFor(child, "Boolean(document.querySelector('.ai-library-tabs'))");
    await child.webContents.executeJavaScript("document.querySelectorAll('.ai-library-tabs button')[1].click()", true);
    await waitFor(child, "Boolean(document.querySelector('[aria-label=\"AI 助手设置\"]'))");
    assert.equal(
      await child.webContents.executeJavaScript(
        "Array.from(document.querySelectorAll('.ai-settings-mask, .ai-conversations__footer, .ai-panel__actions')).some(element => element.getClientRects().length > 0)"
      ),
      false
    );
    await waitFor(child, "Boolean(document.querySelector('.ai-skill__main'))");
    await screenshot(child, "skills-page");
    await child.webContents.executeJavaScript("document.querySelector('.ai-skill__main').click()", true);
    await waitFor(child, "Boolean(document.querySelector('.skill-detail__content'))");
    await screenshot(child, "skill-detail");
    await child.webContents.executeJavaScript("document.querySelector('.ai-section__back').click()", true);
    await waitFor(child, "Boolean(document.querySelector('.skill-toolbar'))");
    await child.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('[aria-label="搜索技能"]');
      input.value = 'missing-skill-123'; input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`,
      true
    );
    await waitFor(child, "document.querySelector('.ai-dialog__empty')?.textContent.includes('没有匹配')");
    await child.webContents.executeJavaScript("document.querySelector('.skill-toolbar .ai-btn').click()", true);
    await waitFor(child, "Boolean(document.querySelector('.ai-composer__input [data-skill-name=skill-creator]'))");
    assert.equal(await child.webContents.executeJavaScript("Boolean(document.querySelector('.ai-settings'))"), false);
    assert.equal(
      await child.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent.includes('请帮我创建')"),
      true
    );
    assert.equal(await child.webContents.executeJavaScript("Boolean(document.querySelector('.ai-welcome'))"), true);
    await waitFor(child, "document.querySelector('.ai-composer__submit')?.disabled === false");
    await screenshot(child, "skill-creator-chat");
    await child.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.ai-conversations__navigation button')).find(button => button.textContent.includes('专家与技能')).click()",
      true
    );
    await child.webContents.executeJavaScript("document.querySelectorAll('.ai-library-tabs button')[0].click()", true);
    await waitFor(child, "Boolean(document.querySelector('.expert-center__toolbar'))");
    await child.webContents.executeJavaScript("document.querySelector('.expert-center__create').click()", true);
    await waitFor(child, "Boolean(document.querySelector('.ai-composer__input [data-skill-name=expert-manager]'))");
    await waitFor(child, "document.querySelector('.ai-composer__submit')?.disabled === false");
    assert.equal(
      await child.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent.includes('行业背景、相关经验')"),
      true
    );
    await child.webContents.executeJavaScript(
      `(() => {
      const input = document.querySelector('.ai-composer__input');
      input.innerHTML = input.innerHTML;
      input.querySelector('.ai-mention-token--skill .ai-mention-token__remove').click();
    })()`,
      true
    );
    await waitFor(child, "!document.querySelector('.ai-composer__input [data-skill-name=expert-manager]')");
    assert.equal(
      await child.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent.includes('行业背景、相关经验')"),
      true
    );

    assert.equal(await child.webContents.executeJavaScript("Boolean(document.querySelector('.ai-welcome'))"), true);

    await child.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.ai-conversations__navigation button')).find(button => button.textContent.includes('模型与供应商')).click()",
      true
    );
    await waitFor(child, "document.querySelector('.ai-section__title')?.textContent === '供应商'");
    await screenshot(child, "providers-page");
    await child.webContents.executeJavaScript("document.querySelector('.ai-conversations__new').click()", true);
    await waitFor(child, "!document.querySelector('.ai-settings')");
    await child.webContents.executeJavaScript("document.querySelectorAll('.ai-welcome__modes button')[1].click()", true);
    await waitFor(child, "document.querySelector('.ai-starters').textContent.includes('需求层次')");
    await child.webContents.executeJavaScript("document.querySelector('.ai-starters button').click()", true);
    await waitFor(child, "document.querySelector('.ai-composer__input').textContent.includes('需求层次')");
    assert.equal(
      await child.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.ai-panel');
      return panel.scrollWidth <= panel.clientWidth;
    })()`),
      true
    );
    await child.webContents.executeJavaScript("document.querySelector('.ai-panel__presentation').click()", true);
    await waitFor(owner, "!window.__originalAgentInput.closest('.ai-assistant-frame').classList.contains('is-detached')");
    assert.equal(
      await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent.includes('需求层次')"),
      true
    );
    await owner.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('.ai-conversations__navigation button')).find(button => button.textContent.includes('专家与技能')).click()",
      true
    );
    await waitFor(owner, "Boolean(document.querySelector('.expert-center__grid'))");
    await screenshot(owner, "experts-docked");
    await owner.webContents.executeJavaScript("document.querySelectorAll('.ai-library-tabs button')[1].click()", true);
    await waitFor(owner, "Boolean(document.querySelector('.ai-skill-list'))");
    await screenshot(owner, "skills-docked");
    assert.equal(
      await owner.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.ai-panel');
      const content = document.querySelector('.ai-section__body');
      return panel.scrollWidth <= panel.clientWidth && content.scrollWidth <= content.clientWidth;
    })()`),
      true
    );
    // 真实渲染验证：切换草稿、并行任务及当前会话停止。
    await owner.webContents.executeJavaScript("document.querySelector('.ai-conversations__new').click()", true);
    await waitFor(owner, "Boolean(document.querySelector('.ai-composer__input'))");
    await owner.webContents.executeJavaScript(
      `(() => {
      window.__isolationA = window.__ownerStore.activeConversationId;
      const input = document.querySelector('.ai-composer__input');
      input.textContent = 'A 的独立草稿'; input.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('.ai-conversations__new').click();
    })()`,
      true
    );
    await waitFor(owner, "document.querySelector('.ai-composer__input').textContent === ''");
    await owner.webContents.executeJavaScript(
      `(() => {
      window.__isolationB = window.__ownerStore.activeConversationId;
      const input = document.querySelector('.ai-composer__input');
      input.textContent = 'B 的独立草稿'; input.dispatchEvent(new Event('input', {bubbles:true}));
      window.__ownerStore.selectConversation(window.__isolationA);
    })()`,
      true
    );
    await waitFor(owner, "document.querySelector('.ai-composer__input').textContent === 'A 的独立草稿'");
    await owner.webContents.executeJavaScript(
      `(() => {
      window.__fastMock = false;
      void window.__ownerStore.sendMessage('独立任务 A');
      window.__ownerStore.selectConversation(window.__isolationB);
      void window.__ownerStore.sendMessage('独立任务 B');
    })()`,
      true
    );
    await waitFor(owner, "window.__ownerStore.runningConversationIds.length === 2");
    assert.equal(await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__input').textContent"), "B 的独立草稿");
    await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__submit[aria-label=停止]').click()", true);
    await waitFor(owner, "!window.__ownerStore.isRunning");
    assert.equal(
      await owner.webContents.executeJavaScript("window.__ownerStore.runningConversationIds.includes(window.__isolationA)"),
      true
    );
    await owner.webContents.executeJavaScript("window.__ownerStore.selectConversation(window.__isolationA); undefined", true);
    await waitFor(owner, "Boolean(document.querySelector('.ai-composer__submit[aria-label=停止]'))");
    await owner.webContents.executeJavaScript("document.querySelector('.ai-composer__submit[aria-label=停止]').click()", true);
    await waitFor(owner, "window.__ownerStore.runningConversationIds.length === 0");
    console.log("PASS: independent drafts, concurrent conversations, stop only current conversation");
    console.log("PASS: real IpcWindow, cross-renderer draft sync, docking, native close, Agent continuity");
    owner.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (!owner.isDestroyed())
      console.error(
        await owner.webContents.executeJavaScript(
          "JSON.stringify({error:window.__ownerStore?.errorMessage,team:window.__ownerStore?.messages.at(-1)?.team,log:document.querySelector('#log')?.textContent})"
        )
      );
    owner.destroy();
    app.exit(1);
  }
});
