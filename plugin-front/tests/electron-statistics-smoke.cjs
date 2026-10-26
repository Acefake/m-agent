const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 320, height: 540, webPreferences: { backgroundThrottling: false } });
  win.setContentSize(320, 540);
  const read = code => win.webContents.executeJavaScript(code);
  const frame = () => read("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  try {
    await win.loadURL("http://127.0.0.1:8889/tests/ui/message-states.html");
    await read(
      `new Promise((resolve,reject)=>{const deadline=Date.now()+10000;function ready(){if(window.api?.vue && document.querySelector('.trace'))return resolve();if(Date.now()>deadline)return reject(new Error('fixture bootstrap timeout'));requestAnimationFrame(ready);}ready();})`
    );
    await read(`(async()=>{
      const Vue = window.api.vue;
      const {default: Statistics} = await import('/src/components/panels/aiAssistant/SessionStatistics.vue');
      document.querySelector('#app').style.display='none';
      document.body.style.cssText='margin:0;background:#fff';
      const root=document.createElement('main');root.style.cssText='box-sizing:border-box;width:320px;padding:380px 12px 0;container-type:inline-size;overflow:hidden';document.body.append(root);
      window.statsState=Vue.reactive({conversationId:'one',model:'test',messages:[{id:'run',createdAt:1,role:'assistant',model:'test',durationMs:3000,metrics:{modelMs:2100,toolMs:700,firstTokenMsTotal:500,firstTokenCount:2,generationMs:1000,timedOutputTokens:120},usage:{inputTokens:1000,outputTokens:120,totalTokens:1120,cachedInputTokens:600,latestInputTokens:1000},contextUsage:{systemTokens:100,toolTokens:200,messageTokens:650,inputTokens:1000,model:'test',contextLength:10000}}]});
      Vue.createApp({render:()=>Vue.h(Statistics,window.statsState)}).mount(root);await Vue.nextTick();
    })()`);
    await read("window.statsState.compact=true; undefined");
    await frame();
    await read("document.querySelector('.session-statistics').style.cssText='width:max-content;margin:0 auto'; undefined");
    await frame();
    assert.equal(await read('document.querySelectorAll(".session-statistics button").length'), 3);
    const screenshot = async name => {
      if (process.env.AGENT_UI_SCREENSHOTS) {
        fs.mkdirSync(process.env.AGENT_UI_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(path.join(process.env.AGENT_UI_SCREENSHOTS, name + ".png"), (await win.webContents.capturePage()).toPNG());
      }
    };
    for (let index = 0; index < 3; index++) {
      const button = await read(
        `(()=>{const r=document.querySelectorAll('.session-statistics button')[${index}].getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`
      );
      win.webContents.sendInputEvent({ type: "mouseMove", ...button });
      await frame();
      assert.equal(await read('document.querySelectorAll(".session-statistics__popover").length'), 1);
      assert.equal(
        await read(
          '(()=>{const r=document.querySelector(".session-statistics__popover").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()'
        ),
        true
      );
      assert.equal(
        await read('document.querySelector(".session-statistics__popover").parentElement===document.body'),
        true,
        "popup escapes clipping and fixed-position containing blocks"
      );
      const popup = await read(
        `(()=>{const r=document.querySelector('.session-statistics__popover').getBoundingClientRect();return {x:Math.round(Math.max(r.left+8,Math.min(r.right-8,${button.x}))),y:Math.round(r.bottom-12)}})()`
      );
      for (let step = 1; step <= 8; step++) {
        win.webContents.sendInputEvent({
          type: "mouseMove",
          x: Math.round(button.x + ((popup.x - button.x) * step) / 8),
          y: Math.round(button.y + ((popup.y - button.y) * step) / 8)
        });
        await frame();
      }
      await new Promise(resolve => setTimeout(resolve, 220));
      await frame();
      assert.equal(await read('document.querySelectorAll(".session-statistics__popover").length'), 1, "pointer can reach each popup");
      assert.equal(
        await read('document.querySelector(".session-statistics__popover").getAttribute("aria-label")'),
        ["会话统计", "Token 用量", "上下文用量"][index],
        "pointer bridge preserves the selected entry"
      );
      await screenshot("statistics-" + index + "-320");
      win.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
      await new Promise(resolve => setTimeout(resolve, 220));
      await frame();
      assert.equal(await read('document.querySelectorAll(".session-statistics__popover").length'), 0);
    }
    await read(`document.querySelector('.session-statistics button').focus();document.querySelector('.session-statistics button').click()`);
    await frame();
    assert.equal(await read('document.querySelector(".session-statistics button").getAttribute("aria-expanded")'), "true");
    await read(`document.querySelector('.session-statistics').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await frame();
    assert.equal(await read('document.querySelectorAll(".session-statistics__popover").length'), 0);
    await read(`document.querySelector('.session-statistics button').click();window.statsState.conversationId='two'`);
    await frame();
    assert.equal(await read('document.querySelectorAll(".session-statistics__popover").length'), 0);
    await read(
      `window.statsState.messages[0].durationMs=900000000000;window.statsState.messages[0].usage.totalTokens=900000000000000;window.statsState.messages[0].usage.inputTokens=900000000000000;document.querySelectorAll('.session-statistics button')[1].click()`
    );
    await frame();
    assert.equal(await read("document.documentElement.scrollWidth<=innerWidth"), true, "huge totals remain within 320px");
    assert.equal(
      await read(
        'document.querySelector(".session-statistics__popover").scrollWidth<=document.querySelector(".session-statistics__popover").clientWidth'
      ),
      true,
      "huge details wrap inside popover"
    );
    await screenshot("statistics-huge-320");
    await read(
      `window.statsClockStart=Date.now();window.statsState.messages[0].durationMs=3000;window.statsState.running=true;document.querySelector('.session-statistics').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
    );
    await frame();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await frame();
    const clock = await read(
      `({ text:document.querySelector('.session-statistics button').textContent, expected:Math.floor((Date.now()-window.statsClockStart+3000)/1000) })`
    );
    const elapsed = Number(clock.text.match(/^(\d+)秒/)?.[1]);
    assert.ok(
      elapsed >= 4 && Math.abs(elapsed - clock.expected) <= 1,
      "running timer follows elapsed time and excludes historical approval wait"
    );
    await read("window.statsState.running=false");
    await frame();
    assert.match(
      await read('document.querySelector(".session-statistics button").textContent'),
      /3秒/,
      "stopped timer uses persisted duration"
    );
    assert.equal(await read("document.documentElement.scrollWidth<=innerWidth"), true);
    await read("window.statsState.messages=[];window.statsState.conversationId='unknown';undefined");
    await frame();
    assert.equal(
      await read('document.querySelectorAll(".statistics-ring circle").length'),
      2,
      "context ring remains visible without historical statistics"
    );
    assert.match(await read('document.querySelector(".statistics-ring__fill").getAttribute("stroke-dasharray")'), /^0 /);
    assert.doesNotMatch(await read('document.querySelector(".session-statistics").textContent'), /未记录|未提供|统计中/);
    console.log("session statistics smoke passed: hover/click/focus/Escape/reset and 320px layout");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
