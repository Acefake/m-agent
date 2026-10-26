const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level >= 2) console.error(source + ":" + line + " " + message);
  });
  try {
    await win.loadURL("http://127.0.0.1:8889/tests/ui/message-states.html");
    await win.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const deadline=Date.now()+10000;function check(){if(document.querySelector('.trace'))return resolve();if(Date.now()>deadline)return reject(new Error('SFC fixture failed to render'));requestAnimationFrame(check);}check();})`
    );
    const result = await win.webContents.executeJavaScript(`(async () => {
      const sourceOf = async stamp => (await fetch('/src/main.ts?t=' + stamp)).text();
      const first = await sourceOf('reload-one');
      const firstRevision = first.match(/agentRevision=([a-z0-9]+)/)?.[1];
      if (!firstRevision) return { revised: false };
      const firstStore = await import('/src/ai-assistant/conversation/store.ts?agentRevision=' + firstRevision);
      const firstInstance = firstStore.useAiAssistantStore();
      const second = await sourceOf('reload-two');
      const secondRevision = second.match(/agentRevision=([a-z0-9]+)/)?.[1];
      const secondStore = await import('/src/ai-assistant/conversation/store.ts?agentRevision=' + secondRevision);
      const secondInstance = secondStore.useAiAssistantStore();
      const nested = await (await fetch('/src/ai-assistant/runtime/agent.ts?agentRevision=' + secondRevision)).text();
      return { revised: true, distinctRevision: firstRevision !== secondRevision, freshOwner: firstInstance !== secondInstance, nestedRevision: nested.includes('agent-loop.ts?agentRevision=' + secondRevision) };
    })()`);
    assert.equal(result.revised, true, "plugin reload must revise the full local module graph");
    assert.equal(result.distinctRevision, true);
    assert.equal(result.freshOwner, true, "reloaded UI must not reuse an old store/action runtime");
    assert.equal(result.nestedRevision, true);
    console.log("PASS: plugin reload refreshes owner store and nested agent runtime");
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
