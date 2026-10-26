const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { backgroundThrottling: false } });
  const read = code => win.webContents.executeJavaScript(code);
  const wait = expression =>
    read(
      `new Promise((resolve,reject)=>{ const deadline=Date.now()+15000; function check(){if(${expression})return resolve();if(Date.now()>deadline)return reject(new Error('Timed out: '+${JSON.stringify(expression)}));requestAnimationFrame(check);}check();})`
    );
  try {
    await win.loadURL("http://127.0.0.1:8889/tests/ui/preview.html?productionVue");
    await wait("Boolean(document.querySelector('.ai-composer__input'))");
    await read(`(() => {
      document.querySelector('body > header').style.display='none';
      document.querySelector('#main').style.display='none';
      document.querySelector('#dock-tabs').style.display='none';
      document.querySelector('#shell').style.height='100vh';
      document.querySelector('#shell').style.position='relative';
      document.querySelector('#shell').style.zIndex='1000';
      document.querySelector('#dock').style.cssText='display:flex;flex:1;width:100%;min-width:0;background:white';
    })()`);
    await read(`(async()=>{
      const {useAiAssistantStore}=await import('/src/ai-assistant/conversation/store.ts?agentRevision='+window.__AGENT_DEV_REVISION__);
      window.statisticsStore=useAiAssistantStore();
      const jobs=new Map();const wrap=data=>({data:{code:1000,data}});
      const frame=(delta,finish_reason,usage)=>'data: '+JSON.stringify({id:'statistics',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})+'\\n\\n';
      window.statisticsRequests=[];
      window.api.axios.post=async(url,body)=>{
        if(url.endsWith('/abort'))return wrap(true);
        if(!url.endsWith('/begin'))throw new Error('Unexpected POST '+url);
        const request=JSON.parse(body.body);window.statisticsRequests.push(request);jobs.set(body.requestId,0);
        return wrap({requestId:body.requestId,status:200,statusText:'OK',headers:{'content-type':'text/event-stream'}});
      };
      window.api.axios.get=async(url,config)=>{
        if(!url.endsWith('/poll'))throw new Error('Unexpected GET '+url);
        const id=config.params.requestId;const phase=jobs.get(id);
        if(phase===0){jobs.set(id,1);return wrap({chunks:[frame({content:'统计'},null)],done:false});}
        jobs.delete(id);
        return wrap({chunks:[frame({content:'验证完成'},null),frame({},'stop',{prompt_tokens:16477,completion_tokens:279,total_tokens:16756,prompt_tokens_details:{cached_tokens:1280}}),'data: [DONE]\\n\\n'],done:true});
      };
      statisticsStore.createConversation();statisticsStore.setConversationOptions({permissionMode:'chat',contextLength:1000000});
      void statisticsStore.sendMessage('你好');
    })()`);
    await wait("!statisticsStore.isRunning && statisticsStore.messages.at(-1)?.content.includes('统计验证完成')");
    const actual = await read("JSON.parse(JSON.stringify(statisticsStore.messages.at(-1)))");
    assert.ok(actual.metrics.modelMs > 0);
    assert.equal(actual.metrics.toolMs, 0);
    assert.equal(actual.metrics.firstTokenCount, 1);
    assert.ok(actual.metrics.generationMs > 0);
    assert.equal(actual.usage.inputTokens, 16477);
    assert.equal(actual.usage.cachedInputTokens, 1280);
    assert.ok(actual.contextUsage.systemTokens > 0);
    assert.ok(actual.contextUsage.toolTokens > 0);
    assert.ok(actual.contextUsage.messageTokens > 0);
    assert.equal(actual.contextUsage.inputTokens, 16477);
    assert.equal(await read("statisticsRequests[0].stream_options.include_usage"), true);
    assert.equal(await read("Boolean(document.querySelector('.statistics-ring'))"), true);
    for (let index = 0; index < 3; index++) {
      await read(`document.querySelectorAll('.session-statistics button')[${index}].click()`);
      await wait("Boolean(document.querySelector('.session-statistics__popover'))");
      await read("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const visible = await read(`(() => {
        const popup=document.querySelector('.session-statistics__popover');
        const r=popup.getBoundingClientRect();
        return r.left>=0 && r.right<=innerWidth && r.top>=0 && popup.contains(document.elementFromPoint(r.right-8,r.top+8));
      })()`);
      assert.equal(visible, true, "popover must remain fully visible outside composer containment");
      const text = await read("document.querySelector('.session-statistics__popover').innerText");
      assert.doesNotMatch(text, /未记录|—/);
      if (process.env.AGENT_UI_SCREENSHOTS) {
        fs.mkdirSync(process.env.AGENT_UI_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(
          path.join(process.env.AGENT_UI_SCREENSHOTS, `statistics-live-${index}.png`),
          (await win.webContents.capturePage()).toPNG()
        );
      }
    }
    console.log("PASS: actual UI/store/agent/SDK bridge supplies timing, usage and all context categories");
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
