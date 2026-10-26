const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const Vue = require("vue");
const Pinia = require("pinia");

const expertRoles = (() => {
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/runtime/expert-roles.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", code)(mod.exports);
  return mod.exports;
})();

const historyDigest = (() => {
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/conversation/history-digest.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(require, mod, mod.exports);
  return mod.exports;
})();

const conversationContext = (() => {
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/conversation/context.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", code)(mod.exports);
  return mod.exports;
})();

function runtime(t, existingHostStore = false) {
  let sequence = 0;
  let settings = { profiles: [{ id: "provider", model: "test-model" }], permissionMode: "proposal" };
  const runs = [];
  const reviews = [];
  const memoryTurns = [];
  const memoryControl = { failure: false, unsupported: false, cancellations: 0, tombstones: [], wait: null };
  const host = { features: { sysmlText: false } };
  const mocks = {
    vue: Vue,
    pinia: Pinia,
    "../memory": { emptyMemoryState: () => ({ contextKey: "", enabled: false, available: true, entries: [], status: "idle", error: "" }) },
    "../memory/service": {
      MemoryService: class {
        cancel() {
          memoryControl.cancellations++;
        }
        async refresh() {}
        async change() {}
        async forgetConversation(id) {
          if (memoryControl.unsupported) return;
          if (memoryControl.wait) await memoryControl.wait;
          if (memoryControl.failure) throw new Error("记忆数据库暂时不可用");
          memoryControl.tombstones.push(id);
        }
        async begin(source, raw) {
          const turn = { source, raw, finishes: 0 };
          memoryTurns.push(turn);
          return {
            context: "历史偏好",
            finish: async () => {
              turn.finishes++;
            }
          };
        }
      }
    },
    nanoid: { nanoid: () => `id-${++sequence}` },
    "./model-history": { assistantHistory: message => (message.content ? [{ role: "assistant", content: message.content }] : []) },
    "../../presentation/window-session": { detachedSession: undefined },
    "./message-timeline": {
      appendMessageText: (message, text) => {
        message.content += text;
      }
    },
    "../ai-error": { describeAiError: error => error.message },
    "../runtime/agent": {
      runAiAgent: options =>
        new Promise(resolve => {
          runs.push({ options, finish: resolve });
        })
    },
    "../runtime/expert-team": {
      runExpertTeam: options =>
        new Promise(resolve => {
          runs.push({ options, team: true, finish: resolve });
        }),
      reviewExpertTeam: async (options, team, receipts) => {
        reviews.push({ options, receipts });
        team.reviewPending = false;
        team.status = "completed";
        options.events.onTeam(team);
      }
    },
    "../runtime/expert-roles": expertRoles,
    "./attachments": {
      composeUserContent: text => text,
      hydrateMessageImages() {},
      imagePlaceholder: () => "image",
      releaseMessageImages() {},
      selectRequestImageIds: () => new Set(),
      serializeMessagesForPersist: messages => ({ messages, unsavedImages: 0 })
    },
    "../host": { getAiAssistantHost: () => host, tryGetAiAssistantHost: () => host },
    "../provider/providerConfig": {
      getActiveProfile: value => value.profiles[0],
      getPermissionMode: value => value.permissionMode,
      loadAiProviderSettings: () => JSON.parse(JSON.stringify(settings)),
      saveAiProviderSettings: value => {
        settings = JSON.parse(JSON.stringify(value));
      }
    },
    "../changes/proposal": { createTextProposalFallback: () => undefined, normalizeOperations: operations => operations },
    "../skills": { resolveActiveSkills: () => [] },
    "./context": conversationContext,
    "./history-digest": historyDigest,
    "../changes/rollback": { rollbackOperations: async () => ({ reverted: 0, skipped: [] }) }
  };
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/conversation/store.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(
    name => {
      assert.ok(name in mocks, `未声明依赖 ${name}`);
      return mocks[name];
    },
    mod,
    mod.exports
  );
  Pinia.setActivePinia(Pinia.createPinia());
  if (existingHostStore) Pinia.defineStore("aiAssistant", () => ({ loadProject() {}, createConversation: () => ({ id: "legacy" }) }))();
  const store = mod.exports.useAiAssistantStore();
  store.loadProject("project-1");
  t.after(() => runs.forEach(run => run.finish()));
  return { store, runs, reviews, memoryTurns, memoryControl, host, settings: () => settings };
}

test("未显式引用时不捕获当前图表或文本，普通助手、专家与专家团均发送项目范围正文", async t => {
  for (const strategy of ["assistant", "expert:semantics", "sysml-team"]) {
    const { store, runs, host } = runtime(t);
    let captures = 0;
    host.context = {
      capture: () => {
        captures++;
        return {
          diagram: { id: "visible-diagram", name: "当前界面图表" },
          textNamespace: { id: "visible-text", name: "当前文本页" }
        };
      }
    };
    store.setExecutionStrategy(strategy);
    const pending = store.sendMessage("检查整个项目的模型关系");
    assert.equal(captures, 0);
    assert.equal(store.messages[0].context, undefined);
    assert.deepEqual(runs[0].options.messages, [{ role: "user", content: "检查整个项目的模型关系" }]);
    runs[0].finish();
    await pending;
  }
});

test("后台会话遥测写回发起会话，切换后不污染当前会话", async t => {
  const { store, runs } = runtime(t);
  const first = store.createConversation();
  const pending = store.sendMessage("分析模型");
  const second = store.createConversation();
  const metrics = { modelMs: 100, toolMs: 20, firstTokenMsTotal: 10, firstTokenCount: 1, generationMs: 80, timedOutputTokens: 40 };
  const contextUsage = { model: "test-model", contextLength: 1000, inputTokens: 300, systemTokens: 100, toolTokens: 100, messageTokens: 100 };
  runs[0].options.events.onMetrics(metrics);
  runs[0].options.events.onContextUsage(contextUsage);
  runs[0].options.events.onTextDelta("最终回复");
  runs[0].finish();
  await pending;
  assert.equal(store.activeConversationId, second.id);
  assert.equal(store.messages.length, 0);
  const saved = store.conversations.find(item => item.id === first.id).messages.at(-1);
  assert.deepEqual(saved.metrics, metrics);
  assert.deepEqual(saved.contextUsage, contextUsage);
  assert.ok(saved.durationMs >= 0);
});

test("历史自动界面快照不再注入请求，显式 @ 引用正文原样保留", async t => {
  const { store, runs } = runtime(t);
  const conversation = store.createConversation();
  const oldContext = {
    selection: [{ id: "old-selection", title: "旧选中项", type: "PartDefinition" }],
    diagram: { id: "old-diagram", name: "旧界面图表" },
    textNamespace: { id: "old-text", name: "旧文本页" }
  };
  conversation.messages = [{ id: "old-user", role: "user", content: "看一下模型", context: oldContext, toolCalls: [], createdAt: 1 }];
  const text = "检查 @[电气系统](selected-model-id) 的关系";
  const pending = store.sendMessage(text);
  assert.deepEqual(runs[0].options.messages, [
    { role: "user", content: "看一下模型" },
    { role: "user", content: text }
  ]);
  assert.deepEqual(store.messages[0].context, oldContext);
  assert.equal(store.messages[1].content, text);
  assert.equal(store.messages[1].context, undefined);
  runs[0].finish();
  await pending;
});

test("记忆只从外层真实用户正文捕获，普通及专家轮次均一次且附件不成为来源", async t => {
  for (const team of [false, true]) {
    const { store, runs, memoryTurns } = runtime(t);
    store.memoryState.enabled = true;
    const conversation = store.createConversation();
    if (team) store.setExecutionStrategy("sysml-team");
    const pending = store.sendMessage("我偏好简洁回答", {
      attachments: [{ id: "a", kind: "text", name: "外部.txt", content: "外部资料不是用户偏好" }]
    });
    while (!runs.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(memoryTurns.length, 1);
    assert.equal(memoryTurns[0].raw, "我偏好简洁回答");
    assert.equal(memoryTurns[0].source.conversationId, conversation.id);
    assert.equal(runs[0].options.memoryContext, "历史偏好");
    assert.equal(runs[0].options.permissionMode, "proposal");
    assert.equal(memoryTurns[0].finishes, 0);
    runs[0].finish();
    await pending;
    assert.equal(memoryTurns[0].finishes, 1);
  }
});

test("关闭记忆时不捕获不召回，项目切换和停止后不启动提取", async t => {
  const { store, runs, memoryTurns } = runtime(t);
  const first = store.sendMessage("普通消息");
  assert.equal(memoryTurns.length, 0);
  assert.equal(runs[0].options.memoryContext, undefined);
  runs[0].finish();
  await first;
  store.memoryState.enabled = true;
  const second = store.sendMessage("我偏好中文回答");
  while (runs.length < 2) await new Promise(resolve => setImmediate(resolve));
  store.loadProject("other");
  runs[1].finish();
  await second;
  assert.equal(memoryTurns[0].finishes, 0);
});

test("曾启用记忆时数据库故障不能跳过来源墓碑宣称删除成功，首次不支持存储仍可删聊天", async t => {
  const { store, runs, memoryControl } = runtime(t);
  const task = store.sendMessage("一条用户消息");
  const id = store.activeConversationId;
  store.memoryState = { ...store.memoryState, contextKey: "identity-and-project", enabled: true, available: false };
  memoryControl.failure = true;
  await store.deleteConversation(id);
  assert.equal(runs[0].options.signal.aborted, true);
  assert.equal(
    store.conversations.some(item => item.id === id),
    true
  );
  assert.match(store.errorMessage, /记忆数据库暂时不可用/);
  assert.ok(memoryControl.cancellations > 0);
  memoryControl.failure = false;
  await store.deleteConversation(id);
  assert.deepEqual(memoryControl.tombstones, [id]);
  assert.equal(
    store.conversations.some(item => item.id === id),
    false
  );
  runs[0].finish();
  await task;
  const initial = runtime(t);
  const next = initial.store.createConversation();
  initial.store.memoryState = { ...initial.store.memoryState, enabled: false, available: false };
  initial.memoryControl.failure = true;
  initial.memoryControl.unsupported = true;
  await initial.store.deleteConversation(next.id);
  assert.equal(
    initial.store.conversations.some(item => item.id === next.id),
    false
  );
});

test("删除等待墓碑期间切换项目仍完成原项目删除，不删除或重写新项目会话", async t => {
  const { store, memoryControl, settings } = runtime(t);
  const original = store.createConversation();
  let release;
  memoryControl.wait = new Promise(resolve => {
    release = resolve;
  });
  const deletion = store.deleteConversation(original.id);
  store.loadProject("new-project");
  const current = store.createConversation();
  const before = structuredClone(settings().conversationsByProject["new-project"]);
  release();
  await deletion;
  assert.equal(
    store.conversations.some(item => item.id === current.id),
    true
  );
  assert.deepEqual(settings().conversationsByProject["new-project"], before);
  assert.equal(
    settings().conversationsByProject["project-1"].some(item => item.id === original.id),
    false
  );
  assert.equal(store.activeConversationId, current.id);
});

test("不同会话并行运行，停止与结束只影响所属会话", async t => {
  const { store, runs } = runtime(t);
  const first = store.sendMessage("第一条独立任务");
  const firstId = store.activeConversationId;
  store.createConversation();
  assert.equal(store.isRunning, false);
  const second = store.sendMessage("第二条独立任务");
  assert.equal(runs.length, 2);
  assert.equal(
    runs[1].options.messages.some(message => String(message.content).includes("第一条")),
    false
  );
  store.stop();
  assert.equal(runs[0].options.signal.aborted, false);
  assert.equal(runs[1].options.signal.aborted, true);
  runs[1].finish();
  await second;
  store.selectConversation(firstId);
  assert.equal(store.isRunning, true);
  runs[0].options.events.onError("仅第一条失败");
  runs[0].finish();
  await first;
  store.createConversation();
  assert.equal(store.errorMessage, "");
  store.selectConversation(firstId);
  assert.equal(store.errorMessage, "仅第一条失败");
});

test("切换会话不停止后台任务，消息与卡片写回原会话", async t => {
  const { store, runs, settings } = runtime(t);
  const destination = store.createConversation().id;
  const origin = store.createConversation().id;
  const pending = store.sendMessage("创建电脑模型");
  store.selectConversation(destination);
  assert.equal(runs[0].options.signal.aborted, false);
  assert.equal(store.isRunning, false);
  assert.ok(store.runningConversationIds.includes(origin));
  runs[0].options.events.onTextDelta("模型已创建");
  runs[0].options.events.onChoicePrompt({ id: "choice", question: "下一步？", status: "pending" });
  runs[0].finish();
  await pending;
  assert.equal(store.activeConversationId, destination);
  assert.equal(store.messages.length, 0);
  const saved = settings().conversationsByProject["project-1"].find(item => item.id === origin);
  assert.equal(saved.messages[1].content, "模型已创建");
  assert.equal(saved.messages[1].choicePrompt.id, "choice");
  store.selectConversation(origin);
  assert.equal(store.messages[1].content, "模型已创建");
  assert.equal(store.isRunning, false);
});

test("新建会话保留原任务，显式停止仍中止任务", async t => {
  const { store, runs } = runtime(t);
  const pending = store.sendMessage("创建模型");
  const origin = store.activeConversationId;
  store.createConversation();
  assert.equal(runs[0].options.signal.aborted, false);
  store.stop();
  assert.equal(runs[0].options.signal.aborted, false);
  store.selectConversation(origin);
  store.stop();
  assert.equal(runs[0].options.signal.aborted, true);
  runs[0].finish();
  await pending;
});

test("后台空回复从原会话清理，不影响当前会话", async t => {
  const { store, runs, settings } = runtime(t);
  const pending = store.sendMessage("创建模型");
  const origin = store.activeConversationId;
  const destination = store.createConversation().id;
  runs[0].finish();
  await pending;
  const saved = settings().conversationsByProject["project-1"].find(item => item.id === origin);
  assert.equal(saved.messages.length, 1);
  assert.equal(store.activeConversationId, destination);
  assert.equal(store.messages.length, 0);
});

test("超过会话上限时不会淘汰仍在运行的会话", async t => {
  const { store, runs, settings } = runtime(t);
  const pending = store.sendMessage("创建模型");
  const origin = store.activeConversationId;
  for (let index = 0; index < 12; index++) store.createConversation();
  assert.ok(store.conversations.some(item => item.id === origin));
  assert.ok(settings().conversationsByProject["project-1"].some(item => item.id === origin));
  runs[0].options.events.onTextDelta("完成");
  runs[0].finish();
  await pending;
  assert.equal(settings().conversationsByProject["project-1"].find(item => item.id === origin).messages[1].content, "完成");
});

test("删除其他会话不影响任务，删除运行会话才停止", async t => {
  const { store, runs } = runtime(t);
  const other = store.createConversation().id;
  const origin = store.createConversation().id;
  const pending = store.sendMessage("创建模型");
  await store.deleteConversation(other);
  assert.equal(runs[0].options.signal.aborted, false);
  await store.deleteConversation(origin);
  assert.equal(runs[0].options.signal.aborted, true);
  runs[0].finish();
  await pending;
  assert.equal(
    store.conversations.some(item => item.id === origin),
    false
  );
});

test("切换项目仍停止任务，最终收据留在原项目", async t => {
  const { store, runs, settings } = runtime(t);
  const pending = store.sendMessage("创建模型");
  const origin = store.activeConversationId;
  store.loadProject("project-2");
  assert.equal(runs[0].options.signal.aborted, true);
  runs[0].options.events.onTextDelta("已提交的改动保留");
  runs[0].finish();
  await pending;
  assert.equal(store.messages.length, 0);
  assert.equal(settings().conversationsByProject["project-1"].find(item => item.id === origin).messages[1].content, "已提交的改动保留");
});

test("后台任务错误不覆盖当前会话的错误提示", async t => {
  const { store, runs } = runtime(t);
  const pending = store.sendMessage("创建模型");
  store.createConversation();
  runs[0].options.events.onError("原会话请求失败");
  assert.equal(store.errorMessage, "");
  runs[0].finish();
  await pending;
});

test("切换会话期间的提案自动修正继续留在原会话", async t => {
  const { store, runs, host, settings } = runtime(t);
  let rejectExecution;
  let attempts = 0;
  host.proposalExecutor = {
    execute: () => {
      attempts++;
      if (attempts === 1)
        return new Promise((_resolve, reject) => {
          rejectExecution = reject;
        });
      return Promise.resolve("已修正");
    }
  };
  const destination = store.createConversation().id;
  const origin = store.createConversation().id;
  const pending = store.sendMessage("创建模型");
  const proposal = id => ({ id, status: "pending", operations: [{ id: `${id}-op`, type: "create-element", summary: "创建模块" }] });
  runs[0].options.events.onTextDelta("准备创建");
  runs[0].options.events.onProposal(proposal("first"));
  runs[0].finish();
  await pending;
  const execution = store.executeProposal(store.messages[1].id, true);
  store.selectConversation(destination);
  rejectExecution(new Error("创建失败"));
  for (let index = 0; index < 20 && runs.length < 2; index++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs.length, 2);
  assert.equal(store.activeConversationId, destination);
  assert.ok(store.runningConversationIds.includes(origin));
  assert.equal(store.messages.length, 0);
  runs[1].options.events.onTextDelta("已修正并执行");
  runs[1].options.events.onProposal(proposal("repair"));
  runs[1].finish();
  await execution;
  assert.equal(attempts, 2);
  assert.equal(store.messages.length, 0);
  const saved = settings().conversationsByProject["project-1"].find(item => item.id === origin);
  assert.equal(saved.messages[3].proposal.status, "completed");
  assert.match(saved.messages[2].content, /自动修正第 1 次/);
});

test("提案确认前无专家回读，实际提交之后使用收据检查", async t => {
  const { store, runs, reviews, host } = runtime(t);
  let writes = 0;
  host.proposalExecutor = {
    execute: async () => {
      writes++;
      return "created real-id";
    }
  };
  store.setExecutionStrategy("sysml-team");
  const pending = store.sendMessage("创建模型");
  runs[0].options.events.onTeam({
    id: "team",
    profileId: "provider",
    model: "test-model",
    status: "waiting-approval",
    reviewPending: true,
    members: []
  });
  runs[0].options.events.onProposal({
    id: "p",
    status: "pending",
    operations: [{ id: "op", type: "create-element", status: "pending", summary: "创建模块" }]
  });
  runs[0].finish();
  await pending;
  assert.equal(writes, 0);
  assert.equal(reviews.length, 0);
  await store.executeProposal(store.messages[1].id, true);
  assert.equal(writes, 1);
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].receipts, /created real-id/);
  assert.equal(reviews[0].options.permissionMode, "chat");
  assert.equal(store.messages[1].team.status, "completed");
});

test("项目切换中等待在途提案收据，不再提交后续操作，也不启动专家检查", async t => {
  const { store, runs, reviews, host, settings } = runtime(t);
  let settle;
  let writes = 0;
  host.proposalExecutor = {
    execute: () => {
      writes++;
      return new Promise(resolve => {
        settle = resolve;
      });
    }
  };
  store.setExecutionStrategy("sysml-team");
  const pending = store.sendMessage("创建模型");
  const origin = store.activeConversationId;
  runs[0].options.events.onTeam({
    id: "team",
    profileId: "provider",
    model: "test-model",
    status: "waiting-approval",
    reviewPending: true,
    members: []
  });
  runs[0].options.events.onProposal({
    id: "p",
    status: "pending",
    operations: [1, 2].map(n => ({ id: `op-${n}`, type: "create-element", status: "pending", summary: "创建模块" }))
  });
  runs[0].finish();
  await pending;
  const execution = store.executeProposal(store.messages[1].id, true);
  assert.equal(store.isRunning, true);
  store.loadProject("project-2");
  settle("真实在途收据 real-id");
  await execution;
  assert.equal(writes, 1);
  assert.equal(reviews.length, 0);
  const message = settings().conversationsByProject["project-1"].find(item => item.id === origin).messages[1];
  assert.equal(message.proposal.operations[0].result, "真实在途收据 real-id");
  assert.equal(message.proposal.operations[1].status, "failed");
});

test("专家团按会话保存，后台状态回写原会话，运行中禁止切换策略", async t => {
  const { store, runs, settings } = runtime(t);
  store.setExecutionStrategy("sysml-team");
  const origin = store.activeConversationId;
  assert.equal(settings().conversationsByProject["project-1"][0].strategy, "sysml-team");
  const pending = store.sendMessage("创建电脑BDD");
  assert.equal(runs[0].team, true);
  store.setExecutionStrategy("assistant");
  assert.equal(store.conversations.find(item => item.id === origin).strategy, "sysml-team");
  const other = store.createConversation().id;
  store.setExecutionStrategy("assistant");
  runs[0].options.events.onTeam({ id: "team", status: "running", members: [] });
  assert.equal(store.messages.length, 0);
  runs[0].finish();
  await pending;
  store.selectConversation(origin);
  assert.equal(store.messages[1].team.id, "team");
  store.loadProject("project-2");
  store.loadProject("project-1");
  assert.equal(store.conversations.find(item => item.id === origin).messages[1].team.status, "interrupted");
  store.selectConversation(other);
  const normal = store.sendMessage("只读问答");
  assert.equal(runs[1].team, undefined);
  runs[1].finish();
  await normal;
});

test("五位专家可独立选择，恢复后单独运行并保留聊天、提案及编辑权限", async t => {
  for (const expert of expertRoles.SYSML_EXPERTS) {
    for (const permissionMode of ["chat", "proposal", "edit"]) {
      const { store, runs, settings } = runtime(t);
      const strategy = `expert:${expert.role}`;
      store.setExecutionStrategy(strategy);
      const id = store.activeConversationId;
      store.setConversationOptions({ permissionMode });
      assert.equal(settings().conversationsByProject["project-1"].find(item => item.id === id).strategy, strategy);
      store.loadProject("project-2");
      store.loadProject("project-1");
      store.selectConversation(id);
      assert.equal(store.conversations.find(item => item.id === id).strategy, strategy);
      const pending = store.sendMessage("请根据你的专长处理当前建模任务");
      assert.equal(runs.length, 1);
      assert.equal(runs[0].team, undefined);
      assert.equal(runs[0].options.permissionMode, permissionMode);
      assert.equal(runs[0].options.expertTask.readOnly, false);
      assert.ok(runs[0].options.expertTask.instructions.includes(expert.name));
      assert.ok(runs[0].options.expertTask.instructions.includes(expert.description));
      store.setExecutionStrategy("sysml-team");
      assert.equal(store.conversations.find(item => item.id === id).strategy, strategy);
      runs[0].options.events.onTextDelta(`${expert.name}的回答`);
      runs[0].finish();
      await pending;
      assert.equal(store.messages.at(-1).content, `${expert.name}的回答`);
      assert.equal(store.messages.at(-1).team, undefined);
    }
  }
});

test("未知专家策略被拒绝，普通助手不带专家角色指令", async t => {
  const { store, runs } = runtime(t);
  for (const value of ["expert:unknown", "lead", "expert:", null, {}, "sysml-team-extra"]) {
    store.setExecutionStrategy(value);
  }
  assert.equal(store.conversations.length, 0);
  store.setExecutionStrategy("expert:semantics");
  store.setExecutionStrategy("expert:unknown");
  assert.equal(store.conversations[0].strategy, "expert:semantics");
  store.setExecutionStrategy("assistant");
  const pending = store.sendMessage("普通问答");
  assert.equal(runs[0].options.expertTask, undefined);
  assert.equal(runs[0].team, undefined);
  runs[0].finish();
  await pending;
});

test("超过消息上限的旧消息折成摘要而不是静默丢失", t => {
  const { store, settings } = runtime(t);
  const id = store.createConversation().id;
  const conversation = store.conversations.find(item => item.id === id);
  conversation.messages = Array.from({ length: 46 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 ? "assistant" : "user",
    content: index === 0 ? "原始目标：创建发动机 id=97518092302402688" : `第 ${index} 条消息`,
    toolCalls:
      index === 1
        ? [{ id: "c1", name: "model_apply_changes", input: {}, state: "done", output: "已执行 1 项改动：id=97518092302402689" }]
        : [],
    createdAt: index
  }));
  store.persistConversations();
  assert.equal(conversation.messages.length, 40);
  assert.match(conversation.digest ?? "", /97518092302402688/);
  assert.match(conversation.digest ?? "", /97518092302402689/);
  const saved = settings().conversationsByProject["project-1"].find(item => item.id === id);
  assert.match(saved.digest ?? "", /97518092302402688/);
});

test("停靠持久化后，消息区域始终读取所选会话的最新消息数组", t => {
  const { store } = runtime(t);
  const first = store.createConversation().id;
  const firstConversation = store.conversations.find(item => item.id === first);
  firstConversation.messages = [{ id: "first-user", role: "user", content: "会话一", toolCalls: [], createdAt: Date.now() }];
  assert.equal(store.messages[0]?.content, "会话一");
  store.persistConversations();
  assert.equal(store.messages, firstConversation.messages);

  const second = store.createConversation().id;
  const secondConversation = store.conversations.find(item => item.id === second);
  secondConversation.messages = [{ id: "second-user", role: "user", content: "会话二", toolCalls: [], createdAt: Date.now() }];
  store.persistConversations();
  store.selectConversation(first);
  assert.equal(store.messages[0].content, "会话一");
  store.selectConversation(second);
  assert.equal(store.messages[0].content, "会话二");
  secondConversation.messages = [
    ...secondConversation.messages,
    { id: "second-reply", role: "assistant", content: "最新回复", toolCalls: [] }
  ];
  assert.equal(store.messages[1].content, "最新回复");
});

test("草稿附件与请求选项独立保存，每轮使用所属会话的配置", async t => {
  const { store, runs } = runtime(t);
  const first = store.createConversation().id;
  store.setConversationOptions({ model: "model-a", effort: "high", permissionMode: "chat" });
  store.setDraft(first, {
    html: "第一条 /skill",
    attachments: [{ id: "file-a", name: "a.txt", kind: "text" }],
    notice: "a",
    scrollTop: 10
  });
  const second = store.createConversation().id;
  store.setConversationOptions({ model: "model-b", effort: "low", permissionMode: "proposal" });
  store.setDraft(second, { html: "第二条", attachments: [], notice: "", scrollTop: 0 });
  const pendingB = store.sendMessage("B");
  store.selectConversation(first);
  const pendingA = store.sendMessage("A");
  assert.equal(runs[0].options.profile.model, "model-b");
  assert.equal(runs[1].options.profile.model, "model-a");
  assert.equal(runs[1].options.permissionMode, "chat");
  assert.equal(store.drafts[first].attachments[0].id, "file-a");
  assert.equal(store.drafts[second].html, "第二条");
  store.setConversationOptions({ model: "model-c" });
  assert.equal(runs[1].options.profile.model, "model-a");
  runs.forEach(run => run.finish());
  await Promise.all([pendingA, pendingB]);
});

test("超过历史上限的并发任务全部保留，旧项目结束不清除新项目运行态", async t => {
  const { store, runs, settings } = runtime(t);
  const pending = [];
  for (let index = 0; index < 10; index++) {
    store.createConversation();
    pending.push(store.sendMessage(`任务 ${index}`));
  }
  assert.equal(store.runningConversationIds.length, 10);
  assert.equal(settings().conversationsByProject["project-1"].length, 10);
  store.loadProject("project-2");
  assert.equal(
    runs.every(run => run.options.signal.aborted),
    true
  );
  const next = store.sendMessage("新项目任务");
  runs.slice(0, 10).forEach(run => run.finish());
  await Promise.all(pending);
  assert.equal(store.isRunning, true);
  assert.equal(runs[10].options.signal.aborted, false);
  runs[10].finish();
  await next;
});

test("跳过追问只继续一次，不生成偏好答案或提取记忆", async t => {
  const { store, runs, memoryTurns } = runtime(t);
  const initial = store.sendMessage("帮我建立模型");
  runs[0].options.events.onTextDelta("请选择模型结构");
  runs[0].options.events.onChoicePrompt({
    id: "choice",
    question: "希望什么结构？",
    options: [],
    allowCustomInput: false,
    status: "pending"
  });
  runs[0].finish();
  await initial;
  const message = store.messages.find(item => item.choicePrompt);
  store.memoryState.enabled = true;
  const continuation = store.answerChoicePrompt(message.id, "choice", null);
  assert.equal(message.choicePrompt.status, "skipped");
  assert.equal(message.choicePrompt.answer, undefined);
  await store.answerChoicePrompt(message.id, "choice", null);
  assert.equal(runs.length, 2);
  assert.equal(memoryTurns.length, 0);
  assert.match(store.messages.at(-2).content, /跳过/);
  runs[1].finish();
  await continuation;
});

test("宿主保留旧版同名 store 时，插件仍使用当前版本并可切换模式", t => {
  const { store } = runtime(t, true);
  const first = store.createConversation().id;
  store.setConversationOptions({ permissionMode: "chat" });
  assert.equal(store.conversations.find(item => item.id === first).options.permissionMode, "chat");
  const second = store.createConversation().id;
  store.setConversationOptions({ permissionMode: "edit" });
  store.selectConversation(first);
  assert.equal(store.conversations.find(item => item.id === first).options.permissionMode, "chat");
  assert.equal(store.conversations.find(item => item.id === second).options.permissionMode, "edit");
});
