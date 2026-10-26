const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const source = fs.readFileSync(require("node:path").join(__dirname, "../src/ai-assistant/conversation/session-statistics.ts"), "utf8");
const mod = { exports: {} };
new Function(
  "exports",
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
)(mod.exports);
const aggregate = mod.exports.aggregateSessionStatistics;
const run = extra => ({ role: "assistant", ...extra });

test("a legacy turn does not erase recorded token subtotals or distort cache rate", () => {
  const result = aggregate([
    run({ durationMs: 1000 }),
    run({ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 } }),
    run({ usage: { inputTokens: 900, outputTokens: 10 } })
  ]);
  assert.equal(result.tokens.total, 1030);
  assert.equal(result.tokens.input, 1000);
  assert.equal(result.tokens.cached, 60);
  assert.equal(result.tokens.uncached, 40);
  assert.equal(result.tokens.cacheRate, 60);
  assert.equal(result.tokens.partial, true);
});
test("weighted timing and cached input subset, without counting expert members again", () => {
  const result = aggregate([
    run({
      durationMs: 3000,
      metrics: { modelMs: 2000, toolMs: 4000, firstTokenMsTotal: 300, firstTokenCount: 2, generationMs: 1000, timedOutputTokens: 50 },
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 60 },
      team: { members: [{ usage: { totalTokens: 999 } }] }
    }),
    run({
      durationMs: 2000,
      metrics: { modelMs: 1000, toolMs: 0, firstTokenMsTotal: 600, firstTokenCount: 1, generationMs: 2000, timedOutputTokens: 100 },
      usage: { inputTokens: 200, outputTokens: 100, cachedInputTokens: 90 }
    })
  ]);
  assert.equal(result.timing.wallMs, 5000);
  assert.equal(result.timing.firstTokenMs, 300);
  assert.equal(result.timing.tokensPerSecond, 50);
  assert.equal(result.tokens.total, 450);
  assert.equal(result.tokens.uncached, 150);
  assert.equal(result.tokens.cacheRate, 50);
});
test("legacy data stays unknown and incomplete session metrics are labelled partial", () => {
  const result = aggregate([
    run({}),
    run({
      metrics: { modelMs: 10, toolMs: 0, firstTokenMsTotal: 0, firstTokenCount: 0, generationMs: 0, timedOutputTokens: 0 },
      usage: { inputTokens: 5, outputTokens: 1 }
    })
  ]);
  assert.equal(result.tokens.total, 6);
  assert.equal(result.tokens.cached, undefined);
  assert.equal(result.timing.wallMs, undefined);
  assert.equal(result.timing.partial, true);
  assert.equal(result.timing.firstTokenMs, undefined);
});
test("context uses latest request only and estimates while new request is running", () => {
  const message = run({
    model: "old",
    runState: { status: "running" },
    usage: { inputTokens: 9000, latestInputTokens: 500 },
    contextUsage: { model: "new", contextLength: 1000, systemTokens: 10, toolTokens: 20, messageTokens: 30 }
  });
  assert.equal(aggregate([message], { contextLength: 2000, model: "other" }).context.used, 60);
  message.contextUsage.inputTokens = 500;
  assert.equal(aggregate([message]).context.used, 500);
  assert.equal(
    aggregate([run({ model: "old", usage: { latestInputTokens: 50 } })], { model: "new", contextLength: 1000 }).context.limit,
    undefined
  );
  assert.equal(aggregate([message, run({})]).context.used, 500);
});

test("running wall clock fills only the latest missing duration and preserves completed durations", () => {
  assert.equal(
    aggregate([run({ createdAt: 100, durationMs: 400 }), run({ createdAt: 1000 })], { running: true, now: 2500 }).timing.wallMs,
    1900
  );
  assert.equal(aggregate([run({ createdAt: 100 }), run({ createdAt: 1000 })], { running: true, now: 2500 }).timing.wallMs, undefined);
  assert.equal(aggregate([run({ createdAt: 100, durationMs: 400 })], { running: true, now: 2500 }).timing.wallMs, 400);
});
