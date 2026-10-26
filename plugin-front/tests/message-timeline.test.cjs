const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/conversation/message-timeline.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { appendMessageText, messageStages } = mod.exports;

test("正文流片段合并，工具调用之后的正文独立成阶段，持久化后顺序不变", () => {
  const message = { content: "", steps: [{ kind: "tool", id: "read" }] };
  appendMessageText(message, "读取");
  appendMessageText(message, "完成。");
  message.steps.push({ kind: "reasoning", text: "准备创建" }, { kind: "tool", id: "create" });
  appendMessageText(message, "创建完成。");
  assert.equal(message.content, "读取完成。创建完成。");
  assert.deepEqual(messageStages(JSON.parse(JSON.stringify(message))), [
    { key: 0, stepIndexes: [0], text: "读取完成。" },
    { key: 2, stepIndexes: [2, 3], text: "创建完成。" }
  ]);
});

test("先输出说明再调用工具时，工作阶段留在说明之后，随后正文仍归当前阶段", () => {
  const message = { content: "", steps: [] };
  appendMessageText(message, "先检查项目。");
  message.steps.push({ kind: "tool", id: "read" });
  assert.deepEqual(messageStages(message), [
    { key: 0, stepIndexes: [], text: "先检查项目。" },
    { key: 1, stepIndexes: [1], text: "" }
  ]);
  appendMessageText(message, "已找到根节点。");
  assert.equal(messageStages(message)[1].text, "已找到根节点。");
});

test("旧会话正文只显示一次；空消息可显示等待状态", () => {
  assert.deepEqual(messageStages({ content: "旧总结", steps: [{ kind: "tool", id: "old" }] }), [
    { key: 0, stepIndexes: [0], text: "旧总结" }
  ]);
  assert.deepEqual(messageStages({ content: "" }), [{ key: 0, stepIndexes: [], text: "" }]);
});
