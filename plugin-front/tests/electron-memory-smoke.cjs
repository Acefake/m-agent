const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const output = process.env.AGENT_MEMORY_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-smoke-"));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", process.env.AGENT_MEMORY_USER_DATA || path.join(output, "user-data"));
app.on("web-contents-created", (_event, contents) =>
  contents.on("render-process-gone", (_event, details) => {
    console.error(details);
    app.exit(1);
  })
);
const deadline = setTimeout(() => {
  console.error("Memory smoke exceeded 90 seconds");
  app.exit(1);
}, 90000);

async function waitFor(win, expression) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`等待超时 ${expression}`);
}

async function fixture() {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) console.error(message);
  });
  await win.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?productionVue");
  await waitFor(win, "Boolean(document.querySelector('.ai-composer__input'))");
  await win.webContents.executeJavaScript(`(${installProvider.toString()})()`);
  return win;
}

async function installProvider() {
  const style = document.createElement("style");
  style.textContent =
    "#main { min-width:0; overflow:hidden; } #log { white-space:pre-wrap; overflow-wrap:anywhere; } #dock { flex-shrink:0; }";
  document.head.append(style);
  window.memoryUnhandled = [];
  window.addEventListener("unhandledrejection", event => {
    window.memoryUnhandled.push(String(event.reason?.stack || event.reason));
    console.error("memory unhandled", String(event.reason?.stack || event.reason));
  });
  window.memoryStore = (await import("/src/ai-assistant/conversation/store.ts?agentRevision=" + window.__AGENT_DEV_REVISION__)).useAiAssistantStore();
  await window.memoryStore.refreshMemory();
  window.memoryRequests = [];
  window.memoryReleases = [];
  window.holdMemoryExtraction = false;
  window.memoryQuote = "我偏好简洁回答";
  const jobs = new Map();
  const wrap = data => ({ data: { code: 1000, data } });
  const chunk = (content, finish_reason = null) =>
    `data: ${JSON.stringify({ id: "memory-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: content ? { content } : {}, finish_reason }] })}\n\n`;
  window.api.axios.post = async (url, payload) => {
    if (url.endsWith("/abort")) {
      jobs.delete(payload.requestId);
      return wrap(true);
    }
    if (!url.endsWith("/begin")) throw new Error("Unexpected network request " + url);
    const request = JSON.parse(payload.body);
    const system = request.messages
      .filter(message => message.role === "system")
      .map(message => message.content)
      .join("\n");
    const extraction = system.includes("从本轮用户正文中选择");
    window.memoryRequests.push({ extraction, request });
    const last = [...request.messages].reverse().find(message => message.role === "user");
    let reply = "已收到需求。";
    if (extraction) {
      const input = JSON.parse(last.content);
      reply = input.text.includes(window.memoryQuote)
        ? JSON.stringify([
            {
              quote: window.memoryQuote,
              scope: window.memoryQuote.startsWith("我") ? "user" : "project",
              category: window.memoryQuote.startsWith("我") ? "preference" : "convention"
            }
          ])
        : "[]";
    }
    jobs.set(payload.requestId, { reply, extraction });
    return wrap({ requestId: payload.requestId, status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } });
  };
  window.api.axios.get = async (url, config) => {
    if (!url.endsWith("/poll")) throw new Error("Unexpected network request " + url);
    const job = jobs.get(config.params.requestId);
    if (!job) return wrap({ chunks: [], done: true });
    if (job.extraction && window.holdMemoryExtraction) await new Promise(resolve => window.memoryReleases.push(resolve));
    jobs.delete(config.params.requestId);
    return wrap({ chunks: [chunk(job.reply), chunk("", "stop"), "data: [DONE]\n\n"], done: true });
  };
  window.releaseMemory = () => {
    window.holdMemoryExtraction = false;
    window.memoryReleases.splice(0).forEach(resolve => resolve());
  };
}

async function databaseAssertions() {
  const { MemoryDatabase } = await import("/src/ai-assistant/memory/database.ts");
  const identity = { kind: "account", authority: "smoke.invalid", userId: "transactions" };
  const left = new MemoryDatabase(identity);
  const right = new MemoryDatabase(identity);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  await left.change("p", { kind: "clear", projectId: "all" });
  await left.change("p", { kind: "enabled", enabled: true });
  let sequence = 0;
  const ticket = () => left.begin("p", { conversationId: "c-" + ++sequence, messageId: "m-" + sequence, quote: "", createdAt: 1 });
  const candidate = (quote, supersedesId) => ({
    start: 0,
    end: quote.length,
    quote,
    scope: "project",
    category: "convention",
    ...(supersedesId ? { supersedesId } : {})
  });
  const a = await ticket(),
    b = await ticket();
  await Promise.all([left.commit(a, [candidate("车辆前缀A")], () => true), right.commit(b, [candidate("车辆前缀B")], () => true)]);
  check((await left.snapshot("p")).entries.length === 2, "两个owner新增丢失");
  check((await left.snapshot("other")).entries.length === 0, "项目数据泄露");
  const stale = await ticket();
  const initial = (await left.snapshot("p")).entries[0];
  await right.change("p", { kind: "edit", id: initial.id, expectedRevision: initial.revision, text: "人工车辆前缀" });
  check((await left.commit(stale, [candidate("旧提取复活")], () => true)).stale, "人工编辑未废弃旧票据");
  const manualTicket = await ticket();
  await left.commit(manualTicket, [candidate("以后改用自动前缀", initial.id)], () => true);
  check(
    (await left.snapshot("p")).entries.some(entry => entry.text === "人工车辆前缀" && entry.mode === "manual"),
    "自动覆盖人工项"
  );
  await left.change("p", { kind: "clear", projectId: "all" });
  const t = await ticket();
  await left.commit(t, [candidate("旧前缀"), candidate("以后改用新前缀")], () => true);
  const correction = await ticket();
  const old = correction.entries.find(entry => entry.text === "旧前缀");
  await right.commit(correction, [candidate("以后改用新前缀", old.id)], () => true);
  check((await left.snapshot("p")).entries.length === 1, "去重纠正仍保留冲突旧项");
  for (const command of [
    { kind: "clear", projectId: "all" },
    { kind: "enabled", enabled: false }
  ]) {
    const pending = await ticket();
    await right.change("p", command);
    check((await left.commit(pending, [candidate("不能复活")], () => true)).stale, "管理后旧票据复活");
    await left.change("p", { kind: "enabled", enabled: true });
  }
  const sourceTicket = await ticket();
  await right.forgetConversation("p", sourceTicket.source.conversationId);
  check((await left.commit(sourceTicket, [candidate("删除来源")], () => true)).stale, "删除会话未废弃票据");
  check(!(await left.begin("p", sourceTicket.source)), "删除来源仍能发起提取");
  await left.change("p", { kind: "clear", projectId: "all" });
  const capacity = await ticket();
  await left.commit(
    capacity,
    Array.from({ length: 200 }, (_, index) => candidate("规则" + index)),
    () => true
  );
  const full = await left.commit(await ticket(), [candidate("超额新增")], () => true);
  check(full.full && (await left.snapshot("p")).entries.length === 200, "200条上限失效");
  const isolated = new MemoryDatabase({ kind: "account", authority: "smoke.invalid", userId: "other" });
  check((await isolated.snapshot("p")).entries.length === 0, "身份数据泄露");
  return { concurrent: true, revisions: true, manual: true, correction: true, tombstone: true, capacity: true, isolation: true };
}

app.whenReady().then(async () => {
  let owner, other;
  try {
    owner = await fixture();
    const read = expression => owner.webContents.executeJavaScript(expression, true);
    const restored = await read("memoryStore.memoryState.entries.some(entry => entry.text === '我偏好简洁回答')");
    if (process.env.AGENT_MEMORY_VERIFY_RESTART) {
      assert.equal(restored, true, "进程重开后记忆应保留");
      console.log("PASS memory process restart persistence");
      clearTimeout(deadline);
      app.exit(0);
      return;
    }
    assert.equal(await read("memoryStore.memoryState.enabled"), false);
    await read("if (!document.querySelector('.ai-conversations')) document.querySelector('.ai-panel__sidebar-toggle').click()");
    await waitFor(owner, "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '记忆')");
    await read("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '记忆').click()");
    await waitFor(owner, "Boolean(document.querySelector('.memory-settings'))");
    await waitFor(owner, "!document.querySelector('.memory-toggle input').disabled");
    await read("document.querySelector('.memory-toggle input').click()");
    await waitFor(owner, "memoryStore.memoryState.enabled");
    await read("void memoryStore.sendMessage('我偏好简洁回答')");
    await waitFor(owner, "memoryStore.memoryState.entries.length === 1 && memoryStore.memoryState.status !== 'extracting'");
    console.log("memory extraction persisted");
    assert.match(
      await read("memoryRequests.find(item => !item.extraction).request.messages[0].content"),
      /记忆协作（M-Design）/,
      "默认记忆协作技能必须进入实际对话请求"
    );
    assert.match(await read("document.querySelector('.ai-chat-memory').textContent"), /记忆已保存/);
    await waitFor(owner, "!document.querySelector('.ai-chat-memory')");
    assert.equal(await read("memoryStore.memoryState.status"), "saved", "保存提示消失不清除记忆保存状态");
    assert.equal(await read("memoryRequests.filter(item => item.extraction).length"), 1);
    await read("memoryStore.createConversation(); memoryStore.sendMessage('帮我分析车辆系统')");
    await waitFor(owner, "memoryStore.memoryState.status !== 'extracting' && memoryRequests.filter(item => item.extraction).length === 2");
    assert.equal(
      await read("memoryRequests.filter(item => !item.extraction).at(-1).request.messages[0].content.includes('我偏好简洁回答')"),
      true
    );
    assert.equal(await read("Object.keys(memoryRequests.filter(item => item.extraction)[0].request).includes('tools')"), false);
    await waitFor(owner, "Boolean(document.querySelector('.memory-entry'))");
    await read(
      "document.querySelector('.memory-source').open = true; document.querySelector('#main').style.display='none'; document.querySelector('body>header').style.display='none'; document.querySelector('#shell').style.height='100vh'; document.querySelector('#dock-tabs').style.display='none'; document.querySelector('#dock').style.width='100%'; document.querySelector('#dock').style.borderLeft='0'; document.querySelector('.memory-settings .ai-section__body').scrollTop=0"
    );
    for (const [width, name] of [
      [1000, "memory-wide"],
      [320, "memory-narrow"]
    ]) {
      if (width === 320) {
        await read("document.querySelector('.ai-conversations').style.display='none'");
      }
      owner.setContentSize(width, 1000);
      await read(`document.documentElement.style.setProperty('--ai-panel-width', '${width}px')`);
      await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const bounds = await read(
        `(() => { const panel=document.querySelector('.memory-settings'); const rect=panel.getBoundingClientRect(); const entry=document.querySelector('.memory-entry').getBoundingClientRect(); const source=document.querySelector('.memory-source').getBoundingClientRect(); return {left:rect.left,right:rect.right,width:rect.width,viewport:innerWidth,scroll:panel.scrollWidth,client:panel.clientWidth,entryBottom:entry.bottom,sourceBottom:source.bottom,height:innerHeight,text:panel.textContent}; })()`
      );
      fs.writeFileSync(path.join(output, name + ".json"), JSON.stringify(bounds, null, 2));
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport, "记忆面板必须完整位于视口内");
      assert.ok(bounds.scroll <= bounds.client, "记忆内容不得横向溢出");
      assert.ok(bounds.sourceBottom <= bounds.height && bounds.entryBottom <= bounds.height, "真实记忆及来源必须在截图内可见");
      assert.match(bounds.text, /自动整理/);
      assert.match(bounds.text, /我偏好简洁回答/);
      if (width === 320) assert.ok(bounds.width >= 318 && bounds.width <= 320, "窄图测量实际记忆内容宽度");
      fs.writeFileSync(path.join(output, name + ".png"), (await owner.webContents.capturePage()).toPNG());
    }
    await read(
      "Array.from(document.querySelectorAll('.memory-entry button')).find(button => button.textContent.trim() === '编辑').click()"
    );
    await read(
      "const input = document.querySelector('.memory-editor textarea'); input.value = '我偏好简洁中文回答'; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('.memory-editor').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));"
    );
    await waitFor(owner, "memoryStore.memoryState.entries[0].mode === 'manual'");
    assert.equal(await read("memoryStore.memoryState.entries[0].text"), "我偏好简洁中文回答");
    await read(
      "Array.from(document.querySelectorAll('.memory-entry button')).find(button => button.textContent.trim() === '删除').click()"
    );
    await waitFor(
      owner,
      "Array.from(document.querySelectorAll('.memory-entry button')).some(button => button.textContent.trim() === '确认删除')"
    );
    await read(
      "Array.from(document.querySelectorAll('.memory-entry button')).find(button => button.textContent.trim() === '确认删除').click()"
    );
    await waitFor(owner, "memoryStore.memoryState.entries.length === 0");
    other = await fixture();
    await waitFor(other, "memoryStore.memoryState.enabled");
    for (const action of ["clear", "disabled", "delete-source", "edit"]) {
      await read(
        "memoryQuote = '我偏好简洁回答'; holdMemoryExtraction = true; memoryStore.createConversation(); memoryStore.sendMessage(memoryQuote)"
      );
      await waitFor(owner, "memoryStore.memoryState.status === 'extracting' && memoryReleases.length > 0");
      await read("document.querySelector('.ai-conversations__select').click()");
      await waitFor(owner, "Boolean(document.querySelector('.ai-chat-memory.is-remembering'))");
      const memoryIndicator = await read(`(() => {
        const element = document.querySelector('.ai-chat-memory');
        const rect = element.getBoundingClientRect();
        return { text: element.textContent, color: getComputedStyle(element).color,
          animation: getComputedStyle(element.querySelector('svg')).animationName,
          visible: rect.width > 0 && rect.height > 0, left: rect.left, right: rect.right, width: innerWidth };
      })()`);
      assert.match(memoryIndicator.text, /记忆中…/);
      assert.equal(memoryIndicator.color, "rgb(37, 99, 235)");
      assert.match(memoryIndicator.animation, /^chat-memory-pulse/);
      assert.ok(memoryIndicator.visible && memoryIndicator.left >= 0 && memoryIndicator.right <= memoryIndicator.width);
      if (action === "clear") {
        await read("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        fs.writeFileSync(path.join(output, "memory-chat-extracting.png"), (await owner.webContents.capturePage()).toPNG());
        await read("document.querySelector('.ai-chat-memory__action').click()");
        await waitFor(owner, "Boolean(document.querySelector('.memory-settings'))");
      }
      if (action === "clear")
        await other.webContents.executeJavaScript(
          "memoryStore.changeMemory({kind:'clear',projectId:'all'}, memoryStore.memoryState.contextKey)"
        );
      if (action === "disabled")
        await other.webContents.executeJavaScript(
          "memoryStore.changeMemory({kind:'enabled',enabled:false}, memoryStore.memoryState.contextKey)"
        );
      if (action === "delete-source") await read("memoryStore.deleteConversation(memoryStore.activeConversationId)");
      if (action === "edit") {
        await other.webContents.executeJavaScript(
          `(async () => { const {MemoryDatabase}=await import('/src/ai-assistant/memory/database.ts'); const db=new MemoryDatabase({kind:'local-profile'}); const t=await db.begin('preview-project',{conversationId:'manual-fixture',messageId:'m',quote:'',createdAt:1}); await db.commit(t,[{quote:'人工来源',scope:'project',category:'convention'}],()=>true); await memoryStore.refreshMemory(); const e=memoryStore.memoryState.entries[0]; await memoryStore.changeMemory({kind:'edit',id:e.id,expectedRevision:e.revision,text:'人工优先'},memoryStore.memoryState.contextKey); })()`
        );
      }
      await read("releaseMemory(); undefined");
      await waitFor(owner, "memoryStore.memoryState.status !== 'extracting'");
      await read("memoryStore.refreshMemory()");
      assert.equal(await read("memoryStore.memoryState.entries.some(entry => entry.text === '我偏好简洁回答')"), false, action);
      await read("memoryStore.changeMemory({kind:'clear',projectId:'all'}, memoryStore.memoryState.contextKey); undefined");
      await read("memoryStore.changeMemory({kind:'enabled',enabled:true}, memoryStore.memoryState.contextKey)");
    }
    await waitFor(other, "memoryStore.memoryState.enabled");
    await Promise.all([
      read("memoryQuote='本项目使用甲前缀'; memoryStore.createConversation(); memoryStore.sendMessage(memoryQuote)"),
      other.webContents.executeJavaScript(
        "memoryQuote='本项目使用乙前缀'; memoryStore.createConversation(); memoryStore.sendMessage(memoryQuote)"
      )
    ]);
    await waitFor(
      owner,
      "memoryStore.memoryState.entries.some(entry=>entry.text==='本项目使用甲前缀') && memoryStore.memoryState.entries.some(entry=>entry.text==='本项目使用乙前缀')"
    );
    await read("memoryStore.changeMemory({kind:'clear',projectId:'all'},memoryStore.memoryState.contextKey)");
    const database = await read(`(${databaseAssertions.toString()})()`);
    assert.deepEqual(await read("memoryUnhandled"), [], "后台取消不得产生未处理的Promise拒绝");
    await read("memoryQuote = '我偏好简洁回答'; releaseMemory(); memoryStore.createConversation(); memoryStore.sendMessage(memoryQuote)");
    await waitFor(owner, "memoryStore.memoryState.entries.some(entry => entry.text === '我偏好简洁回答')");
    owner.destroy();
    owner = await fixture();
    assert.equal(
      await owner.webContents.executeJavaScript("memoryStore.memoryState.entries.some(entry => entry.text === '我偏好简洁回答')"),
      true,
      "窗口重开持久化"
    );
    fs.writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify({ ui: true, recall: true, extractionOnce: true, staleTasks: true, windowReopen: true, database }, null, 2)
    );
    console.log("PASS memory owner/UI/stream extraction, recall, management, stale tasks, multi-owner IDB and window persistence", output);
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
