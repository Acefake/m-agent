const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../src/ai-assistant/runtime");
function load(dir, file) {
  let source = fs.readFileSync(path.join(dir, file), "utf8");
  if (file === "agent.ts") source += "\nexports.promptForTest = buildSystemPrompt;";
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  const host = { features: { sysmlText: false }, model: {}, diagram: {} };
  new Function("require", "module", "exports", code)(
    name => {
      if (name === "ai") return { tool: value => value, jsonSchema: value => value };
      if (name === "../host") return { getAiAssistantHost: () => host, tryGetAiAssistantHost: () => host };
      return {};
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

test("精简提示保留权限、真实ID、定向旧值读取和成功收据约束", () => {
  const { promptForTest } = load(root, "agent.ts");
  const { createAiTools } = load(root, "tools.ts");
  for (const mode of ["chat", "proposal", "edit"]) {
    const prompt = promptForTest(mode);
    assert.ok(prompt.length < 1600);
    assert.match(prompt, /propertyKey.*oldValue/);
    assert.match(prompt, /@ref:/);
    assert.match(prompt, /不重复已成功操作/);
    assert.match(prompt, /最终.*不罗列内部 ID/);
    const tools = createAiTools(mode);
    assert.equal(Boolean(tools.model_apply_changes), mode === "edit");
    assert.equal(Boolean(tools.model_propose_changes), mode === "proposal");
    assert.equal(tools.text_read_sysml, undefined);
  }
  const withSkill = promptForTest("edit", { skills: [{ name: "domain", content: "keep-domain-rule" }], hasAttachments: true });
  assert.match(withSkill, /keep-domain-rule/);
  assert.match(withSkill, /附件说明/);
  assert.match(withSkill, /技能不改变权限模式/);
  assert.ok(withSkill.includes('这次会使用 `domain`'));
  assert.match(withSkill, /同一轮只说明一次/);
});

test("专家只读白名单不会随编辑权限获得写入、提案或追问入口", () => {
  const { createAiTools } = load(root, "tools.ts");
  for (const mode of ["chat", "proposal", "edit"]) {
    const tools = createAiTools(mode, true);
    assert.ok(tools.model_get_properties);
    assert.ok(tools.diagram_read_shapes);
    assert.deepEqual(Object.keys(tools).filter(name => !/^(model_(get_tree|search|get_element|get_children|get_relationships|get_properties|get_creatable_element_types)|diagram_(list|read_shapes|read_palette))$/.test(name)), []);
    assert.equal(tools.ask_user_choice, undefined);
    assert.equal(tools.model_apply_changes, undefined);
    assert.equal(tools.model_propose_changes, undefined);
  }
});

test("可选基线对比：同一权限模式的系统提示和工具定义字符数", { skip: !process.env.MDESIGN_TOKEN_BASELINE }, () => {
  const before = process.env.MDESIGN_TOKEN_BASELINE;
  for (const mode of ["chat", "proposal", "edit"]) {
    const request = dir =>
      JSON.stringify({
        system: load(dir, "agent.ts").promptForTest(mode),
        tools: load(dir, "tools.ts").createAiTools(mode)
      });
    const oldSize = request(before).length;
    const newSize = request(root).length;
    assert.ok(newSize < oldSize);
    console.log(
      JSON.stringify({ mode, beforeChars: oldSize, afterChars: newSize, reduction: ((1 - newSize / oldSize) * 100).toFixed(1) + "%" })
    );
  }
});
