"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * 操作字段校验回归（vm 里直接加载 proposal.ts / refs.ts）：
 * - oldValue 为空字符串是合法取值（当前属性值本来就可能为空），不能判成缺字段；
 * - 校验失败时逐字段指出问题（缺失 / 不是字符串 / 为空），便于模型一次改对。
 */

function loadModules() {
  const sandbox = {
    console,
    Error,
    Map,
    Set,
    Promise,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    window: {}
  };
  vm.createContext(sandbox);

  const modules = {};
  const load = relativePath => {
    const source = fs.readFileSync(require.resolve(relativePath), "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText;
    const module = { exports: {} };
    const wrapper = vm.runInContext(`(function (exports, require, module) {\n${code}\n})`, sandbox);
    wrapper(module.exports, name => (name === "nanoid" ? { nanoid: () => "nano-test" } : name === "./refs" ? modules.refs : {}), module);
    return module.exports;
  };

  modules.refs = load("../src/ai-assistant/changes/refs.ts");
  modules.proposal = load("../src/ai-assistant/changes/proposal.ts");
  return modules;
}

const { proposal } = loadModules();

test("oldValue 为空字符串是合法取值，不再被判成缺字段", () => {
  const { operations, errors } = proposal.normalizeOperations([
    {
      type: "update-property",
      summary: "补全类型",
      elementId: "e-1",
      propertyName: "类型",
      propertyKey: "Property-type",
      oldValue: "",
      newValue: "Block"
    }
  ]);

  assert.equal(errors.length, 0);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].oldValue, "");

  // 整条提案也能生成（此前这里会返回 undefined，模型只能反复换写法）
  const created = proposal.createChangeProposal({
    title: "补全部件属性",
    summary: "绑定类型",
    operations: [
      { type: "update-property", elementId: "e-1", propertyName: "类型", propertyKey: "Property-type", oldValue: "", newValue: "Block" }
    ]
  });
  assert.ok(created);
  assert.equal(created.operations.length, 1);
});

test("oldValue 字段缺失仍然拒绝，且报错精确到字段", () => {
  const { operations, errors } = proposal.normalizeOperations([
    { type: "update-property", elementId: "e-1", propertyName: "类型", propertyKey: "Property-type" },
    { type: "update-property", elementId: "e-1", propertyName: "类型", propertyKey: "", oldValue: "旧" },
    { type: "update-property", elementId: "e-1", propertyName: "类型", propertyKey: "Property-type", oldValue: 42 }
  ]);

  assert.equal(operations.length, 0);
  assert.match(errors[0], /oldValue 缺失/);
  assert.match(errors[1], /propertyKey 为空/);
  assert.match(errors[2], /oldValue 不是字符串/);
  // 不再罗列全部必需字段
  assert.ok(!errors[0].includes("elementId、"));
});

test("propertyName is display metadata, not required for updates", () => {
  const result = proposal.normalizeOperations([
    { type: "update-property", elementId: "e-1", propertyKey: "Property-type", oldValue: "", newValue: "Block" }
  ]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.operations.length, 1);
});
