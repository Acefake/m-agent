"use strict";
const test = require("node:test");
// 非严格断言：返回值来自 vm 里的另一个 realm
const assert = require("node:assert");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * 提案引用预检测试：在 vm 里直连 proposal.ts 与 refs.ts，
 * 验证重名、未知引用、前向引用、自引用与种类不匹配都会被拦下，
 * 且原有真实 id 操作保持兼容。
 */

function transpile(relativePath) {
  const source = fs.readFileSync(require.resolve(relativePath), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

function loadModules() {
  const modules = {};
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

  // 每个模块用独立的函数作用域包装：转译产物通过作用域的 exports 读取导出绑定
  const load = relativePath => {
    const module = { exports: {} };
    const wrapper = vm.runInContext(`(function (exports, require, module) {\n${transpile(relativePath)}\n})`, sandbox);
    const requireFn = name => {
      if (name === "nanoid") return { nanoid: () => "nano-test" };
      if (name === "./refs") return modules.refs;
      return {};
    };
    wrapper(module.exports, requireFn, module);
    return module.exports;
  };

  modules.refs = load("../src/ai-assistant/changes/refs.ts");
  modules.proposal = load("../src/ai-assistant/changes/proposal.ts");
  return modules;
}

const { proposal } = loadModules();

test("合法引用通过，真实 id 操作保持兼容，ref 字段被保留", () => {
  const { operations, errors } = proposal.normalizeOperations([
    { type: "create-shape", summary: "建模块A", name: "模块A", elementConfigId: "Block", ref: "blkA" },
    { type: "create-shape", summary: "建模块B", name: "模块B", elementConfigId: "Block", ref: "blkB" },
    { type: "create-connector", summary: "连线", elementConfigId: "Composition", sourceShapeId: "@ref:blkA", targetShapeId: "@ref:blkB" },
    { type: "update-property", summary: "改名", elementId: "real-id-1", propertyName: "名称", propertyKey: "NamedElement-name", oldValue: "旧" }
  ]);

  assert.equal(errors.length, 0);
  assert.equal(operations.length, 4);
  assert.equal(operations[0].ref, "blkA");
  assert.equal(operations[2].sourceShapeId, "@ref:blkA");
  assert.equal(operations[3].elementId, "real-id-1");
});

test("重复引用名：所有同名声明都被拒", () => {
  const { operations, errors } = proposal.normalizeOperations([
    { type: "create-shape", summary: "A", name: "A", elementConfigId: "Block", ref: "blk" },
    { type: "create-shape", summary: "B", name: "B", elementConfigId: "Block", ref: "blk" },
    { type: "create-connector", summary: "连线", elementConfigId: "Association", sourceShapeId: "s1", targetShapeId: "s2" }
  ]);

  assert.equal(operations.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /引用名「blk」在同一提案中重复声明/);
});

test("前向引用、自引用与未知引用都被拒", () => {
  const { operations, errors } = proposal.normalizeOperations([
    { type: "create-connector", summary: "前向", elementConfigId: "Association", sourceShapeId: "@ref:later", targetShapeId: "s2" },
    { type: "create-shape", summary: "自引用", name: "B", elementConfigId: "Block", ref: "self", containerShapeId: "@ref:self" },
    { type: "create-connector", summary: "未知", elementConfigId: "Association", sourceShapeId: "@ref:none", targetShapeId: "s2" },
    { type: "create-shape", summary: "被引用者", name: "C", elementConfigId: "Block", ref: "later" }
  ]);

  assert.equal(operations.length, 1);
  assert.equal(operations[0].ref, "later");
  assert.equal(errors.length, 3);
  assert.match(errors[0], /没有在更早的操作中声明/);
  assert.match(errors[1], /没有在更早的操作中声明/);
  assert.match(errors[2], /没有在更早的操作中声明/);
});

test("种类不匹配：模型 id 字段不能引用连线，图形 id 字段不能引用 create-element", () => {
  const modelMismatch = proposal.normalizeOperations([
    { type: "create-connector", summary: "连线", elementConfigId: "Association", sourceShapeId: "s1", targetShapeId: "s2", ref: "edge" },
    { type: "create-element", summary: "建属性", name: "X", elementType: "Package", containerId: "@ref:edge" }
  ]);
  assert.equal(modelMismatch.operations.length, 1);
  assert.match(modelMismatch.errors[0], /不产生模型元素 id/);

  const shapeMismatch = proposal.normalizeOperations([
    { type: "create-element", summary: "建元素", name: "E", elementType: "Package", containerId: "root", ref: "el" },
    { type: "create-connector", summary: "连线", elementConfigId: "Association", sourceShapeId: "@ref:el", targetShapeId: "s2" }
  ]);
  assert.equal(shapeMismatch.operations.length, 1);
  assert.match(shapeMismatch.errors[0], /不产生图形 id/);
});

test("shapeIds 列表支持引用语法，其中未知引用被拒", () => {
  const ok = proposal.normalizeOperations([
    { type: "create-shape", summary: "A", name: "A", elementConfigId: "Block", ref: "a" },
    { type: "create-shape", summary: "B", name: "B", elementConfigId: "Block", ref: "b" },
    { type: "arrange-shapes", summary: "整理", layout: "auto", shapeIds: "@ref:a,@ref:b" }
  ]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.operations.length, 3);

  const bad = proposal.normalizeOperations([
    { type: "create-shape", summary: "A", name: "A", elementConfigId: "Block", ref: "a" },
    { type: "arrange-shapes", summary: "整理", layout: "auto", shapeIds: "@ref:a,@ref:missing" }
  ]);
  assert.equal(bad.operations.length, 1);
  assert.match(bad.errors[0], /missing/);
});

test("非法引用表达式与非法引用名被拒", () => {
  const badSyntax = proposal.normalizeOperations([
    { type: "create-connector", summary: "连线", elementConfigId: "Association", sourceShapeId: "@shape:x", targetShapeId: "s2" }
  ]);
  assert.equal(badSyntax.operations.length, 0);
  assert.match(badSyntax.errors[0], /不是有效引用表达式/);

  const badName = proposal.normalizeOperations([{ type: "create-shape", summary: "A", name: "A", elementConfigId: "Block", ref: "1bad" }]);
  assert.equal(badName.operations.length, 0);
  assert.match(badName.errors[0], /引用名「1bad」不合法/);
});

test("被拒绝的操作不会登记引用名，引用它的操作一并被拒", () => {
  const { operations, errors } = proposal.normalizeOperations([
    { type: "create-shape", summary: "A", name: "A", elementConfigId: "Block", ref: "broken", containerShapeId: "@ref:none" },
    { type: "create-connector", summary: "连线", elementConfigId: "Association", sourceShapeId: "@ref:broken", targetShapeId: "s2" }
  ]);

  assert.equal(operations.length, 0);
  assert.equal(errors.length, 2);
});

test("提案收敛保留 ref 与 direction 字段", () => {
  const created = proposal.createChangeProposal({
    title: "建模",
    summary: "建模块并连线",
    operations: [
      { type: "create-shape", summary: "A", name: "A", elementConfigId: "Block", ref: "a" },
      { type: "create-connector", summary: "连线", elementConfigId: "Association", sourceShapeId: "@ref:a", targetShapeId: "s2" },
      { type: "arrange-shapes", summary: "整理", layout: "auto", direction: "UP" }
    ]
  });

  assert.ok(created);
  assert.equal(created.operations.length, 3);
  assert.equal(created.operations[0].ref, "a");
  assert.equal(created.operations[1].sourceShapeId, "@ref:a");
  assert.equal(created.operations[2].direction, "UP");
});
