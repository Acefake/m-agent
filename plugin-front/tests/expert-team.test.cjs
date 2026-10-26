const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function runtime(handler) {
  let sequence = 0;
  const calls = [];
  const roles = { exports: {} };
  const roleCode = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/runtime/expert-roles.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  new Function("exports", roleCode)(roles.exports);
  const mocks = {
    "./expert-roles": roles.exports,
    nanoid: { nanoid: () => `team-${++sequence}` },
    "./agent": { runAiAgent: async options => { calls.push(options); await handler(options, calls.length); } }
  };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/runtime/expert-team.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  new Function("require", "module", "exports", code)(name => { assert.ok(name in mocks, name); return mocks[name]; }, module, module.exports);
  return { ...module.exports, calls };
}

function options(mode = "proposal") {
  const observed = { snapshots: [], errors: [], text: "", tools: [], usage: [] };
  return {
    observed,
    profile: { id: "p", model: "fixed-model", apiKey: "secret-not-for-history" },
    messages: [{ role: "assistant", content: "older history" }, { role: "user", content: "创建电脑系统BDD，已有容器ID=root" }],
    permissionMode: mode,
    events: {
      onTeam: team => observed.snapshots.push(team),
      onTextDelta: text => { observed.text += text; }, onReasoningDelta() {},
      onToolCallStart: call => observed.tools.push(call), onToolCallEnd() {},
      onProposal: proposal => { observed.proposal = proposal; }, onPlan() {}, onChoicePrompt: prompt => { observed.choice = prompt; },
      onUsage: usage => observed.usage.push(usage), onError: error => observed.errors.push(error), onFinish() {}
    }
  };
}

const plan = tasks => JSON.stringify({ tasks });
const task = (role, dependsOn = [], required = true) => ({ role, task: `${role}分析目标与返回证据`, dependsOn, required });
const reply = (call, text) => { call.events.onTextDelta(text); call.events.onUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12, latestInputTokens: 10 }); };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("专家遥测累计每位成员一次，最近上下文来自实际请求", async () => {
  const snapshots = [], contexts = [];
  const api = runtime(async (call, index) => {
    call.events.onMetrics({ modelMs: index * 10, toolMs: index, firstTokenMsTotal: index * 2, firstTokenCount: 1, generationMs: 10, timedOutputTokens: 2 });
    call.events.onContextUsage({ model: "fixed-model", contextLength: 1000, systemTokens: index, toolTokens: 10, messageTokens: 20, inputTokens: 40 });
    reply(call, index === 1 ? plan([]) : index === 2 ? '{"approved":true,"summary":"可以交付"}' : "负责人最终回复");
  });
  const run = options();
  run.events.onMetrics = value => snapshots.push(value);
  run.events.onContextUsage = value => contexts.push(value);
  await api.runExpertTeam(run);
  assert.deepEqual(snapshots.at(-1), { modelMs: 60, toolMs: 6, firstTokenMsTotal: 12, firstTokenCount: 3, generationMs: 30, timedOutputTokens: 6 });
  assert.equal(contexts.length, 3);
  assert.equal(contexts.at(-1).systemTokens, 3);
  assert.equal(run.observed.snapshots.at(-1).members.filter(member => member.metrics).length, 3);
});

test("真实分开的专家调用并发启动，依赖等待结果，只有负责人输出正文，统计不混淆上下文", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = 0;
  const api = runtime(async (call, index) => {
    if (index === 1) return reply(call, plan([task("requirements"), task("semantics"), task("layout", ["semantics"])]));
    if (index === 2 || index === 3) { started++; await gate; }
    if (call.expertTask.instructions.includes("仅输出 JSON")) return reply(call, '{"approved":true,"summary":"可以交付"}');
    reply(call, call.expertTask.readOnly ? "各自的只读报告" : "负责人最终交付");
  });
  const run = options();
  const pending = api.runExpertTeam(run);
  await tick();
  assert.equal(started, 2);
  assert.equal(api.calls.length, 3);
  assert.notEqual(api.calls[1].messages, api.calls[2].messages);
  assert.equal(api.calls[1].messages.some(message => message.content === "older history"), false);
  release();
  await pending;
  assert.equal(api.calls.length, 6);
  assert.match(JSON.stringify(api.calls[3].messages), /各自的只读报告/);
  assert.equal(run.observed.text, "负责人最终交付");
  assert.deepEqual(run.observed.errors, []);
  assert.equal(run.observed.snapshots.at(-1).status, "completed");
  assert.equal(run.observed.usage.at(-1).totalTokens, 72);
  assert.equal(run.observed.usage.at(-1).latestInputTokens, 10);
  assert.equal(JSON.stringify(run.observed.snapshots).includes("secret-not-for-history"), false);
  assert.ok(api.calls.slice(0, -1).every(call => call.expertTask.readOnly));
});

test("调度计划拒绝循环、缺失依赖、重复角色和递归角色", () => {
  const api = runtime(async () => {});
  for (const tasks of [[task("lead")], [task("layout", ["semantics"])], [task("layout"), task("layout")], [task("layout", ["semantics"]), task("semantics", ["layout"])], [task("requirements"), task("semantics"), task("layout"), task("checker")]]) {
    assert.throws(() => api.parseExpertPlan(plan(tasks)));
  }
  assert.deepEqual(api.parseExpertPlan('```json\n{"tasks":[]}\n```'), []);
});

test("必需专家失败时阻止检查及交付；辅助失败可继续并带上限制", async () => {
  for (const required of [true, false]) {
    const api = runtime(async (call, index) => {
      if (index === 1) return reply(call, plan([task("semantics", [], required)]));
      if (index === 2) return call.events.onError("语义服务不可用");
      reply(call, call.expertTask.readOnly ? '{"approved":true,"summary":"披露未检查项"}' : "存在辅助失败");
    });
    const run = options();
    await api.runExpertTeam(run);
    assert.equal(api.calls.length, required ? 2 : 4);
    assert.equal(run.observed.snapshots.at(-1).status, required ? "error" : "completed");
    if (!required) assert.match(JSON.stringify(api.calls.at(-1).messages), /语义服务不可用/);
  }
});

test("停止会传播至全部活动成员，排队依赖不会执行", async () => {
  const api = runtime(async (call, index) => {
    if (index === 1) return reply(call, plan([task("requirements"), task("semantics"), task("layout", ["semantics"])]));
    await new Promise(resolve => call.signal.addEventListener("abort", resolve, { once: true }));
  });
  const run = options();
  const controller = new AbortController();
  run.signal = controller.signal;
  const pending = api.runExpertTeam(run);
  await tick();
  controller.abort();
  await pending;
  assert.equal(api.calls.length, 3);
  assert.ok(api.calls.slice(1).every(call => call.signal.aborted));
  assert.equal(run.observed.snapshots.at(-1).status, "cancelled");
});

test("提案确认前不检查执行结果，确认后必须真回读；工具ID隔离且缺用量保持未知", async () => {
  const api = runtime(async (call, index) => {
    if (index === 1) return reply(call, plan([]));
    if (index === 2) return reply(call, '{"approved":true,"summary":"方案可执行"}');
    if (index === 3) {
      call.events.onProposal({ id: "proposal", operations: [], status: "pending" });
      return reply(call, "等待确认");
    }
    call.events.onToolCallStart({ id: "reused-id", name: "model_get_element", input: { elementId: "new-model" } });
    call.events.onToolCallEnd({ id: "reused-id", output: "真实模型" });
    reply(call, '{"approved":true,"summary":"已读回"}');
  });
  const run = options();
  await api.runExpertTeam(run);
  const team = run.observed.snapshots.at(-1);
  assert.equal(api.calls.length, 3);
  assert.equal(team.status, "waiting-approval");
  assert.equal(team.reviewPending, true);
  await api.reviewExpertTeam(run, team, "模型创建真实收据");
  assert.equal(team.status, "completed");
  assert.match(team.members.at(-1).toolCalls[0].id, /^team-.*\/team-.*\/reused-id$/);
  const noRead = runtime(async call => reply(call, '{"approved":true,"summary":"假称通过"}'));
  team.reviewPending = true;
  await noRead.reviewExpertTeam(run, team, "receipt");
  assert.equal(team.status, "error");
  assert.match(run.observed.errors.at(-1), /未回读模型/);
});

test("编辑模式交付后检查，缺用量不伪造零值", async () => {
  const api = runtime(async (call, index) => {
    if (index === 1) return reply(call, plan([]));
    if (index === 2) return reply(call, '{"approved":true,"summary":"可执行"}');
    if (index === 3) {
      call.events.onToolCallStart({ id: "same", name: "model_apply_changes", input: {} });
      call.events.onToolCallEnd({ id: "same", output: "写入成功 model-id" });
      return reply(call, "已提交");
    }
    call.events.onToolCallStart({ id: "same", name: "model_get_element", input: {} });
    call.events.onToolCallEnd({ id: "same", output: "读回模型" });
    call.events.onTextDelta('{"approved":true,"summary":"已读回目标模型"}');
  });
  const run = options("edit");
  await api.runExpertTeam(run);
  const team = run.observed.snapshots.at(-1);
  assert.equal(api.calls.length, 4);
  assert.equal(team.status, "completed");
  assert.equal(team.reviewPending, false);
  assert.equal(run.observed.usage.at(-1).totalTokens, undefined);
  assert.notEqual(team.members.at(-1).toolCalls[0].id, run.observed.tools[0].id);
});
