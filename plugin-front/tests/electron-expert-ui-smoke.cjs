// Production Vue rendering with deterministic team data; no real model requests.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 860,
    height: 760,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  });
  const read = expression => win.webContents.executeJavaScript(expression);
  const update = expression => read(`(async () => { ${expression}; await window.api.vue.nextTick(); })()`);
  try {
    await win.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?desktop&productionVue");
    await read(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 10000;
      function ready() {
        if (window.api?.vue && document.querySelector('.ai-panel')) return resolve();
        if (Date.now() > deadline) return reject(new Error('助手预览未就绪'));
        requestAnimationFrame(ready);
      }
      ready();
    })`);
    await read(`(async () => {
      const Vue = window.api.vue;
      const { default: Progress } = await import('/src/components/panels/aiAssistant/ExpertTeamProgress.vue');
      document.querySelector('#shell').style.display = 'none';
      const root = document.createElement('main');
      root.id = 'team-preview';
      root.style.cssText = 'width:680px;margin:32px auto;padding:16px;box-sizing:border-box;background:white;font-family:Segoe UI,Microsoft YaHei,sans-serif';
      document.body.append(root);
      const member = (id, role, task, status, extra = {}) => ({ id, role, task, status, toolCalls: [], ...extra });
      window.teamFixture = Vue.reactive({ id:'team', profileId:'test', model:'test-model', permissionMode:'proposal', status:'running', members:[
        member('lead','lead','分析电脑系统需求，安排专家分工','completed',{result:'已安排需求、语义与布局分析。'}),
        member('req','requirements','梳理处理器、存储器与外设之间的约束','completed',{result:'处理器与内存均为电脑系统的组成部分。'}),
        member('sem','semantics','核对部件类型、多重性和组合关系方向','running',{ toolCalls:[{id:'t1',name:'model_get_element',state:'running',input:{elementId:'real-id'}}] }),
        member('layout','layout','规划模块定义图的分组与连线路径','running'),
        member('check','checker','检查专家建议与实际模型是否一致','queued'),
        member('unused','requirements','本轮无需调用','not-called')
      ] });
      Vue.createApp({ render: () => Vue.h(Progress, { team: window.teamFixture }) }).mount(root);
      await Vue.nextTick();
    })()`);
    assert.equal(await read(`(async () => {
      const background = document.querySelector('.builtin-avatar').style.backgroundImage;
      const source = background.slice(5, -2);
      const resolved = new URL(source, 'app://./index.html');
      if (resolved.protocol === 'app:') return false;
      const image = new Image();
      image.src = resolved.href;
      await image.decode();
      return image.naturalWidth > 0;
    })()`), true, "avatars must load when embedded in the app:// host");
    assert.equal(await read("document.querySelector('.team-progress').open"), true);
    assert.equal(await read("document.querySelectorAll('.team-progress__member').length"), 5);
    assert.equal(await read("document.querySelectorAll('.team-progress__member[open]').length"), 0);
    assert.equal(await read("document.querySelector('.team-progress__count').textContent.includes('2 项进行中')"), true);
    assert.equal(await read("document.querySelector('.team-progress__unused').open"), false);
    assert.equal(
      await read("Array.from(document.querySelectorAll('.team-progress__heading')).every(row => row.getBoundingClientRect().height <= 72)"),
      true
    );
    const output = process.env.AGENT_UI_SCREENSHOTS || path.join(app.getPath("temp"), "agent-expert-ui");
    fs.mkdirSync(output, { recursive: true });
    async function capture(name) {
      await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))");
      await new Promise(resolve => setTimeout(resolve, 120));
      fs.writeFileSync(path.join(output, name + ".png"), (await win.webContents.capturePage()).toPNG());
    }
    await capture("running");
    await read("document.querySelectorAll('.team-progress__heading')[2].focus()");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await read("document.querySelectorAll('.team-progress__member')[2].open"), true);
    assert.equal(await read("document.querySelectorAll('.team-progress__member')[2].textContent.includes('查看元素')"), true);
    await update(
      "teamFixture.members[2].status='error'; teamFixture.members[2].error='模型元素已删除，无法继续检查'; teamFixture.members[2].toolCalls[0].state='error'; teamFixture.members[2].toolCalls[0].error='找不到元素'; teamFixture.status='error'"
    );
    assert.equal(await read("document.querySelector('.team-progress__inline-error').textContent.includes('模型元素已删除')"), true);
    assert.equal(await read("document.querySelectorAll('.team-progress__member')[2].open"), true);
    await update("document.querySelector('#team-preview').style.width='320px'");
    assert.equal(
      await read("document.querySelector('#team-preview').scrollWidth <= document.querySelector('#team-preview').clientWidth"),
      true
    );
    await capture("narrow-error");
    await update("teamFixture.status='waiting-approval'");
    assert.equal(await read("document.querySelector('.team-progress__summary-state').textContent"), "等待确认提案");
    await update("teamFixture.members=teamFixture.members.slice(1,2); teamFixture.status='completed'");
    assert.equal(await read("document.querySelectorAll('.team-progress__member').length"), 1);
    assert.equal(await read("document.querySelector('.team-progress__summary-state').textContent"), "协作完成");
    assert.equal(await read("document.querySelector('.team-progress').open"), false, "完成后自动收起成员列表");
    await read("document.querySelector('.team-progress__summary').click()");
    assert.equal(await read("document.querySelector('.team-progress').open"), true, "完成后仍可手动展开详情");
    await update("teamFixture.members[0].result='补充结果'");
    assert.equal(await read("document.querySelector('.team-progress').open"), true, "结果更新不覆盖手动展开状态");
    await update("document.querySelector('.team-progress').open=false; teamFixture.members[0].result='更新后的真实结果'");
    assert.equal(await read("document.querySelector('.team-progress').open"), false);
    console.log("PASS: compact members, keyboard details, live errors, 320px width, approval and single-member states");
    console.log("Screenshots: " + output);
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
