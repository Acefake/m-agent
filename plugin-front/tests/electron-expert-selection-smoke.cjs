// Real Electron/Vue interaction with an isolated host fixture and a fake provider.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const output = process.env.AGENT_EXPERT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), "agent-expert-selection-"));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "user-data-" + Date.now()));
let win;
function fail(error) {
  console.error(error?.stack || error);
  app.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const watchdog = setTimeout(() => fail(new Error("Expert selection smoke exceeded 60 seconds")), 60000);

async function read(expression) {
  return win.webContents.executeJavaScript(expression, true);
}
async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await read(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Timed out: " + expression);
}
async function click(selector, text) {
  const point = await read(`(() => {
    const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const item = ${text === undefined ? "items[0]" : `items.find(item => (item.querySelector('.composer-add__copy > span')?.textContent || item.textContent).trim() === ${JSON.stringify(text)})`};
    if (!item) throw new Error('Missing click target: ' + ${JSON.stringify(text || selector)});
    item.scrollIntoView({block:'nearest', inline:'nearest'});
    const rect = item.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    return {x, y, hit:item.contains(document.elementFromPoint(x,y)), disabled:item.disabled};
  })()`);
  assert.equal(point.disabled, false, "Click target is enabled");
  assert.equal(point.hit, true, "Click target is visible and receives pointer events");
  win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await read("window.api.vue.nextTick()");
}
async function openExperts() {
  await click(".composer-add__trigger");
  await waitFor("Boolean(document.querySelector('.composer-add__nav'))");
  await click(".composer-add__nav button", "专家与专家团");
  await waitFor("Boolean(document.querySelector('[aria-label=\"搜索专家或专家团\"]'))");
}
async function search(value) {
  await read(`(() => {
    const input = document.querySelector('[aria-label="搜索专家或专家团"]');
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await read("window.api.vue.nextTick()");
}
async function closeMenu() {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await waitFor("!document.querySelector('.composer-add__popup')");
}
async function screenshot(name) {
  await read("Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => undefined)))");
  await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await new Promise(resolve => setTimeout(resolve, 120));
  fs.writeFileSync(path.join(output, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function assertLayout() {
  const layout = await read(`(() => {
    const popup = document.querySelector('.composer-add__popup');
    const rect = popup.getBoundingClientRect();
    const panel = document.querySelector('.ai-panel').getBoundingClientRect();
    return {width:innerWidth, panelWidth:panel.width, left:rect.left, right:rect.right, top:rect.top, bottom:rect.bottom,
      bounded:rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      noOverflow:popup.scrollWidth <= popup.clientWidth && document.documentElement.scrollWidth <= innerWidth};
  })()`);
  assert.equal(layout.bounded, true, JSON.stringify(layout));
  assert.equal(layout.noOverflow, true, JSON.stringify(layout));
  return layout;
}

async function installFixture() {
  // Fit the preview's simulated workspace to a full-width panel, without changing product styles.
  const style = document.createElement("style");
  style.textContent = "body>header,#main,#dock-tabs{display:none}#shell{height:100vh}#dock{width:100%!important;flex:1;min-width:0;border:0}#panel-host{width:100%}";
  document.head.append(style);
  const fitPanel = () => document.documentElement.style.setProperty("--ai-panel-width", innerWidth + "px");
  fitPanel();
  window.addEventListener("resize", fitPanel);
  window.expertUnhandled = [];
  window.addEventListener("unhandledrejection", event => window.expertUnhandled.push(String(event.reason?.stack || event.reason)));
  window.expertRequests = [];
  const jobs = new Map();
  const wrap = data => ({ data: { code: 1000, data } });
  const chunk = (content, finish_reason = null) => `data: ${JSON.stringify({ id: "expert-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] })}\n\n`;
  const originalPost = window.api.axios.post;
  const originalGet = window.api.axios.get;
  window.api.axios.post = async (url, payload) => {
    if (url.endsWith("/abort")) { jobs.delete(payload.requestId); return wrap(true); }
    if (!url.endsWith("/begin") || payload.url.endsWith("/models")) return originalPost(url, payload);
    const request = JSON.parse(payload.body);
    window.expertRequests.push(request);
    jobs.set(payload.requestId, true);
    return wrap({ requestId: payload.requestId, status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } });
  };
  window.api.axios.get = async (url, config) => {
    if (!url.endsWith("/poll") || !jobs.has(config.params.requestId)) return originalGet(url, config);
    jobs.delete(config.params.requestId);
    return wrap({ chunks: [chunk("单专家模拟回答完成。"), chunk("", "stop"), "data: [DONE]\n\n"], done: true });
  };
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 980, height: 860, webPreferences: { backgroundThrottling: false } });
    win.webContents.on("render-process-gone", (_event, details) => fail(details));
    win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) console.error(message); });
    const blocked = [];
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(http|ws):\/\/127\.0\.0\.1:8889\//.test(details.url) || /^(data|blob):/.test(details.url);
      if (!allowed) blocked.push(details.url);
      callback({ cancel: !allowed });
    });
    await win.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?productionVue");
    await waitFor("Boolean(document.querySelector('.ai-composer__input'))");
    await read(`(${installFixture.toString()})()`);
    await click('[aria-label="收起会话列表"]');
    await openExperts();
    const labels = ["普通助手", "建模负责人", "需求专家", "SysML 语义专家", "图形布局专家", "模型检查专家", "SysML 专家团"];
    assert.deepEqual(await read("Array.from(document.querySelectorAll('.composer-add__item .composer-add__copy > span')).map(item=>item.textContent.trim())"), labels);
    assert.deepEqual(await read("Array.from(document.querySelectorAll('.composer-add__group > h3')).map(item=>item.textContent.trim())"), ["助手", "专家", "专家团"]);
    const wide = await assertLayout();
    await screenshot("expert-menu-wide");
    await search("语义");
    assert.equal(await read("Array.from(document.querySelectorAll('.composer-add__item')).some(item=>item.textContent.includes('SysML 语义专家'))"), true);
    await screenshot("expert-search-semantics");
    await search("专家团");
    assert.equal(await read("document.querySelectorAll('.composer-add__item').length"), 1);
    await screenshot("expert-search-team");
    await search("no-such-expert");
    assert.equal(await read("Boolean(document.querySelector('.composer-add__empty'))"), true);
    await search("");
    for (const label of labels) {
      if (!await read("Boolean(document.querySelector('.composer-add__popup'))")) await openExperts();
      await click(".composer-add__item", label);
      await waitFor("!document.querySelector('.composer-add__popup')");
      if (label === "普通助手") {
        assert.equal(await read("Boolean(document.querySelector('.team-selector'))"), false);
      } else {
        await waitFor(`document.querySelector('.team-selector > span:not(.builtin-avatar)')?.textContent.trim() === ${JSON.stringify(label)}`);
        await openExperts();
        assert.equal(await read(`Array.from(document.querySelectorAll('.composer-add__item[aria-pressed="true"]')).map(item=>item.querySelector('.composer-add__copy > span').textContent.trim()).join('') === ${JSON.stringify(label)}`), true);
        await closeMenu();
        await click(".team-selector__remove");
        await waitFor("!document.querySelector('.team-selector')");
      }
    }
    await openExperts();
    await click(".composer-add__item", "需求专家");
    await openExperts();
    await click(".composer-add__item", "普通助手");
    await waitFor("!document.querySelector('.team-selector')");
    await openExperts();
    await click(".composer-add__manage");
    await waitFor("document.querySelectorAll('.expert-center__card').length === 5");
    assert.equal(await read("Array.from(document.querySelectorAll('.expert-center__card')).every(card=>Array.from(card.querySelectorAll('button')).some(button=>button.textContent.trim()==='使用此专家'))"), true);
    await screenshot("expert-management-wide");
    await read("Array.from(document.querySelectorAll('.expert-center__card')).find(card=>card.querySelector('h4').textContent==='SysML 语义专家').querySelector('button').setAttribute('data-smoke-select','semantics')");
    await click('[data-smoke-select="semantics"]');
    await waitFor("document.querySelector('.team-selector > span:not(.builtin-avatar)')?.textContent === 'SysML 语义专家'");
    await read("(() => {const input=document.querySelector('.ai-composer__input');input.textContent='请说明你本轮负责的专业方向';input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await click(".ai-composer__submit");
    await waitFor("document.body.innerText.includes('单专家模拟回答完成。') && !document.querySelector('.ai-composer__submit.is-stop')");
    assert.equal(await read("window.expertRequests.length"), 1, "Single expert should issue one agent request");
    const request = await read("window.expertRequests[0]");
    const system = request.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(system, /你是SysML 语义专家/);
    assert.match(system, /独立处理用户任务/);
    assert.doesNotMatch(system, /目前只规划|只读分析，不生成提案/);
    assert.equal(await read("Boolean(document.querySelector('.team-progress'))"), false, "Single expert must not create team progress");
    await screenshot("single-expert-reply-wide");
    await openExperts();
    await assertLayout();
    await screenshot("expert-menu-wide-in-chat");
    await read("document.querySelector('.composer-add__list').scrollTop = document.querySelector('.composer-add__list').scrollHeight");
    await screenshot("expert-team-wide-in-chat");
    await closeMenu();
    win.setContentSize(320, 760);
    await waitFor("innerWidth === 320");
    await openExperts();
    const narrow = await assertLayout();
    await screenshot("expert-menu-narrow");
    await read("document.querySelector('.composer-add__list').scrollTop = document.querySelector('.composer-add__list').scrollHeight");
    await screenshot("expert-menu-narrow-scrolled");
    await search("专家团");
    await screenshot("expert-team-narrow");
    await click(".composer-add__item", "SysML 专家团");
    await waitFor("document.querySelector('.team-selector > span:not(.builtin-avatar)')?.textContent === 'SysML 专家团'");
    await screenshot("expert-team-chip-narrow");
    await openExperts();
    await click(".composer-add__manage");
    await waitFor("document.querySelectorAll('.expert-center__card').length === 5");
    assert.equal(await read("document.querySelector('.expert-center').scrollWidth <= document.querySelector('.expert-center').clientWidth"), true);
    await screenshot("expert-management-narrow");
    await click(".expert-center__categories button", "专家团");
    await waitFor("Boolean(document.querySelector('.expert-center__team'))");
    await screenshot("expert-team-management-narrow");
    await click(".expert-center__enable", "使用专家团");
    await waitFor("document.querySelector('.team-selector > span:not(.builtin-avatar)')?.textContent === 'SysML 专家团'");
    assert.deepEqual(await read("window.expertUnhandled"), []);
    assert.deepEqual(blocked, [], "No requests should leave the local preview");
    fs.writeFileSync(path.join(output, "provider-request.json"), JSON.stringify(request, null, 2));
    const result = { choices: labels, grouped: true, searched: true, selectedAndRemoved: true, ordinaryRestores: true, managementSelection: true, managementTeamSelection: true, singleExpertRequest: true, noTeamProgress: true, wide, narrow, externalRequests: 0, unhandled: [] };
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    console.log("PASS: expert/team grouping, search, all selections/removal, management selection, one standalone provider request, wide/narrow layout");
    console.log("Artifacts: " + output);
    clearTimeout(watchdog);
    win.destroy();
    app.exit(0);
  } catch (error) {
    if (win && !win.isDestroyed()) await screenshot("failure").catch(() => undefined);
    fail(error);
  }
});
