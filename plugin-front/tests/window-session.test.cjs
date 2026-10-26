const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const Vue = require("vue");

function runtime(settings) {
  const events = new EventTarget();
  let host = {
    getActiveProjectId: () => "project-1",
    getActiveProjectName: () => "车辆系统",
    model: { pickMentions: async () => [{ id: "real-id", title: "发动机", type: "Block" }] }
  };
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/presentation/window-session.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  const mocks = {
    vue: Vue,
    "../ai-assistant/memory": { emptyMemoryState: () => ({ contextKey: "", enabled: false, entries: [], status: "idle", error: "" }) },
    "../ai-assistant/host": {
      configureAiAssistant: value => {
        host = value;
      },
      getAiAssistantHost: () => host
    },
    "../ai-assistant/provider/providerConfig": {
      loadAiProviderSettings: () => structuredClone(settings),
      saveAiProviderSettings: next => {
        settings = next;
      }
    }
  };
  new Function("require", "module", "exports", "window", code)(name => mocks[name], mod, mod.exports, events);
  return { ...mod.exports, host: () => host, settings: () => settings };
}

test("镜像管理等待owner事务再回执，并原样返回错误和过期上下文", async () => {
  const owner = runtime({ profiles: [] });
  const child = runtime({});
  let complete;
  let submitted;
  const store = Vue.reactive({
    messages: [],
    conversations: [],
    activeConversationId: "",
    isRunning: false,
    runningConversationId: "",
    runningConversationIds: [],
    drafts: {},
    errorMessage: "",
    hasMessages: false,
    memoryState: { contextKey: "captured-context", enabled: false, entries: [] },
    refreshMemory: async () => undefined,
    changeMemory: (command, contextKey) => {
      submitted = { command, contextKey };
      if (contextKey !== "captured-context") throw new Error("账号或项目已切换");
      return new Promise(resolve => {
        complete = () => {
          store.memoryState.enabled = true;
          resolve();
        };
      });
    }
  });
  const session = owner.createOwnerSession(
    store,
    () => {},
    () => {}
  );
  let mirror;
  try {
    mirror = await child.connectDetachedSession(session.id, () => {});
    let resolved = false;
    const command = mirror.store.changeMemory({ kind: "enabled", enabled: true }, "captured-context").then(() => {
      resolved = true;
    });
    await until(() => !!submitted);
    assert.equal(resolved, false);
    assert.equal(submitted.contextKey, "captured-context");
    complete();
    await command;
    assert.equal(mirror.store.memoryState.enabled, true);
    await assert.rejects(mirror.store.changeMemory({ kind: "clear", projectId: "all" }, "stale"), /已切换/);
  } finally {
    mirror?.dispose();
    session.dispose();
  }
});

async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("窗口同步超时");
}

test("separate renderer mirrors owner state and commands without restarting the Agent", async () => {
  const settings = {
    activeProfileId: "p",
    profiles: [{ id: "p", model: "test" }],
    conversationsByProject: { "project-1": [{ id: "saved" }] }
  };
  const owner = runtime(settings),
    child = runtime({});
  let runs = 0,
    docked = 0,
    opened = 0,
    closed = 0;
  const store = Vue.reactive({
    messages: [],
    conversations: [],
    activeConversationId: "c1",
    isRunning: true,
    runningConversationId: "c1",
    runningConversationIds: ["c1"],
    drafts: {},
    setDraft: (id, draft) => {
      store.drafts[id] = draft;
    },
    errorMessage: "",
    hasMessages: false,
    sendMessage: () => {
      runs++;
    },
    setExecutionStrategy: strategy => {
      store.conversations = [{ id: "c1", strategy, messages: [] }];
    },
    stop: id => {
      store.stoppedId = id;
      store.isRunning = false;
    }
  });
  let draft = { html: "原始草稿", attachments: [], notice: "", scrollTop: 40 };
  const unbind = owner.registerDraftAccess({
    read: () => draft,
    write: value => {
      draft = value;
    }
  });
  const session = owner.createOwnerSession(
    store,
    () => {
      opened++;
    },
    () => {
      docked++;
    }
  );
  let mirror;
  try {
    mirror = await child.connectDetachedSession(session.id, () => {
      closed++;
    });
    mirror.mounted();
    await until(() => opened === 1);
    assert.equal(mirror.store.isRunning, true);
    assert.equal(mirror.draft.html, "原始草稿");
    assert.equal(child.host().getActiveProjectId(), "project-1");
    assert.equal(child.host().settingsStorage.get().conversationsByProject, undefined);
    store.messages.push({ id: "m1", role: "assistant", content: "已创建 real-id", modelContext: "large internal history", toolCalls: [] });
    await until(() => mirror.store.messages.length === 1);
    assert.equal(mirror.store.messages[0].modelContext, undefined);
    assert.equal(mirror.store.messages[0].content, "已创建 real-id");
    assert.equal(runs, 0);
    await mirror.store.setExecutionStrategy("sysml-team");
    await until(() => mirror.store.conversations[0]?.strategy === "sysml-team");
    await mirror.store.setExecutionStrategy("expert:semantics");
    await until(() => mirror.store.conversations[0]?.strategy === "expert:semantics");
    assert.equal(store.conversations[0].strategy, "expert:semantics");
    await mirror.store.setExecutionStrategy("sysml-team");
    await until(() => mirror.store.conversations[0]?.strategy === "sysml-team");
    store.messages[0].team = { id: "team", status: "running", members: [{ id: "member", role: "lead", status: "running", toolCalls: [] }] };
    await until(() => mirror.store.messages[0]?.team?.id === "team");
    await mirror.store.sendMessage("继续");
    assert.equal(runs, 1);
    assert.deepEqual(await child.host().model.pickMentions(), [{ id: "real-id", title: "发动机", type: "Block" }]);
    mirror.send({ type: "draft", value: { ...draft, html: "窗口内编辑后的草稿", scrollTop: 80 } });
    await until(() => draft.html === "窗口内编辑后的草稿");
    child.host().settingsStorage.set({ ...settings, permissionMode: "edit", conversationsByProject: { other: [] } });
    await until(() => owner.settings().permissionMode === "edit");
    assert.equal(owner.settings().conversationsByProject["project-1"][0].id, "saved");
    mirror.send({ type: "dock" });
    await until(() => docked === 1);
    // 原窗口先切换，镜像尚未收到新快照：停止必须仍指向点击时的 c1。
    store.activeConversationId = "c2";
    await mirror.store.stop();
    assert.equal(store.stoppedId, "c1");
    mirror.send({ type: "draft", value: { ...draft, conversationId: "c1", projectId: "project-1", html: "c1 后到的草稿" } });
    await until(() => store.drafts.c1?.html === "c1 后到的草稿");
    assert.equal(draft.html, "窗口内编辑后的草稿");
    session.close();
    await until(() => closed === 1);
  } finally {
    mirror?.dispose();
    session.dispose();
    unbind();
  }
});

test("旧版主窗口缺少会话命令时拒绝连接，明确提示重载插件", async () => {
  const child = runtime({});
  const id = crypto.randomUUID();
  const owner = new BroadcastChannel(`agent-window-${id}`);
  owner.onmessage = ({ data }) => {
    if (data.type !== "ready") return;
    owner.postMessage({
      type: "state",
      value: {
        messages: [],
        conversations: [],
        activeConversationId: "c1",
        isRunning: false,
        runningConversationId: "",
        errorMessage: "",
        hasMessages: false,
        projectId: "project-1",
        projectName: "车辆系统",
        settings: { profiles: [] }
      }
    });
    owner.postMessage({ type: "draft", value: { html: "", attachments: [], notice: "", scrollTop: 0 } });
  };
  let session;
  try {
    await assert.rejects(async () => {
      session = await child.connectDetachedSession(id, () => {});
    }, /版本不一致.*重新加载插件/);
  } finally {
    session?.dispose();
    owner.close();
  }
});
