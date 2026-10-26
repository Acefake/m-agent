// Real Electron/Vue UI with the local preview host and a deterministic provider.
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const output = process.env.AGENT_CONTEXT_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), "agent-project-context-"));
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", path.join(output, "user-data-" + Date.now()));
let win;
function fail(error) { console.error(error?.stack || error); app.exit(1); }
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const watchdog = setTimeout(() => fail(new Error("Project context smoke exceeded 60 seconds")), 60000);
const read = expression => win.webContents.executeJavaScript(expression, true);
async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await read(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Timed out: " + expression);
}
async function click(selector) {
  const point = await read(`(() => {
    const item = document.querySelector(${JSON.stringify(selector)});
    if (!item) throw new Error('Missing target ' + ${JSON.stringify(selector)});
    item.scrollIntoView({block:'nearest'});
    const rect = item.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    return {x,y,hit:item.contains(document.elementFromPoint(x,y)),disabled:!!item.disabled};
  })()`);
  assert.equal(point.hit, true, "The visible UI target must receive pointer events");
  assert.equal(point.disabled, false);
  win.webContents.sendInputEvent({type:"mouseDown", x:point.x, y:point.y, button:"left", clickCount:1});
  win.webContents.sendInputEvent({type:"mouseUp", x:point.x, y:point.y, button:"left", clickCount:1});
  await read("window.api.vue.nextTick()");
}
async function screenshot(name) {
  await read("Promise.all(document.getAnimations().filter(a=>a.effect.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>undefined)))");
  await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await new Promise(resolve=>setTimeout(resolve,120));
  fs.writeFileSync(path.join(output,name+".png"),(await win.webContents.capturePage()).toPNG());
}
function userText(request) {
  return request.messages.filter(message=>message.role==="user").map(message=>typeof message.content === "string" ? message.content : message.content.map(part=>part.text||"").join("\n")).join("\n");
}
function assertProjectScope(request) {
  const system = request.messages.filter(message=>message.role==="system").map(message=>message.content).join("\n");
  assert.match(system,/工作范围是整个项目/);
  assert.doesNotMatch(userText(request),/【当前图表】|diagram-1|【当前文本】/);
}

async function installFixture() {
  const style = document.createElement("style");
  style.textContent = "body>header,#main,#dock-tabs{display:none}#shell{height:100vh}#dock{width:100%!important;flex:1;min-width:0;border:0}#panel-host{width:100%}";
  document.head.append(style);
  document.documentElement.style.setProperty("--ai-panel-width", innerWidth + "px");
  window.contextUnhandled = [];
  window.addEventListener("unhandledrejection",event=>window.contextUnhandled.push(String(event.reason?.stack||event.reason)));
  window.contextRequests = [];
  const jobs = new Map();
  const wrap = data => ({data:{code:1000,data}});
  const chunk = (content,finish_reason=null)=>`data: ${JSON.stringify({id:"context-fixture",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:content?{content}:{},finish_reason}]})}\n\n`;
  const originalPost = window.api.axios.post, originalGet = window.api.axios.get;
  window.api.axios.post = async (url,payload)=> {
    if(url.endsWith("/abort")){jobs.delete(payload.requestId);return wrap(true);}
    if(!url.endsWith("/begin")||payload.url.endsWith("/models"))return originalPost(url,payload);
    window.contextRequests.push(JSON.parse(payload.body));
    jobs.set(payload.requestId,window.contextRequests.length);
    return wrap({requestId:payload.requestId,status:200,statusText:"OK",headers:{"content-type":"text/event-stream"}});
  };
  window.api.axios.get = async (url,config)=> {
    if(!url.endsWith("/poll")||!jobs.has(config.params.requestId))return originalGet(url,config);
    const index=jobs.get(config.params.requestId);jobs.delete(config.params.requestId);
    return wrap({chunks:[chunk("项目范围模拟回复"+index),chunk("","stop"),"data: [DONE]\n\n"],done:true});
  };
  window.contextStore=(await import("/src/ai-assistant/conversation/store.ts")).useAiAssistantStore();
  const conversation=window.contextStore.createConversation();
  conversation.messages=[
    {id:"legacy-user",role:"user",content:"历史问题，请查看项目",toolCalls:[],createdAt:1,context:{diagram:{id:"diagram-1",name:"车辆结构图",shapeCount:2}}},
    {id:"legacy-assistant",role:"assistant",content:"历史回答",toolCalls:[],createdAt:2}
  ];
  window.contextStore.persistConversations();
}

app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({show:false,width:900,height:820,webPreferences:{backgroundThrottling:false}});
    win.webContents.on("render-process-gone",(_event,details)=>fail(details));
    win.webContents.on("console-message",(_event,level,message)=>{if(level>=3)console.error(message);});
    const blocked=[];
    win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{
      const allowed=/^(http|ws):\/\/127\.0\.0\.1:8889\//.test(details.url)||/^(data|blob):/.test(details.url);
      if(!allowed)blocked.push(details.url);
      callback({cancel:!allowed});
    });
    await win.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?productionVue");
    await waitFor("Boolean(document.querySelector('.ai-composer__input'))");
    await read(`(${installFixture.toString()})()`);
    await click('[aria-label="收起会话列表"]');
    await waitFor("document.body.innerText.includes('历史问题，请查看项目')");
    assert.equal(await read("window.app.activeProject.ui.graphTabs[0].diagramModel.id"),"diagram-1","Fixture must have an open diagram");
    assert.equal(await read("document.querySelectorAll('.turn__context').length"),0,"Legacy snapshot must not display a reference footer");
    await screenshot("legacy-message-no-footer");
    await click(".ai-composer__input");
    win.webContents.insertText("概述这个项目的用途");
    await waitFor("document.querySelector('.ai-composer__input').textContent.includes('概述这个项目的用途')");
    await click(".ai-composer__submit");
    await waitFor("document.body.innerText.includes('项目范围模拟回复1') && !window.contextStore.isRunning");
    assert.equal(await read("document.querySelectorAll('.turn__context').length"),0);
    const first=await read("window.contextRequests[0]");
    assertProjectScope(first);
    assert.match(userText(first),/概述这个项目的用途/);
    assert.equal(await read("window.contextStore.messages.filter(message=>message.role==='user').at(-1).context === undefined"),true,"New message must not capture the open diagram");
    await screenshot("plain-project-message");
    await click(".ai-composer__input");
    win.webContents.insertText("解释 @");
    await waitFor("Boolean(document.querySelector('.ai-mention__action'))");
    await screenshot("explicit-mention-picker");
    await click(".ai-mention__action");
    await waitFor("Boolean(document.querySelector('.ai-composer__input [data-mention-id=\"pkg-1\"]'))");
    assert.equal(await read("document.querySelector('.ai-composer__input [data-mention-id=\"pkg-1\"]').dataset.mentionTitle"),"车辆系统");
    await screenshot("explicit-mention-token");
    await click(".ai-composer__submit");
    await waitFor("document.body.innerText.includes('项目范围模拟回复2') && !window.contextStore.isRunning");
    assert.equal(await read("window.contextRequests.length"),2);
    const second=await read("window.contextRequests[1]");
    assertProjectScope(second);
    assert.match(userText(second),/@\[车辆系统\]\(pkg-1\)/);
    assert.equal(await read("document.querySelectorAll('.turn__context').length"),0);
    assert.equal(await read("document.body.innerText.includes('@[车辆系统](pkg-1)')"),true);
    await screenshot("explicit-mention-message");
    assert.deepEqual(await read("window.contextUnhandled"),[]);
    assert.deepEqual(blocked,[]);
    fs.writeFileSync(path.join(output,"provider-requests.json"),JSON.stringify([first,second],null,2));
    fs.writeFileSync(path.join(output,"result.json"),JSON.stringify({openDiagram:"diagram-1",legacyFooterRemoved:true,plainProjectScope:true,newSnapshotAbsent:true,explicitMentionPreserved:true,noAutomaticDiagram:true,requests:2,externalRequests:0,unhandled:[]},null,2));
    console.log("PASS: legacy/new messages have no automatic context footer; plain and explicit @ requests retain project scope without open diagram injection");
    console.log("Artifacts: "+output);
    clearTimeout(watchdog);win.destroy();app.exit(0);
  }catch(error){if(win&&!win.isDestroyed())await screenshot("failure").catch(()=>undefined);fail(error);}
});
