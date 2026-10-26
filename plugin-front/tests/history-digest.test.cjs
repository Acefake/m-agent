const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

const { buildConversationDigest, mergeConversationDigest } = (() => {
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/conversation/history-digest.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(require, mod, mod.exports);
  return mod.exports;
})();

test("摘要保留用户原文片段、写入收据与提案状态", () => {
  const messages = [
    { id: "u1", role: "user", content: "把发动机改名为动力单元，约束是保留现有 ID", toolCalls: [], createdAt: 1 },
    {
      id: "a1",
      role: "assistant",
      content: "已按约束处理",
      toolCalls: [
        { id: "c1", name: "model_apply_changes", input: {}, state: "done", output: "已执行 1 项改动：id=97518092302402689" },
        { id: "c2", name: "model_get_tree", input: {}, state: "done", output: "很长的只读结果" }
      ],
      proposal: { id: "p1", title: "重命名方案", summary: "", status: "completed", operations: [] },
      createdAt: 2
    }
  ];
  const digest = buildConversationDigest(messages);
  assert.match(digest, /约束是保留现有 ID/);
  assert.match(digest, /97518092302402689/);
  assert.match(digest, /曾生成提案「重命名方案」/);
  assert.doesNotMatch(digest, /很长的只读结果/);
});

test("空输入返回空字符串，无新内容时保留旧摘要", () => {
  assert.equal(buildConversationDigest([]), "");
  assert.equal(mergeConversationDigest("旧的约束", []), "旧的约束");
  assert.equal(mergeConversationDigest(undefined, []), "");
});

test("合并摘要超长时保留最近内容并从头部标记省略", () => {
  const dropped = Array.from({ length: 60 }, (_, index) => ({
    id: `m-${index}`,
    role: "user",
    content: `第 ${index} 条目标 ${"细节".repeat(150)}`,
    toolCalls: [],
    createdAt: index
  }));
  const merged = mergeConversationDigest("更早的原始约束", dropped);
  assert.ok(merged.length <= 8030, `摘要长度 ${merged.length}`);
  assert.match(merged, /^(（更早摘要已省略）|更早的原始约束)/);
  // 最近的内容必须保留
  assert.match(merged, /第 59 条目标/);
});
