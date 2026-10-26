// 手动运行：node tests/live-canvas-smoke.cjs <projectId> <ownerId>；只创建并清理本脚本的测试包。
const fs = require("node:fs");
const ts = require("typescript");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const [projectId, ownerId] = process.argv.slice(2);
if (!projectId || !ownerId) throw new Error("需要 projectId 和 ownerId");
const base = process.env.MDESIGN_URL || "http://127.0.0.1:8237";
async function request(path, data, post = false) {
  const url = new URL(path, base);
  if (!post) for (const [key, value] of Object.entries(data)) if (value !== undefined) url.searchParams.set(key, String(value));
  const res = await fetch(url, {
    method: post ? "POST" : "GET",
    headers: { userId: "0", "Content-Type": "application/json" },
    ...(post ? { body: JSON.stringify(data) } : {})
  });
  const body = await res.json();
  if (body.code !== 1000) throw new Error(path + ": " + body.message);
  return body;
}
const get = async (path, data) => (await request(path, data)).data;
const post = async (path, data) => (await request(path, data, true)).data;
const nodes = new Map();
const remember = data => {
  const node = { id: data.id, data, loaded: true };
  nodes.set(data.id, node);
  return node;
};
const tabs = [];
const project = {
  id: projectId,
  config: { id: projectId },
  readonly: false,
  isEditable: () => true,
  ui: { graphTabs: tabs },
  nodePool: {
    getNode: id => nodes.get(id),
    getChildNodes: id => [...nodes.values()].filter(n => n.data.ownerId === id),
    getSelectedNodes: () => [],
    loadNodes: async () => {}
  }
};
const created = [];
const modelService = {
  getModelData: async (projectId, modelId) => {
    const data = await get("/model/info", { projectId, modelId });
    remember(data);
    return data;
  },
  getCanCreateChildTypes: (projectId, instanceId, hasSysMLPermission) =>
    get("/node/canCreateChildTypes", { projectId, instanceId, hasSysMLPermission }),
  getCanCreateDiagramTypes: (projectId, modelId, hasSysMLPermission) =>
    get("/node/canCreateDiagramTypes", { projectId, modelId, hasSysMLPermission }),
  addModel: async (projectId, parentId, metaclass, applyStereotypes, fileInfo, isAutoOpenDiagram, payload, defaultName) => {
    const models = await post("/model/create", {
      projectId,
      parentId,
      metaclass,
      applyStereotypes,
      type: 0,
      isAutoOpenDiagram,
      defaultName
    });
    for (const model of models) {
      remember(model);
      created.push(model.id);
      if (model.metaclass === "UMLDiagram")
        tabs.push({
          id: model.id,
          modelId: model.id,
          diagramName: model.name,
          diagramModel: { ...model, sts: model.sts || model.appliedStereotypes },
          visible: true
        });
    }
    return models;
  },
  renameNode: (projectId, modelId, name) => post("/node/rename", { projectId, modelId, name }),
  removeModel: (projectId, modelIds) => post("/model/delete", { projectId, modelIds })
};
const shapeService = {
  getDiagramAllShape: (projectId, modelId) => get("/shape/diagram/allShape", { projectId, modelId }),
  siderBarItemDropValidate: data => get("/shape/siderBarDrop/validate", data),
  siderBarItemDrop: data => post("/shape/siderBarDrop", data),
  treeDropShape: data => post("/shape/treeDrop", data),
  isValidConnectSource: (projectId, diagramId, sourceShapeId, edgeKey) =>
    get("/shape/isValidConnectSource", { projectId, diagramId, sourceShapeId, edgeKey }),
  isValidConnectTarget: (projectId, diagramId, sourceShapeId, edgeKey, targetShapeId) =>
    get("/shape/isValidConnectTarget", { projectId, diagramId, sourceShapeId, edgeKey, targetShapeId }),
  connectShape: data => request("/shape/connectShape", data, true),
  removeShape: (projectId, diagramId, shapeIds) => post("/shape/remove", { projectId, diagramId, shapeIds }),
  deleteShape: (projectId, diagramId, shapeIds) => post("/shape/delete", { projectId, diagramId, shapeIds }),
  moveShape: (projectId, diagramId, shapeIds, dx, dy) => post("/shape/move", { projectId, diagramId, shapeIds, dx, dy }),
  handleShapesQucikLayout: (projectId, diagramId, direction, layoutType, orderBy, shapeIds) =>
    post("/shape/quickLayout", { projectId, diagramId, direction, layoutType, orderBy, shapeIds })
};
const api = {
  modelService,
  shapeService,
  projectService: { getDiagramConfigForView: (projectId, modelId) => get("/project/diagramConfigForView", { projectId, modelId }) }
};
const sandbox = vm.createContext({
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
  setTimeout,
  clearTimeout,
  window: { app: { activeProject: project, projectManager: { getProject: () => project } }, api }
});
const modules = {};
function load(name) {
  const files = {
    refs: "../src/ai-assistant/changes/refs.ts",
    host: "../src/ai-assistant/host.ts",
    "host-adapter": "../src/host/host-adapter.ts"
  };
  const code = ts.transpileModule(fs.readFileSync(require.resolve(files[name]), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} };
  vm.runInContext("(function(exports,require,module){" + code + "\n})", sandbox)(
    module.exports,
    n => (n === "./runtime" ? { isElectron: false } : modules[n.split("/").pop()] || {}),
    module
  );
  modules[name] = module.exports;
  return module.exports;
}
load("refs");
load("host");
load("host-adapter").configureMDesignHost();
const host = modules.host.getAiAssistantHost();
async function apply(operation) {
  const receipt = await host.editExecutor.apply([operation], { title: "AI助手接口回归" });
  console.log(receipt);
  assert.equal(operation.status, "completed");
  return operation;
}
(async () => {
  let testPackage;
  try {
    await modelService.getModelData(projectId, ownerId);
    testPackage = await apply({
      id: "scope",
      type: "create-element",
      containerId: ownerId,
      elementType: "Package",
      name: "AI助手接口回归_" + Date.now(),
      summary: "创建隔离测试包"
    });
    const containerId = testPackage.revert.elementId;
    const types = await host.model.getCreatableElementTypes(containerId);
    const bdd = types.find(t => t.id === "UMLDiagram::SysMLDI::SysMLBlockDefinitionDiagram");
    assert.ok(bdd);
    const diagram = await apply({
      id: "diagram",
      type: "create-element",
      containerId,
      elementType: bdd.id,
      name: "AI助手画布回归",
      summary: "创建并打开 BDD"
    });
    const diagramId = diagram.revert.elementId;
    console.log((await host.diagram.readPalette(diagramId)).slice(0, 120));
    const block = await apply({
      id: "block",
      type: "create-shape",
      diagramId,
      elementConfigId: "Block",
      name: "回归模块A",
      summary: "从组件创建图形"
    });
    const other = await apply({
      id: "model",
      type: "create-element",
      containerId,
      elementType: "Class::SysML::Blocks::Block",
      name: "回归模块B",
      summary: "创建待摆放模型"
    });
    const placed = await apply({ id: "place", type: "place-shape", diagramId, elementId: other.revert.elementId, summary: "摆放已有模型" });
    const edge = await apply({
      id: "connect",
      type: "create-connector",
      diagramId,
      elementConfigId: "Composition",
      sourceShapeId: block.shapeIds,
      targetShapeId: placed.shapeIds,
      summary: "创建组合连线"
    });
    await apply({
      id: "layout",
      type: "arrange-shapes",
      diagramId,
      shapeIds: block.shapeIds + "," + placed.shapeIds,
      layout: "row",
      startX: "100",
      startY: "150",
      summary: "整理图形位置"
    });
    await apply({
      id: "auto-layout",
      type: "arrange-shapes",
      diagramId,
      shapeIds: block.shapeIds + "," + placed.shapeIds,
      layout: "auto",
      direction: "DOWN",
      summary: "宿主关系自动布局"
    });
    const shapes = await shapeService.getDiagramAllShape(projectId, diagramId);
    assert.ok(shapes.some(s => s.id === edge.shapeIds));
    await host.revertExecutor.execute(placed.revert);
    const after = await shapeService.getDiagramAllShape(projectId, diagramId);
    assert.ok(!after.some(s => s.id === placed.shapeIds));
    console.log("PASS: 实际后端完成图表创建、组件建图、已有模型上图、连线、布局、移除图形回滚");
  } finally {
    if (testPackage?.revert?.elementId) {
      await modelService.removeModel(projectId, [testPackage.revert.elementId]);
      console.log("CLEANED: 本次隔离测试包及其子元素");
    } else if (created.length) {
      await modelService.removeModel(projectId, [created[0]]);
      console.log("CLEANED: 创建异常时的测试对象");
    }
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
