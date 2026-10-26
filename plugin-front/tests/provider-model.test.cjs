const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const ai = require("ai");

test("application provider requests streaming usage and retains the supplier totals", async () => {
  let body;
  const fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    const frame = (delta, finish_reason, usage) => ({
      id: "one",
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {})
    });
    const usage = body.stream_options?.include_usage
      ? { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } }
      : undefined;
    return new Response(
      [frame({ content: "reply" }, null), frame({}, "stop", usage)].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } }
    );
  };
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/provider/model.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(
    name => {
      if (name === "@ai-sdk/openai-compatible") return require(name);
      if (name === "./fetchBridge") return { createAiFetchBridge: () => fetch };
      if (name === "./nodeProxy") return { apiKeyOf: () => "", parseExtraHeaders: () => ({}) };
      if (name === "./polyfills") return {};
      throw new Error(name);
    },
    module,
    module.exports
  );
  const result = ai.streamText({
    model: module.exports.createAiLanguageModel({ id: "p", model: "fixture", baseURL: "https://fixture.invalid/v1" }),
    prompt: "test"
  });
  let stepUsage;
  for await (const part of result.fullStream) {
    if (part.type === "finish-step") stepUsage = part.usage;
  }
  assert.equal(body.stream_options?.include_usage, true);
  const usage = await result.totalUsage;
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(stepUsage.raw.prompt_tokens_details.cached_tokens, 60);
});
