const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const { createOpenAICompatible } = require("@ai-sdk/openai-compatible");
const ai = require("ai");
function load(file) {
  const code = ts.transpileModule(fs.readFileSync(require.resolve(file), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(
    name =>
      name === "ai"
        ? ai
        : name === "./context-compaction"
          ? load("../src/ai-assistant/runtime/context-compaction.ts")
          : name === "./session-compaction"
            ? load("../src/ai-assistant/runtime/session-compaction.ts")
            : require(name),
    mod, mod.exports
  );
  return mod.exports;
}
const { streamAgentWithContinuation, createRunMetrics } = load("../src/ai-assistant/runtime/agent-loop.ts");
const { assistantHistory } = load("../src/ai-assistant/conversation/model-history.ts");
const { compactToolResults } = load("../src/ai-assistant/runtime/context-compaction.ts");

test("new user turn compacts previous reads while preserving current values and write receipts", () => {
  const large = "id=97518092302402688\n" + "old details ".repeat(400);
  const result = (id, name, value) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type: "text", value } }] });
  const receipt = result("write", "model_apply_changes", "created elementId=97518092302402689");
  const history = [result("old", "model_get_tree", large), receipt, { role: "user", content: "continue" }, result("current", "model_get_properties", "propertyKey=name 当前值: exact")];
  const compact = compactToolResults(history);
  assert.ok(compact[0].content[0].output.value.length < large.length / 2);
  assert.match(compact[0].content[0].output.value, /97518092302402688/);
  assert.deepEqual(compact.slice(1), history.slice(1));
});

test("persisted reasoning is excluded from next-turn history without removing calls, receipts or final text", () => {
  const calls = { role: "assistant", content: [{ type: "reasoning", text: "internal".repeat(1000) }, { type: "tool-call", toolCallId: "write", toolName: "model_apply_changes", input: { elementId: "97518092302402688" } }] };
  const receipt = { role: "tool", content: [{ type: "tool-result", toolCallId: "write", toolName: "model_apply_changes", output: { type: "text", value: "created model-id" } }] };
  const final = { role: "assistant", content: "completed model-id" };
  const stored = JSON.stringify([calls, receipt, final]);
  const history = assistantHistory({ modelContext: stored, toolCalls: [], content: "" });
  assert.deepEqual(history, [{ ...calls, content: [calls.content[1]] }, receipt, final]);
  assert.equal(JSON.stringify([calls, receipt, final]), stored);
});
function fixture(reply) {
  const requests = [];
  const provider = createOpenAICompatible({
    name: "fixture",
    baseURL: "https://fixture.invalid/v1",
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const response = await reply(requests.length, body);
      const tool = response.tool;
      const delta = tool
        ? {
            tool_calls: [
              {
                index: 0,
                id: "call-" + requests.length,
                type: "function",
                function: { name: tool, arguments: JSON.stringify(response.input ?? { n: requests.length }) }
              }
            ]
          }
        : { content: response.text ?? "done" };
      const frame = (delta, finish_reason) => ({
        id: "chat-" + requests.length,
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
        usage: response.usage ?? { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      });
      return new Response(
        "data: " +
          JSON.stringify(frame(delta, null)) +
          "\n\ndata: " +
          JSON.stringify(frame({}, response.reason ?? (tool ? "tool_calls" : "stop"))) +
          "\n\ndata: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }
  });
  return { model: provider.chatModel("fixture"), requests };
}
const tool = execute => ai.tool({ inputSchema: ai.jsonSchema({ type: "object", additionalProperties: true }), execute });
async function run(f, tools, signal) {
  const parts = [];
  for await (const part of streamAgentWithContinuation({
    model: f.model,
    system: "test",
    messages: [{ role: "user", content: "build" }],
    tools,
    signal
  }))
    parts.push(part);
  return parts;
}
const terminal = parts => parts.filter(p => p.type === "run-state").at(-1).state;

test("live request and tool durations are published before a request finishes", () => {
  let clock = 0;
  const timing = createRunMetrics(() => clock);
  timing.startRequest();
  clock = 20; timing.token();
  clock = 50; const finish = timing.startTool();
  clock = 100;
  assert.equal(timing.snapshot().modelMs, 50);
  assert.equal(timing.snapshot().toolMs, 50);
  assert.equal(timing.snapshot().firstTokenMsTotal, 20);
  clock = 120; finish();
  clock = 200; timing.finishRequest(20);
  assert.equal(timing.snapshot().modelMs, 130);
  assert.equal(timing.snapshot().toolMs, 70);
});

test("a slow supplier publishes live timing and context before returning usage", { timeout: 5000 }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return { text: "done" }; });
  let live;
  const observed = new Promise(resolve => { live = resolve; });
  const contexts = [];
  const consuming = (async () => {
    for await (const part of streamAgentWithContinuation({
      model: f.model, system: "known system", messages: [{ role: "user", content: "test" }], tools: {},
      onMetrics: metrics => { if (metrics.modelMs > 0 && metrics.firstTokenCount === 0) live(metrics); },
      onContextEstimate: value => contexts.push(value)
    })) { /* Consume the request after releasing the supplier gate. */ }
  })();
  try {
    const metrics = await observed;
    assert.ok(metrics.modelMs > 0);
    assert.equal(metrics.toolMs, 0);
    assert.equal(contexts[0].inputTokens, undefined);
    assert.ok(contexts[0].systemTokens > 0);
  } finally { release(); await consuming; }
});

test("forced proposal preserves known cache totals and keeps missing cache usage unknown", async () => {
  for (const hasCache of [true, false]) {
    const f = fixture(() => ({ tool: "model_propose_changes", usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, ...(hasCache ? { prompt_tokens_details: { cached_tokens: 4 } } : {}) } }));
    const source = fs.readFileSync(require.resolve("../src/ai-assistant/runtime/agent.ts"), "utf8") + "\nexports.forced = requestProposalWithForcedTool;";
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const mod = { exports: {} };
    new Function("require", "module", "exports", code)(name => {
      if (name === "ai") return ai;
      if (name === "../provider/model") return { createAiLanguageModel: () => f.model };
      if (name === "./tools") return { createProposeChangesTool: () => tool(async () => "waiting") };
      if (name === "../changes/proposal") return { createChangeProposal: () => ({ id: "proposal" }) };
      if (name === "./session-compaction") return load("../src/ai-assistant/runtime/session-compaction.ts");
      if (name === "./agent-loop") return { createRunMetrics };
      return {};
    }, mod, mod.exports);
    const usage = [], context = [];
    await mod.exports.forced({ profile: { model: "fixture" }, messages: [{ role: "user", content: "create" }], assistantText: "proposal", previousUsage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 60 }, events: {
      onUsage: value => usage.push(value), onContextUsage: value => context.push(value),
      onToolCallStart() {}, onToolCallEnd() {}, onProposal() {}
    } });
    assert.ok(usage.length > 0);
    assert.equal(usage.at(-1).cachedInputTokens, hasCache ? 60 + 4 * f.requests.length : undefined);
    assert.equal(usage.at(-1).inputTokens, 100 + 10 * f.requests.length);
    assert.equal(context.at(-1).inputTokens, 10);
  }
});

test("request telemetry excludes overlapping tools from model time and weights only observed first tokens", () => {
  let clock = 0;
  const timing = createRunMetrics(() => clock);
  timing.startRequest();
  clock = 20; timing.token();
  clock = 50; const finishA = timing.startTool();
  clock = 70; const finishB = timing.startTool();
  clock = 100; finishA();
  clock = 120; finishB();
  clock = 200; timing.finishRequest(220);
  assert.deepEqual(timing.snapshot(), { modelMs: 130, toolMs: 100, firstTokenMsTotal: 20, firstTokenCount: 1, generationMs: 110, timedOutputTokens: 220 });
  timing.startRequest();
  clock = 300; timing.finishRequest();
  assert.equal(timing.snapshot().modelMs, 230);
  assert.equal(timing.snapshot().firstTokenCount, 1);
  assert.equal(timing.snapshot().timedOutputTokens, 220);
});

test("real request telemetry snapshots match the latest prepared prompt and provider input", async () => {
  const f = fixture(n => n === 1 ? { tool: "read" } : { text: "finished" });
  const contexts = [], timings = [];
  for await (const part of streamAgentWithContinuation({
    model: f.model, system: "known system", messages: [{ role: "user", content: "build" }],
    tools: { read: tool(async () => "result") },
    onMetrics: value => timings.push(value), onContextEstimate: value => contexts.push(value)
  })) { /* Consume the actual SDK stream. */ }
  assert.equal(contexts.length, 4);
  assert.equal(contexts[0].inputTokens, undefined);
  assert.equal(contexts[1].inputTokens, 10);
  assert.equal(contexts[2].inputTokens, undefined);
  assert.equal(contexts[3].inputTokens, 10);
  assert.ok(contexts[2].messageTokens > contexts[0].messageTokens);
  assert.ok(contexts[0].toolTokens > 0);
  assert.equal(timings.at(-1).firstTokenCount, 2);
  assert.equal(timings.at(-1).timedOutputTokens, 4);
  assert.ok(timings.at(-1).modelMs >= 0);
});
test("oversized property tables become catalogs while targeted values remain exact", () => {
  const value = "- 文档（propertyKey=Element-documentation）当前值: " + "长文档".repeat(6000) + "，类型: String";
  const result = { role: "tool", content: [{ type: "tool-result", toolCallId: "props", toolName: "model_get_properties", output: { type: "text", value } }] };
  const catalog = compactToolResults([result])[0].content[0].output.value;
  assert.match(catalog, /当前值未提供/);
  assert.match(catalog, /propertyKey=Element-documentation/);
  assert.ok(catalog.length < 200);
  const call = { role: "assistant", content: [{ type: "tool-call", toolCallId: "props", toolName: "model_get_properties", input: { elementId: "element-1", propertyNames: ["Element-documentation"] } }] };
  assert.equal(compactToolResults([call, result])[1].content[0].output.value, value);
  assert.equal(result.content[0].output.value, value);
});
test("real SDK continues beyond eight rounds, retaining receipts and summing usage", async () => {
  const f = fixture(n => (n <= 10 ? { tool: "read" } : { text: "finished" }));
  const parts = await run(f, { read: tool(async ({ n }) => "element-" + n) });
  assert.equal(f.requests.length, 11);
  assert.equal(terminal(parts).status, "finished");
  assert.equal(terminal(parts).modelSteps, 11);
  assert.equal(terminal(parts).continuations, 1);
  assert.ok(f.requests[8].messages.some(m => m.role === "tool" && m.content.includes("element-1")));
  assert.equal(parts.filter(p => p.type === "run-usage").at(-1).usage.totalTokens, 132);
  assert.equal(parts.filter(p => p.type === "run-usage").at(-1).usage.cachedInputTokens, undefined);
  const context = parts.filter(p => p.type === "model-context").at(-1).messages;
  assert.equal(context.filter(m => m.role === "tool").length, 10);
  assert.equal(assistantHistory({ modelContext: JSON.stringify(context), toolCalls: [], content: "" }).length, context.length);
});
test("choice and approval pause immediately rather than call the model again", async () => {
  for (const name of ["ask_user_choice", "model_propose_changes", "model_present_plan"]) {
    const f = fixture(() => ({ tool: name }));
    const parts = await run(f, { [name]: tool(async () => "waiting") });
    assert.equal(f.requests.length, 1);
    assert.equal(terminal(parts).status, name === "ask_user_choice" ? "waiting-user" : "waiting-approval");
  }
});
test("repeated identical writes execute once and eventually report stalled", async () => {
  let writes = 0;
  const f = fixture(() => ({ tool: "model_apply_changes", input: { operations: [{ type: "create-element", name: "A" }] } }));
  const parts = await run(f, {
    model_apply_changes: tool(async () => {
      writes++;
      return "已执行 1 项改动：id=real-1";
    })
  });
  assert.equal(writes, 1);
  assert.equal(terminal(parts).status, "stalled");
});
test("model output length limit remains an explicit incomplete result", async () => {
  const length = fixture(() => ({ text: "truncated", reason: "length" }));
  assert.equal(terminal(await run(length, {})).status, "error");
});

test("continues beyond both former segment and cumulative token limits until finished", async () => {
  const f = fixture(n => ({
    ...(n <= 65 ? { tool: "read" } : { text: "finished" }),
    usage: { prompt_tokens: 9998, completion_tokens: 2, total_tokens: 10000 }
  }));
  const parts = await run(f, { read: tool(async ({ n }) => "item-" + n) });
  assert.equal(f.requests.length, 66);
  assert.equal(terminal(parts).status, "finished");
  assert.equal(terminal(parts).continuations, 8);
  assert.equal(parts.filter(p => p.type === "run-usage").at(-1).usage.totalTokens, 660000);
});
test("stop drains an in-flight write and preserves its actual receipt", async () => {
  const abort = new AbortController();
  let started;
  const began = new Promise(r => (started = r));
  let release;
  const commit = new Promise(r => (release = r));
  const f = fixture(() => ({ tool: "model_apply_changes" }));
  let done = false;
  const running = run(
    f,
    {
      model_apply_changes: tool(async () => {
        started();
        await commit;
        done = true;
        return "已执行 1 项改动：id=committed";
      })
    },
    abort.signal
  );
  await began;
  abort.abort();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(done, false);
  release();
  const parts = await running;
  assert.equal(done, true);
  assert.equal(f.requests.length, 1);
  assert.equal(terminal(parts).status, "cancelled");
  assert.ok(JSON.stringify(parts.filter(p => p.type === "model-context")).includes("committed"));
});
test("legacy history includes successful write receipts", () => {
  assert.match(
    assistantHistory({ content: "continue", toolCalls: [{ name: "model_apply_changes", state: "done", output: "real-id" }] })[0].content,
    /real-id/
  );
});

test("cached input usage is reported separately without inflating totals", async () => {
  const f = fixture(n => ({
    ...(n <= 9 ? { tool: "read" } : { text: "finished" }),
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 6 } }
  }));
  const parts = await run(f, { read: tool(async ({ n }) => "item-" + n) });
  const usage = parts.filter(p => p.type === "run-usage").at(-1).usage;
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cachedInputTokens, 60);
  assert.equal(usage.totalTokens, 120);
});

test("old large reads shrink within SDK segments while write receipts stay intact", async () => {
  const original = "名称: 发动机 id=97518092302402688\n" + "属性详情".repeat(2000);
  const receipt = "已执行 1 项改动：id=new-1\n" + "执行详情".repeat(2000);
  const f = fixture(n => n <= 7 ? { tool: n === 2 ? "model_apply_changes" : "model_get_properties" } : { text: "finished" });
  const parts = await run(f, {
    model_get_properties: tool(async () => original),
    model_apply_changes: tool(async () => receipt)
  });
  const sent = f.requests[6].messages.filter(m => m.role === "tool");
  assert.ok(sent[0].content.length < original.length / 2);
  assert.match(sent[0].content, /97518092302402688/);
  assert.equal(sent[1].content, receipt);
  assert.match(sent.at(-1).content, /与此前工具调用/);
  assert.ok(sent.some(item => item.content === original));
  const context = parts.filter(p => p.type === "model-context").at(-1).messages;
  assert.equal(context.find(m => m.role === "tool").content[0].output.value, original);
});

test("zero cache hits stay zero, and missing statistics in a later segment remain unknown", async () => {
  const zero = fixture(() => ({
    text: "finished",
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 0 } }
  }));
  assert.equal((await run(zero, {})).filter(p => p.type === "run-usage").at(-1).usage.cachedInputTokens, 0);
  const mixed = fixture(n => ({
    ...(n <= 8 ? { tool: "read" } : { text: "finished" }),
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, ...(n <= 8 ? { prompt_tokens_details: { cached_tokens: 6 } } : {}) }
  }));
  const parts = await run(mixed, { read: tool(async ({ n }) => "item-" + n) });
  assert.equal(parts.filter(p => p.type === "run-usage").at(-1).usage.cachedInputTokens, undefined);
});

test("compaction retains all identity values, errors and call pairing without mutating history", () => {
  const text = "属性详情".repeat(2000) + '\n{"elementId":"model-engine","ownerId":"root","shapeId":"shape-1"}\n97518092302402688\n12345678-abcd-1234-abcd-123456789abc';
  const result = (id, name, output) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name, output }] });
  const history = [
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "model_get_element", input: { elementId: "model-engine" } }] },
    result("c1", "model_get_element", { type: "text", value: text }),
    result("c2", "model_get_element", { type: "error-text", value: text }),
    result("c3", "model_apply_changes", { type: "text", value: text }),
    ...Array.from({ length: 4 }, (_, n) => result("recent-" + n, "model_get_element", { type: "text", value: text }))
  ];
  const before = JSON.stringify(history);
  const compact = compactToolResults(history);
  const summary = compact[1].content[0];
  for (const id of ["model-engine", "root", "shape-1", "97518092302402688", "12345678-abcd-1234-abcd-123456789abc"]) {
    assert.ok(summary.output.value.includes(id));
  }
  assert.equal(summary.toolCallId, "c1");
  assert.deepEqual(compact[0], history[0]);
  assert.deepEqual(compact.slice(2, 4), history.slice(2, 4));
  for (const item of compact.slice(4)) assert.match(item.content[0].output.value, /c1/);
  assert.equal(JSON.stringify(history), before);
  assert.deepEqual(compactToolResults(compact), compact);
});

test("ID-dense trees shrink and repeated old reads reference the first retained ID index", () => {
  const tree = Array.from({ length: 300 }, (_, n) => `- 部件${n} [Block] id=${97518092302400000n + BigInt(n)}`).join("\n");
  const result = (id, value) => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "model_get_tree", output: { type: "text", value } }] });
  const history = [result("tree-1", tree), result("tree-2", tree), ...Array.from({ length: 4 }, (_, n) => result("recent-" + n, "recent"))];
  const compact = compactToolResults(history);
  const index = compact[0].content[0].output.value;
  assert.ok(index.length < tree.length * 0.85);
  for (let n = 0; n < 300; n++) assert.ok(index.includes(String(97518092302400000n + BigInt(n))));
  assert.match(compact[1].content[0].output.value, /tree-1/);
  assert.ok(compact[1].content[0].output.value.length < 150);
  assert.deepEqual(compact.slice(2), history.slice(2));
});


test("recent large duplicate results are deduplicated and oversized unique reads are summarized", () => {
  const result = (id, name, value, type = "text") => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: name, output: { type, value } }] });
  const text = "id=97518092302402688\n" + "详情".repeat(12000);
  const history = [result("a", "model_get_tree", text), result("b", "model_get_tree", text)];
  const compact = compactToolResults(history);
  assert.ok(compact[0].content[0].output.value.length < 1000);
  assert.match(compact[0].content[0].output.value, /97518092302402688/);
  assert.match(compact[1].content[0].output.value, /调用 a/);
  const types = Array.from({ length: 100 }, (_, n) => ({ elementType: "Block::Type" + n, name: "类型" + n }));
  const list = compactToolResults([result("types", "model_get_creatable_element_types", types, "json")])[0].content[0].output;
  assert.equal(list.type, "text");
  for (const row of types) assert.ok(list.value.includes(JSON.stringify([row.elementType, row.name])));
  assert.ok(list.value.length < JSON.stringify(types).length);
  const palette = compactToolResults([result("palette", "diagram_read_palette", text), result("palette2", "diagram_read_palette", text)]);
  assert.match(palette[1].content[0].output.value, /调用 palette/);
});

test("latest request usage is separate from accumulated usage across segments", async () => {
  const f = fixture(n => ({
    ...(n <= 9 ? { tool: "read" } : { text: "finished" }),
    usage: { prompt_tokens: n * 100, completion_tokens: 2, total_tokens: n * 100 + 2 }
  }));
  const parts = await run(f, { read: tool(async ({ n }) => "item-" + n) });
  const usage = parts.filter(p => p.type === "run-usage").at(-1).usage;
  assert.equal(usage.latestInputTokens, 1000);
  assert.equal(usage.latestOutputTokens, 2);
  assert.equal(usage.inputTokens, 5500);
});

test("历史超出请求预算时较早轮次折成摘要，工具调用与结果保持配对", async () => {
  const f = fixture(() => ({ text: "finished" }));
  const history = [
    { role: "user", content: "原始目标：创建发动机模型 id=97518092302402688" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "hist-write", toolName: "model_apply_changes", input: { operations: [{ type: "create-element", name: "发动机" }] } }]
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "hist-write", toolName: "model_apply_changes", output: { type: "text", value: "已执行 1 项改动：id=97518092302402689" } }
      ]
    }
  ];
  for (let index = 0; index < 8; index += 1) {
    history.push({ role: "assistant", content: "处理进度说明".repeat(120) });
    history.push({ role: "user", content: `继续第 ${index} 步` });
  }
  const parts = [];
  for await (const part of streamAgentWithContinuation({
    model: f.model,
    system: "test",
    messages: history,
    tools: {},
    contextBudget: 4000
  }))
    parts.push(part);
  assert.equal(terminal(parts).status, "finished");
  const sent = f.requests[0].messages;
  const digest = sent.find(message => message.role === "user" && message.content.includes("较早会话摘要"));
  assert.ok(digest, "请求体中应包含被压缩的早期摘要");
  assert.match(digest.content, /97518092302402688/);
  assert.match(digest.content, /97518092302402689/);
  // 最近的轮次保持原文，且不存在失去调用消息的工具结果
  assert.ok(sent.some(message => message.role === "user" && message.content === "继续第 7 步"));
  const calls = new Set();
  for (const message of sent) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) message.tool_calls.forEach(call => calls.add(call.id));
    if (message.role === "tool") assert.ok(calls.has(message.tool_call_id));
  }
});

test("供应商缺少用量统计时不显示SDK合成的零值", async () => {
  const parts = await run(fixture(() => ({ text: "done", usage: {} })), {});
  const usage = parts.filter(part => part.type === "run-usage").at(-1).usage;
  assert.equal(usage.inputTokens, undefined);
  assert.equal(usage.outputTokens, undefined);
  assert.equal(usage.totalTokens, undefined);
});
