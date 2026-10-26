const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const { compactSessionMessages, estimateMessagesTokens, estimateTextTokens } = (() => {
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/runtime/session-compaction.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(require, mod, mod.exports);
  return mod.exports;
})();

const DIGEST_MARK = "较早会话摘要";

/** 工具结果不得失去它的调用消息（摘要自带配对，尾部不允许以孤立工具结果开头） */
function assertPairing(messages) {
  const calls = new Set();
  for (const message of messages) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call") calls.add(part.toolCallId);
      if (part.type === "tool-result") assert.ok(calls.has(part.toolCallId), `孤立工具结果 ${part.toolCallId}`);
    }
  }
}

function longHistory() {
  const messages = [
    { role: "user", content: "原始目标：创建发动机模型 id=97518092302402688" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "write-1", toolName: "model_apply_changes", input: { operations: [{ type: "create-element", name: "发动机" }] } }
      ]
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "write-1", toolName: "model_apply_changes", output: { type: "text", value: "已执行 1 项改动：\n- 创建发动机：id=97518092302402689" } }
      ]
    }
  ];
  for (let index = 0; index < 14; index += 1) {
    messages.push({ role: "assistant", content: "处理进度说明".repeat(80) });
    messages.push({ role: "user", content: `继续第 ${index} 步` });
  }
  return messages;
}

test("预算内或不设预算时原样返回", () => {
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" }
  ];
  assert.equal(compactSessionMessages(messages, 100000), messages);
  assert.equal(compactSessionMessages(messages), messages);
  assert.equal(compactSessionMessages(messages, 0), messages);
});

test("超出预算时折叠较早轮次为摘要，近期消息保持原文", () => {
  const messages = longHistory();
  const total = estimateMessagesTokens(messages);
  const result = compactSessionMessages(messages, Math.floor(total * 0.6));
  assert.ok(result.length < messages.length);
  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /较早会话摘要/);
  assert.match(result[0].content, /97518092302402688/);
  // 最近的旧消息保持原文（对象同一引用）
  assert.equal(result.at(-1), messages.at(-1));
  assert.ok(result.some(message => message === messages[messages.length - 2]));
  assertPairing(result);
});

test("任意预算下工具调用与结果始终配对", () => {
  const messages = longHistory();
  const total = estimateMessagesTokens(messages);
  for (const ratio of [0.35, 0.5, 0.6, 0.75, 0.9]) {
    const result = compactSessionMessages(messages, Math.floor(total * ratio));
    assertPairing(result);
  }
});

test("执行收据优先保留在摘要里，即使位于较早位置", () => {
  const messages = longHistory();
  const total = estimateMessagesTokens(messages);
  const result = compactSessionMessages(messages, Math.floor(total * 0.6));
  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /97518092302402689/);
});

test("失败信息进入摘要而不是被静默丢弃", () => {
  const messages = [
    { role: "user", content: "把名称改掉" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "model_get_properties", input: { elementId: "engine-1" } }]
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-1", toolName: "model_get_properties", output: { type: "error-text", value: "宿主未加载该元素，读取失败" } }
      ]
    },
    ...Array.from({ length: 14 }, (_, index) => [
      { role: "assistant", content: "后续排查说明".repeat(90) },
      { role: "user", content: `再试一次 ${index}` }
    ]).flat()
  ];
  const total = estimateMessagesTokens(messages);
  const result = compactSessionMessages(messages, Math.floor(total * 0.6));
  assert.equal(result[0].role, "user");
  assert.match(result[0].content, /\[失败\]/);
});

test("图片按固定开销估算，base64 体积不会撑爆预算估算", () => {
  const image = {
    role: "user",
    content: [
      { type: "text", text: "看这张截图" },
      { type: "image", image: "data:image/png;base64," + "A".repeat(200000), mediaType: "image/png" }
    ]
  };
  const tokens = estimateMessagesTokens([image]);
  assert.ok(tokens < 3000, `估算不应随 base64 增长: ${tokens}`);
});

test("文本估算区分 CJK 与西文", () => {
  assert.equal(estimateTextTokens("中文四个"), 4);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens(""), 0);
});

test("任意切点都回退到成对边界：扫描预算区间验证孤立工具结果不会出现", () => {
  const messages = [
    { role: "user", content: "原始目标" },
    { role: "assistant", content: "中间说明".repeat(100) },
    { role: "user", content: "继续" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "mid", toolName: "model_get_element", input: { elementId: "engine-2" } }]
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "mid", toolName: "model_get_element", output: { type: "text", value: "元素详情".repeat(300) } }]
    },
    { role: "user", content: "继续" },
    { role: "assistant", content: "处理进度".repeat(800) },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "late", toolName: "model_get_properties", input: { elementId: "engine-1" } }]
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "late", toolName: "model_get_properties", output: { type: "text", value: "属性详情".repeat(400) } }]
    },
    { role: "assistant", content: "后续总结".repeat(300) },
    { role: "user", content: "继续" },
    { role: "assistant", content: "完成" }
  ];
  const total = estimateMessagesTokens(messages);
  let compacted = 0;
  for (let budget = 500; budget < total; budget += 37) {
    const result = compactSessionMessages(messages, budget);
    assertPairing(result);
    if (result[0]?.role === "user" && result[0].content.includes(DIGEST_MARK)) {
      compacted += 1;
      assert.notEqual(result[1]?.role, "tool");
    }
  }
  // 扫描中确实发生过压缩，否则断言没有意义
  assert.ok(compacted > 0);
});

test("压缩结果不会比原消息更大", () => {
  const messages = longHistory();
  const total = estimateMessagesTokens(messages);
  const result = compactSessionMessages(messages, total - 10);
  assert.ok(estimateMessagesTokens(result) <= total);
});
