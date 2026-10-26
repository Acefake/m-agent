// 先启动插件 Vite，再用客户端的 Electron 运行此文件；仅渲染固定消息，不调用模型服务。
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 960, height: 540, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(message);
  });
  try {
    await win.loadURL("http://127.0.0.1:8889/tests/ui/message-states.html");
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      function ready() {
        if (document.querySelector('.trace')) return resolve();
        if (Date.now() > deadline) return reject(new Error('消息预览未就绪'));
        requestAnimationFrame(ready);
      }
      ready();
    })`);
    await win.webContents.executeJavaScript(`(async () => {
      const Vue = window.api.vue;
      const { default: MessageItem } = await import('/src/components/panels/aiAssistant/MessageItem.vue');
      document.querySelector('#app').style.display = 'none';
      document.body.style.background = '#fff';
      const root = document.createElement('main');
      root.id = 'compact-preview';
      root.style.cssText = 'padding:24px;box-sizing:border-box;width:100%;';
      document.body.append(root);
      const calls = Array.from({ length: 6 }, (_, index) => ({
        id: 'tool-' + index,
        name: index === 0 ? 'diagram_list' : 'diagram_read_shapes',
        input: { diagramId: 'diagram-' + index },
        state: index === 4 ? 'error' : index === 5 ? 'running' : 'done',
        output: index < 4 ? '已读取图表内容' : undefined,
        error: index === 4 ? '图表不可用' : undefined
      }));
      window.compactState = Vue.reactive({
        streaming: true,
        message: { id: 'compact', role: 'assistant', content: '', createdAt: Date.now() - 22000,
          toolCalls: calls, steps: [{ kind: 'reasoning', text: '确认图表范围后读取结构。' },
            { kind: 'text', text: '先检查图表。' }, ...calls.map(call => ({ kind: 'tool', id: call.id })), { kind: 'text', text: '已整理结果。' }] }
      });
      Vue.createApp({ render: () => Vue.h(MessageItem, window.compactState) }).mount(root);
      await Vue.nextTick();
    })()`);
    const read = expression => win.webContents.executeJavaScript(expression);
    const nextFrame = () => read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await read("window.compactState.message.skillNames = ['sysml-modeling']; undefined");
    await nextFrame();
    assert.match(await read("document.querySelector('#compact-preview .trace__skill').textContent"), /加载技能 sysml-modeling/);
    assert.equal(await read("getComputedStyle(document.querySelector('#compact-preview .trace__skill')).display"), "none", "加载技能默认收起");
    await read("document.querySelector('#compact-preview .trace__row--summary').click()");
    await nextFrame();
    assert.notEqual(await read("getComputedStyle(document.querySelector('#compact-preview .trace__skill')).display"), "none", "展开过程后可查看加载的技能");
    await read("document.querySelector('#compact-preview .trace__row--summary').click()");
    await nextFrame();
    await read(
      "window.originalCompactMessage = window.compactState.message; window.compactState.message = { id: 'waiting', role: 'assistant', content: '', toolCalls: [], createdAt: Date.now() }"
    );
    await nextFrame();
    assert.doesNotMatch(await read("document.querySelector('#compact-preview').textContent"), /思考中/, "等待首个输出时仅显示工作状态");
    assert.match(await read("document.querySelector('#compact-preview .trace__row--summary').textContent"), /工作中/);
    await read("window.compactState.streaming = false");
    await nextFrame();
    assert.doesNotMatch(await read("document.querySelector('#compact-preview').textContent"), /思考中|工作中/, "停止后清除等待状态");
    await read(
      "window.compactState.streaming = true; window.compactState.message.content = '正在检查模型'; window.compactState.message.steps = [{kind:'text',text:'正在检查模型'}]"
    );
    await nextFrame();
    assert.doesNotMatch(await read("document.querySelector('#compact-preview').textContent"), /思考中/, "正文先到达时移除等待提示");
    await read("window.compactState.message = window.originalCompactMessage; undefined");
    await nextFrame();
    assert.equal(
      await read("Boolean(document.querySelector('#compact-preview .trace__waiting'))"),
      false,
      "实际过程到达后不重复显示等待提示"
    );
    assert.match(await read("document.querySelector('#compact-preview .trace__row--summary').textContent"), /工作中/);
    assert.match(await read("document.querySelector('#compact-preview .trace__row--summary').textContent"), /1 项失败/);
    assert.equal(await read("document.querySelectorAll('#compact-preview .trace__item').length"), 0, "运行过程默认收起");
    assert.equal(await read("document.querySelectorAll('#compact-preview .turn__md').length"), 0, "收起时不展示中间说明");
    await read("document.querySelector('#compact-preview .trace__row--summary').click()");
    await nextFrame();
    assert.equal(await read("document.querySelectorAll('#compact-preview .trace__item').length"), 7);
    assert.match(await read("document.querySelector('#compact-preview .is-running').textContent"), /执行中/);
    assert.equal(
      await read("Boolean(document.querySelector('#compact-preview .trace__detail, #compact-preview .trace__reasoning'))"),
      false
    );
    assert.equal(await read("document.querySelector('#compact-preview .turn__stage').textContent.includes('先检查图表。')"), true);
    assert.equal(await read("document.querySelectorAll('#compact-preview .turn__stage')[1].textContent.includes('已整理结果。')"), true);
    for (const width of [960, 380]) {
      win.setSize(width, 540);
      await nextFrame();
      assert.equal(await read("document.documentElement.scrollWidth <= innerWidth"), true, "摘要不应撑宽窄窗口");
      if (process.env.AGENT_UI_SCREENSHOTS) {
        fs.mkdirSync(process.env.AGENT_UI_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(
          path.join(process.env.AGENT_UI_SCREENSHOTS, `process-${width}.png`),
          (await win.webContents.capturePage()).toPNG()
        );
      }
    }
    await nextFrame();
    assert.equal(await read("document.querySelectorAll('#compact-preview .trace__item').length"), 7, "展开后保留思考与全部调用");
    await read("document.querySelectorAll('#compact-preview .trace__items .trace__label')[5].click()");
    await nextFrame();
    assert.match(await read("document.querySelector('#compact-preview .trace__detail').textContent"), /图表不可用/);
    await read("window.compactState.message.team = { id:'team', status:'running', members:[{ id:'lead', role:'lead', task:'统一交付', status:'running', toolCalls:window.compactState.message.toolCalls }] }; undefined");
    await nextFrame();
    assert.equal(await read("Boolean(document.querySelector('#compact-preview .trace__items'))"), false, "专家团不重复展示主对话工具过程");
    assert.equal(await read("Boolean(document.querySelector('#compact-preview .turn__md'))"), false, "专家团运行时不展示交付中间说明");
    await read("window.compactState.streaming = false; window.compactState.message.team.status = 'completed'");
    await nextFrame();
    assert.equal(await read("document.querySelectorAll('#compact-preview .turn__md').length"), 1);
    assert.match(await read("document.querySelector('#compact-preview .turn__md').textContent"), /已整理结果。/);
    await read("delete window.compactState.message.team; window.compactState.streaming = true");
    await nextFrame();
    await read("window.compactState.streaming = false");
    await nextFrame();
    assert.equal(await read("Boolean(document.querySelector('#compact-preview .trace__current'))"), false);
    assert.equal(
      await read("document.querySelector('#compact-preview .trace__row--summary').getAttribute('aria-expanded')"),
      "false",
      "完成时自动收起过程"
    );
    assert.equal(await read("Boolean(document.querySelector('#compact-preview .trace__items'))"), false);
    assert.doesNotMatch(await read("document.querySelector('#compact-preview').textContent"), /先检查图表。/);
    assert.match(await read("document.querySelector('#compact-preview').textContent"), /已整理结果。/);
    await read("document.querySelector('#compact-preview .trace__row--summary').click()");
    await nextFrame();
    assert.equal(await read("Boolean(document.querySelector('#compact-preview .trace__items'))"), true);
    assert.match(await read("document.querySelector('#compact-preview').textContent"), /先检查图表。/);
    assert.match(await read("document.querySelector('#compact-preview .trace__row--summary').textContent"), /1 项失败/);
    console.log("PASS: 过程按正文阶段展示、详情默认收起、运行与失败状态、展开详情和窄窗口布局");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});

