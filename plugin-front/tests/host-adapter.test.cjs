"use strict";
const test = require("node:test");
// 非严格断言：适配层的返回值来自 vm 里的另一个 realm，deepStrictEqual 会因原型不同误报
const assert = require("node:assert");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * 宿主适配层直连测试：用假的 M-Design 宿主对象验证
 * 读取渲染、创建/改属性/摆放图形走真实宿主接口、以及可回滚的逆操作。
 *
 * 不启动真实客户端与后端：断言的是「调用了哪个宿主接口、带了什么参数」这一约定范围。
 */

function transpile(relativePath) {
  const source = fs.readFileSync(require.resolve(relativePath), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

/**
 * 在 vm 沙箱里按 CommonJS 语义加载一个模块。
 *
 * 每个模块用独立的函数作用域包装：转译产物会通过作用域的 exports 读取导出绑定，
 * 若多个模块共用沙箱全局的 exports，后续模块会覆盖前面的导出对象导致读取错位。
 */
function loadModuleInSandbox(sandbox, relativePath, requireFn) {
  const module = { exports: {} };
  const wrapper = vm.runInContext(`(function (exports, require, module) {\n${transpile(relativePath)}\n})`, sandbox);
  wrapper(module.exports, requireFn, module);
  return module.exports;
}

function loadAdapter(hostApp, api) {
  const modules = {};
  const sandbox = {
    console,
    crypto: require("node:crypto").webcrypto,
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
    window: { app: hostApp, api }
  };
  vm.createContext(sandbox);

  const requireFn = name => {
    if (name === "./runtime") return { isElectron: false };
    if (name === "../ai-assistant/host") return modules.host;
    if (name === "../ai-assistant/changes/refs") return modules.refs;
    if (name === "../ai-assistant/memory") return modules.memory;
    return {};
  };

  modules.refs = loadModuleInSandbox(sandbox, "../src/ai-assistant/changes/refs.ts", requireFn);
  modules.memory = loadModuleInSandbox(sandbox, "../src/ai-assistant/memory/index.ts", requireFn);
  modules.host = loadModuleInSandbox(sandbox, "../src/ai-assistant/host.ts", requireFn);
  const adapter = loadModuleInSandbox(sandbox, "../src/host/host-adapter.ts", requireFn);

  adapter.configureMDesignHost();
  return { adapter, host: modules.host.getAiAssistantHost() };
}

/** 构造一份最小的 M-Design 宿主：模型树 + 服务 + 图表 */
function createHost() {
  const calls = {
    addModel: [],
    updateModelProperty: [],
    removeModel: [],
    treeDropShape: [],
    removeShape: [],
    deleteShape: [],
    moveShape: [],
    connectShape: [],
    quickLayout: []
  };

  const nodes = new Map();
  const addNode = (id, parentId, name, metaclass, extra = {}) => {
    const node = {
      id,
      parentId,
      loaded: true,
      data: { id, ownerId: parentId, name, metaclass, hasChild: false, ...extra }
    };
    nodes.set(id, node);
    return node;
  };
  addNode("root", "", "模型根", "Model");
  const pool = {
    rootNodes: [nodes.get("root")],
    getNode: id => nodes.get(id),
    getChildNodes: id => [...nodes.values()].filter(node => node.parentId === id),
    getSelectedNodes: () => [],
    loadNodes: async () => undefined
  };

  const shapeState = {
    shapes: [
      {
        id: "root-shape",
        shapeType: "Diagram",
        name: "结构图",
        shapeKey: "BlockDefinitionDiagram",
        bounds: { x: 0, y: 0, width: 800, height: 600 }
      }
    ]
  };
  const properties = { value: "旧名称" };
  const dropState = { count: 0 };
  const layoutState = { result: { shapeMap: {}, res: [], graph: {} }, moveOnSuccess: true };

  const services = {
    modelService: {
      getNodePath: async () => [],
      getNodesWhenSelectOnTree: async () => [],
      getChildNodeDatas: async () => [],
      getModelData: async (projectId, modelId) => ({ id: modelId, name: "元素" + modelId }),
      getModelDatas: async () => [],
      modelSearch: async () => [{ id: "sys-1", name: "系统", metaclass: "Package", ownerId: "root" }],
      getCanCreateDiagramTypes: async () => [],
      getCanCreateChildTypes: async () => [
        { metaclass: "Package", appliedStereotypes: [], cnName: "包" },
        { metaclass: "Block", appliedStereotypes: ["SysML::Blocks::Block"], cnName: "模块" }
      ],
      addModel: async (projectId, ownerId, metaclass, sts, fileInfo, isAutoOpenDiagram, payload, defaultName) => {
        calls.addModel.push({ projectId, ownerId, metaclass, sts, defaultName, isAutoOpenDiagram });
        addNode("new-1", ownerId, defaultName || "默认名", metaclass);
        return [{ id: "new-1", name: defaultName }];
      },
      renameNode: async () => undefined,
      updateModelProperty: async dto => {
        calls.updateModelProperty.push(dto);
        properties.value = String(dto.value);
      },
      getModelProperties: async () => [
        { key: "NamedElement-name", name: "名称", value: properties.value, dataType: "String", readonly: false },
        { key: "NamedElement-owner", name: "所属", value: "", dataType: "Instance", readonly: true }
      ],
      removeModel: async (projectId, modelIds) => {
        calls.removeModel.push({ projectId, modelIds });
      }
    },
    shapeService: {
      getDiagramAllShape: async () => shapeState.shapes,
      siderBarItemDropValidate: async () => [{ name: "创建", key: "create", priority: 1 }],
      siderBarItemDrop: async data => {
        assert.equal(data.diagramId, "root-shape");
        dropState.count += 1;
        const shape = {
          id: `shape-${dropState.count}`,
          name: `模块${dropState.count}`,
          shapeType: "Symbol",
          shapeKey: "Block",
          modelId: `model-${dropState.count}`,
          parentId: "root-shape",
          bounds: { x: data.point.x, y: data.point.y, width: 120, height: 80 }
        };
        shapeState.shapes.push(shape);
        addNode(shape.modelId, "root", shape.name, "Block");
        return { shapeId: shape.id, modelId: shape.modelId };
      },
      treeDropShape: async data => {
        assert.equal(data.diagramId, "root-shape");
        calls.treeDropShape.push(data);
        shapeState.shapes.push({
          id: "placed-1",
          name: "已摆上的图形",
          shapeType: "Symbol",
          shapeKey: "Block",
          modelId: data.modelId,
          parentId: data.shapeId,
          bounds: { x: data.point.x, y: data.point.y, width: 120, height: 80 }
        });
        return { code: 1000, data: true };
      },
      isValidConnectSource: async () => true,
      isValidConnectTarget: async () => true,
      connectShape: async data => {
        assert.equal(data.diagramId, "root-shape");
        assert.ok(data.waypoint.length >= 2);
        calls.connectShape.push(data);
        return {
          data: {
            createdShapes: [
              { id: "edge-1", shapeType: "Edge", sourceId: data.sourceShapeId, targetId: data.targetShapeId },
              { id: "edge-1-label", shapeType: "MovableLabel" }
            ]
          }
        };
      },
      removeShape: async (projectId, diagramId, shapeIds) => {
        assert.equal(diagramId, "root-shape");
        calls.removeShape.push({ projectId, diagramId, shapeIds });
      },
      deleteShape: async (projectId, diagramId, shapeIds) => {
        assert.equal(diagramId, "root-shape");
        calls.deleteShape.push({ projectId, diagramId, shapeIds });
      },
      moveShape: async (projectId, diagramId, shapeIds, dx, dy) => {
        assert.equal(diagramId, "root-shape");
        calls.moveShape.push({ shapeIds, dx, dy });
        return [];
      },
      handleShapesQucikLayout: async (projectId, diagramId, direction, layoutType, orderBy, shapeIds) => {
        assert.equal(diagramId, "root-shape");
        calls.quickLayout.push({ projectId, diagramId, direction, layoutType, orderBy, shapeIds: [...shapeIds] });
        if (layoutState.result && layoutState.moveOnSuccess) {
          for (const shape of shapeState.shapes) {
            if (shapeIds.includes(shape.id) && shape.bounds) {
              shape.bounds.x += 10;
              shape.bounds.y += 10;
            }
          }
        }
        return layoutState.result;
      }
    },
    projectService: {
      getDiagramConfigForView: async () => ({
        siderbarConfig: [
          {
            id: "group-1",
            name: "常用组件",
            children: [{ showData: { name: "模块", siderBarkey: "Block" } }, { showData: { name: "关联", siderBarkey: "Association" } }]
          }
        ]
      })
    }
  };

  const project = {
    id: "project-1",
    readonly: false,
    config: { id: "project-1", name: "示例项目" },
    ui: {
      isDisplayMode: false,
      graphTabs: [
        {
          id: "diagram-1",
          modelId: "diagram-1",
          diagramName: "结构图",
          visible: true,
          diagramModel: { id: "diagram-1", name: "结构图", sts: ["BlockDefinitionDiagram"] }
        },
        {
          id: "diagram-2",
          modelId: "diagram-2",
          diagramName: "第二张结构图",
          visible: false,
          diagramModel: { id: "diagram-2", name: "第二张结构图", sts: ["BlockDefinitionDiagram"] }
        }
      ]
    },
    nodePool: pool,
    isEditable: () => true
  };

  const hostApp = {
    activeProject: project,
    projectManager: { getProject: () => project },
    licenseState: { hasSysMLPermission: () => true },
    global: { insertConnectPosition: "notInsert" }
  };

  return { hostApp, calls, services, shapeState, properties, project, layoutState };
}

function setup() {
  const ctx = createHost();
  const storage = {
    data: new Map(),
    get(key) {
      return this.data.get(key) ?? null;
    },
    set(key, value) {
      this.data.set(key, value);
    },
    remove(key) {
      this.data.delete(key);
    }
  };
  // 适配层通过 window.api 读取宿主服务与存储
  const api = { storage, ...ctx.services };
  ctx.hostApp.api = api;
  const { host, adapter } = loadAdapter(ctx.hostApp, api);
  return { ...ctx, storage, host, adapter };
}

test("可创建元素类型编码 metaclass 与构造型，读模型树与组件清单", async () => {
  const ctx = setup();
  assert.equal(ctx.host.features.sysmlText, false);

  const types = await ctx.host.model.getCreatableElementTypes("root");
  assert.deepEqual(types, [
    { id: "Package", label: "包" },
    { id: "Block::SysML::Blocks::Block", label: "模块" }
  ]);

  const tree = await ctx.host.model.getModelTree({});
  assert.match(tree, /模型根/);
  assert.match(tree, /id=root/);

  const diagrams = await ctx.host.diagram.listDiagrams();
  assert.match(diagrams, /结构图/);
  assert.match(diagrams, /diagramId=diagram-1/);

  const palette = await ctx.host.diagram.readPalette();
  assert.match(palette, /elementConfigId=Block/);
  assert.match(palette, /elementConfigId=Association/);
});

test("长属性默认返回读取提示，定向读取保留完整旧值", async () => {
  const ctx = setup();
  ctx.properties.value = "完整属性值".repeat(2000);
  const catalog = await ctx.host.model.getProperties("root");
  assert.match(catalog, /当前值未提供/);
  assert.match(catalog, /propertyKey=NamedElement-name/);
  assert.ok(catalog.length < 400);
  const targeted = await ctx.host.model.getProperties("root", ["NamedElement-name"]);
  assert.ok(targeted.includes(ctx.properties.value));
  assert.doesNotMatch(targeted, /当前值未提供/);
});

test("属性可按名称或 key 读取，保留当前值和只读信息，不返回无关属性", async () => {
  const ctx = setup();
  const byName = await ctx.host.model.getProperties("root", ["名称"]);
  assert.match(byName, /propertyKey=NamedElement-name/);
  assert.match(byName, /当前值:/);
  assert.doesNotMatch(byName, /NamedElement-owner/);
  const byKey = await ctx.host.model.getProperties("root", ["NamedElement-owner"]);
  assert.match(byKey, /只读/);
  assert.doesNotMatch(byKey, /NamedElement-name/);
  assert.match(await ctx.host.model.getProperties("root", ["不存在"]), /未找到指定属性/);
  const all = await ctx.host.model.getProperties("root");
  assert.match(all, /NamedElement-name/);
  assert.match(all, /NamedElement-owner/);
});

test("创建元素走宿主 addModel，并写入可回滚的 delete-element 逆操作", async () => {
  const ctx = setup();
  const operation = {
    id: "op-1",
    type: "create-element",
    summary: "创建系统",
    name: "系统",
    elementType: "Package",
    containerId: "root",
    status: "pending"
  };

  const text = await ctx.host.editExecutor.apply([operation], { title: "创建" });
  assert.match(text, /new-1/);
  assert.deepEqual(ctx.calls.addModel, [
    { projectId: "project-1", ownerId: "root", metaclass: "Package", sts: [], defaultName: "系统", isAutoOpenDiagram: false }
  ]);

  assert.equal(operation.status, "completed");
  assert.equal(operation.revert.type, "delete-element");
  assert.equal(operation.revert.elementId, "new-1");

  const revertText = await ctx.host.revertExecutor.execute(operation.revert);
  assert.match(revertText, /已删除/);
  assert.deepEqual(ctx.calls.removeModel, [{ projectId: "project-1", modelIds: ["new-1"] }]);
});

test("未知或短名元素类型被明确拒绝，不落地任何创建", async () => {
  const ctx = setup();
  const operation = {
    id: "op-2",
    type: "create-element",
    summary: "创建零件",
    name: "零件",
    elementType: "不存在的类型",
    containerId: "root",
    status: "pending"
  };

  const text = await ctx.host.editExecutor.apply([operation], { title: "创建" });
  assert.match(text, /不支持元素类型/);
  assert.equal(ctx.calls.addModel.length, 0);
});

test("修改属性走 getModelProperties + updateModelProperty，并回滚旧值", async () => {
  const ctx = setup();
  const operation = {
    id: "op-3",
    type: "update-property",
    summary: "改名称",
    elementId: "sys-1",
    propertyName: "名称",
    propertyKey: "NamedElement-name",
    oldValue: "旧名称",
    newValue: "新名称",
    status: "pending"
  };

  const text = await ctx.host.editExecutor.apply([operation], { title: "改名" });
  assert.match(text, /新名称/);
  assert.equal(ctx.calls.updateModelProperty.length, 1);
  assert.equal(ctx.calls.updateModelProperty[0].key, "NamedElement-name");
  assert.equal(ctx.calls.updateModelProperty[0].value, "新名称");
  assert.equal(operation.revert.newValue, "旧名称");

  const revertText = await ctx.host.revertExecutor.execute(operation.revert);
  assert.match(revertText, /旧名称/);
  assert.equal(ctx.calls.updateModelProperty[1].value, "旧名称");
});

test("只读属性与不存在的属性都拒绝执行", async () => {
  const ctx = setup();
  const readonlyOp = {
    id: "op-4",
    type: "update-property",
    summary: "改所属",
    elementId: "sys-1",
    propertyName: "所属",
    propertyKey: "NamedElement-owner",
    oldValue: "",
    newValue: "x",
    status: "pending"
  };
  assert.match(await ctx.host.editExecutor.apply([readonlyOp], { title: "改名" }), /只读/);

  const missingOp = { ...readonlyOp, id: "op-5", propertyKey: "NoSuch-key" };
  assert.match(await ctx.host.editExecutor.apply([missingOp], { title: "改名" }), /没有属性/);
  assert.equal(ctx.calls.updateModelProperty.length, 0);
});

test("摆放已有元素走 treeDropShape，回滚只移除图形不动模型", async () => {
  const ctx = setup();
  const operation = {
    id: "op-6",
    type: "place-shape",
    summary: "把系统摆到画布",
    elementId: "sys-1",
    status: "pending"
  };

  const text = await ctx.host.editExecutor.apply([operation], { title: "摆图" });
  assert.match(text, /placed-1/);
  assert.equal(ctx.calls.treeDropShape.length, 1);
  assert.equal(ctx.calls.treeDropShape[0].modelId, "sys-1");
  assert.equal(ctx.calls.treeDropShape[0].shapeId, "root-shape");

  assert.equal(operation.revert.revertScope, "shape");
  await ctx.host.revertExecutor.execute(operation.revert);
  assert.equal(ctx.calls.removeShape.length, 1);
  assert.equal(ctx.calls.deleteShape.length, 0);
});

test("SysML 文本操作在 M-Design 上面返回明确不可用", async () => {
  const ctx = setup();
  const text = await ctx.host.editExecutor.apply(
    [{ id: "op-7", type: "replace-sysml-text", summary: "改文本", namespaceId: "n-1", textualContent: "x", status: "pending" }],
    { title: "文本" }
  );
  assert.match(text, /没有 SysML 文本/);

  const hostText = await ctx.host.model.readSysmlText("n-1");
  assert.match(hostText, /不支持读取\/校验/);
});

/* ------------------------------------------------------------------ *
 * 第一期：提案内引用、连线严格校验、关系自动布局
 * ------------------------------------------------------------------ */

/** 画布上准备两个可连线的图形 */
function seedTwoShapes(ctx) {
  ctx.shapeState.shapes.push(
    {
      id: "sa",
      shapeType: "Symbol",
      shapeKey: "Block",
      modelId: "ma",
      parentId: "root-shape",
      bounds: { x: 10, y: 10, width: 120, height: 80 }
    },
    {
      id: "sb",
      shapeType: "Symbol",
      shapeKey: "Block",
      modelId: "mb",
      parentId: "root-shape",
      bounds: { x: 300, y: 10, width: 120, height: 80 }
    }
  );
}

function connectorOp(overrides = {}) {
  return {
    id: "op-conn",
    type: "create-connector",
    summary: "连接两块",
    elementConfigId: "Association",
    sourceShapeId: "sa",
    targetShapeId: "sb",
    status: "pending",
    ...overrides
  };
}

function createShapeOp(overrides = {}) {
  return {
    id: "op-shape",
    type: "create-shape",
    summary: "创建模块图形",
    name: "模块A",
    elementConfigId: "Block",
    status: "pending",
    ...overrides
  };
}

test("连线起点校验返回 false / 异常 / 无法识别时都不执行连线", async () => {
  {
    const ctx = setup();
    seedTwoShapes(ctx);
    ctx.services.shapeService.isValidConnectSource = async () => false;
    const text = await ctx.host.editExecutor.apply([connectorOp()], { title: "连线" });
    assert.match(text, /不允许从图形 sa 拉出 Association/);
    assert.equal(ctx.calls.connectShape.length, 0);
  }

  {
    const ctx = setup();
    seedTwoShapes(ctx);
    ctx.services.shapeService.isValidConnectSource = async () => {
      throw new Error("网络断开");
    };
    const text = await ctx.host.editExecutor.apply([connectorOp()], { title: "连线" });
    assert.match(text, /起点校验请求失败/);
    assert.match(text, /网络断开/);
    assert.equal(ctx.calls.connectShape.length, 0);
  }

  {
    const ctx = setup();
    seedTwoShapes(ctx);
    ctx.services.shapeService.isValidConnectSource = async () => undefined;
    const text = await ctx.host.editExecutor.apply([connectorOp()], { title: "连线" });
    assert.match(text, /无法识别的结果/);
    assert.equal(ctx.calls.connectShape.length, 0);
  }
});

test("连线终点校验不通过时不执行连线", async () => {
  const ctx = setup();
  seedTwoShapes(ctx);
  ctx.services.shapeService.isValidConnectTarget = async () => false;
  const text = await ctx.host.editExecutor.apply([connectorOp()], { title: "连线" });
  assert.match(text, /不允许 Association 连接 sa → sb/);
  assert.equal(ctx.calls.connectShape.length, 0);
});

test("校验明确允许后才连线，主对象取唯一的 Edge 图形而不是第一个返回项", async () => {
  const ctx = setup();
  seedTwoShapes(ctx);
  const operation = connectorOp({ ref: "conn" });
  const text = await ctx.host.editExecutor.apply([operation], { title: "连线" });
  assert.match(text, /已创建连线 id=edge-1/);
  assert.equal(ctx.calls.connectShape.length, 1);
  assert.equal(ctx.calls.connectShape[0].sourceShapeId, "sa");
  assert.equal(operation.shapeIds, "edge-1");
  assert.equal(operation.revert.shapeIds, "edge-1");
});

test("同一提案内 create-shape 的 ref 可被 create-connector 按图形 id 解析", async () => {
  const ctx = setup();
  const operations = [
    createShapeOp({ id: "op-a", ref: "blkA", name: "模块A" }),
    createShapeOp({ id: "op-b", ref: "blkB", name: "模块B" }),
    connectorOp({ id: "op-c", sourceShapeId: "@ref:blkA", targetShapeId: "@ref:blkB" })
  ];
  const text = await ctx.host.editExecutor.apply(operations, { title: "建模" });
  assert.match(text, /已创建连线/);
  assert.equal(ctx.calls.connectShape.length, 1);
  assert.equal(ctx.calls.connectShape[0].sourceShapeId, "shape-1");
  assert.equal(ctx.calls.connectShape[0].targetShapeId, "shape-2");
});

test("引用可解析到模型元素 id：create-element 的容器用 @ref 指向新建模块", async () => {
  const ctx = setup();
  const operations = [
    createShapeOp({ id: "op-a", ref: "blkA", name: "车" }),
    {
      id: "op-b",
      type: "create-element",
      summary: "建部件属性",
      name: "部件",
      elementType: "Package",
      containerId: "@ref:blkA",
      status: "pending"
    }
  ];
  const text = await ctx.host.editExecutor.apply(operations, { title: "属性" });
  assert.match(text, /已创建元素「部件」/);
  assert.deepEqual(
    ctx.calls.addModel.map(call => call.ownerId),
    ["model-1"]
  );
});

test("引用未知名称或跨图表图形时明确报错，不执行连线", async () => {
  {
    const ctx = setup();
    seedTwoShapes(ctx);
    const text = await ctx.host.editExecutor.apply([connectorOp({ sourceShapeId: "@ref:missing" })], { title: "连线" });
    assert.match(text, /没有对应的已完成操作/);
    assert.equal(ctx.calls.connectShape.length, 0);
  }

  {
    const ctx = setup();
    const operations = [
      createShapeOp({ id: "op-a", ref: "blkA", diagramId: "diagram-1" }),
      connectorOp({ id: "op-c", diagramId: "diagram-2", sourceShapeId: "@ref:blkA", targetShapeId: "@ref:blkA" })
    ];
    const text = await ctx.host.editExecutor.apply(operations, { title: "连线" });
    assert.match(text, /另一个图表/);
    assert.equal(ctx.calls.connectShape.length, 0);
  }
});

test("arrange-shapes layout=auto 只把本提案在目标图新建的图形交给宿主布局", async () => {
  const ctx = setup();
  const operations = [
    createShapeOp({ id: "op-a", ref: "blkA" }),
    createShapeOp({ id: "op-b", ref: "blkB" }),
    connectorOp({ id: "op-c", sourceShapeId: "@ref:blkA", targetShapeId: "@ref:blkB" }),
    { id: "op-d", type: "arrange-shapes", summary: "整理", layout: "auto", status: "pending" }
  ];
  const text = await ctx.host.editExecutor.apply(operations, { title: "建模并布局" });
  assert.match(text, /已用宿主关系布局整理 2 个图形/);
  assert.match(text, /不提供插件级回滚/);
  assert.equal(ctx.calls.quickLayout.length, 1);
  assert.deepEqual(ctx.calls.quickLayout[0].shapeIds, ["shape-1", "shape-2"]);
  assert.equal(ctx.calls.quickLayout[0].direction, "DOWN");
  assert.equal(ctx.calls.quickLayout[0].layoutType, "CLASS");
  // auto 布局不写插件级逆操作：宿主布局会调整尺寸与连线，超出位置回滚能力
  assert.equal(operations[3].revert, undefined);
});

test("arrange-shapes layout=auto 支持方向；没有目标图形时报错且不触发全图布局", async () => {
  {
    const ctx = setup();
    const operations = [
      createShapeOp({ id: "op-a" }),
      createShapeOp({ id: "op-b" }),
      { id: "op-c", type: "arrange-shapes", summary: "整理", layout: "auto", direction: "right", status: "pending" }
    ];
    const text = await ctx.host.editExecutor.apply(operations, { title: "布局" });
    assert.match(text, /方向 RIGHT/);
    assert.equal(ctx.calls.quickLayout[0].direction, "RIGHT");
  }

  {
    const ctx = setup();
    const text = await ctx.host.editExecutor.apply(
      [{ id: "op-x", type: "arrange-shapes", summary: "整理", layout: "auto", status: "pending" }],
      { title: "布局" }
    );
    assert.match(text, /没有可整理的图形/);
    assert.equal(ctx.calls.quickLayout.length, 0);
  }

  {
    // 在另一个图表新建的图形不进入本图默认整理集合
    const ctx = setup();
    const operations = [
      createShapeOp({ id: "op-a", diagramId: "diagram-1" }),
      { id: "op-x", type: "arrange-shapes", summary: "整理", layout: "auto", diagramId: "diagram-2", status: "pending" }
    ];
    const text = await ctx.host.editExecutor.apply(operations, { title: "布局" });
    assert.match(text, /没有可整理的图形/);
    assert.equal(ctx.calls.quickLayout.length, 0);
  }
});

test("arrange-shapes layout=auto 如实反馈宿主结果：不支持 / 未执行 / 跨层级都报错", async () => {
  const cases = [
    { result: "Not Supported Graph", pattern: /不支持自动布局/ },
    { result: undefined, pattern: /宿主未执行自动布局/ },
    { result: "Different Levels", pattern: /同一层级/ }
  ];
  for (const item of cases) {
    const ctx = setup();
    ctx.layoutState.result = item.result;
    const operations = [
      createShapeOp({ id: "op-a" }),
      createShapeOp({ id: "op-b" }),
      { id: "op-c", type: "arrange-shapes", summary: "整理", layout: "auto", status: "pending" }
    ];
    const text = await ctx.host.editExecutor.apply(operations, { title: "布局" });
    assert.match(text, item.pattern);
    assert.equal(operations[2].revert, undefined);
  }
});

test("arrange-shapes 旧三种布局保持可用：显式 shapeIds 走 moveShape 并记录位置回滚", async () => {
  const ctx = setup();
  seedTwoShapes(ctx);
  const operation = { id: "op-grid", type: "arrange-shapes", summary: "网格排布", layout: "grid", shapeIds: "sa,sb", status: "pending" };
  const text = await ctx.host.editExecutor.apply([operation], { title: "排布" });
  assert.match(text, /grid 布局/);
  assert.equal(ctx.calls.quickLayout.length, 0);
  assert.equal(ctx.calls.moveShape.length, 1);
  assert.equal(operation.revert.type, "restore-bounds");

  // 无效的 layout 值被明确拒绝
  const bad = await ctx.host.editExecutor.apply(
    [{ id: "op-bad", type: "arrange-shapes", summary: "整理", layout: "diagonal", shapeIds: "sa", status: "pending" }],
    { title: "排布" }
  );
  assert.match(bad, /layout 必须是 auto、grid、row 或 column/);
});

test("界面上下文只带当前图表：模型树选中项不进入上下文，选中与否都按全模型处理", () => {
  const ctx = setup();
  ctx.project.nodePool.getSelectedNodes = () => [{ id: "sys-1", data: { id: "sys-1", name: "系统", metaclass: "Package" } }];

  const snapshot = ctx.host.context.capture();
  assert.ok(snapshot);
  assert.equal(snapshot.selection, undefined);
  assert.equal(snapshot.diagram.id, "diagram-1");

  // 没有可见图表时不再返回快照（只有选中项不构成上下文）
  ctx.project.ui.graphTabs.forEach(tab => {
    tab.visible = false;
  });
  assert.equal(ctx.host.context.capture(), undefined);
});

test("stopping a batch preserves completed updates and skips subsequent writes", async () => {
  const ctx = setup();
  const controller = new AbortController();
  const update = ctx.services.modelService.updateModelProperty;
  ctx.services.modelService.updateModelProperty = async dto => {
    await update(dto);
    controller.abort();
  };
  const operations = ["first", "second"].map((value, index) => ({
    id: "cancel-" + index,
    type: "update-property",
    summary: value,
    elementId: "sys-1",
    propertyKey: "NamedElement-name",
    oldValue: "旧名称",
    newValue: value,
    status: "pending"
  }));
  const receipt = await ctx.host.editExecutor.apply(operations, { title: "cancel", signal: controller.signal });
  assert.equal(ctx.calls.updateModelProperty.length, 1);
  assert.equal(operations[0].status, "completed");
  assert.equal(operations[1].status, "pending");
  assert.match(receipt, /后续操作已停止/);
  assert.match(receipt, /first/);
});

test("diagram menus are flattened and create-element creates and opens the actual diagram", async () => {
  const ctx = setup();
  ctx.services.modelService.getCanCreateDiagramTypes = async () => [
    {
      label: "SysML",
      children: [{ metaclass: "UMLDiagram", cnName: "模块定义图", appliedStereotypes: ["SysMLDI::SysMLBlockDefinitionDiagram"] }]
    }
  ];
  const types = await ctx.host.model.getCreatableElementTypes("root");
  const diagram = types.find(item => item.label.includes("[图表]"));
  assert.equal(diagram.id, "UMLDiagram::SysMLDI::SysMLBlockDefinitionDiagram");
  const add = ctx.services.modelService.addModel;
  ctx.services.modelService.addModel = async (...args) => {
    const models = await add(...args);
    return [
      { id: "owner-result", metaclass: "Package" },
      { ...models[0], metaclass: "UMLDiagram", ownerId: "root" }
    ];
  };
  const operation = {
    id: "new-diagram",
    type: "create-element",
    summary: "创建 BDD",
    containerId: "root",
    elementType: diagram.id,
    name: "车辆组成",
    status: "pending"
  };
  const receipt = await ctx.host.editExecutor.apply([operation], { title: "建图" });
  assert.match(receipt, /diagramId=new-1/);
  assert.equal(ctx.calls.addModel[0].isAutoOpenDiagram, true);
  assert.equal(operation.revert.elementId, "new-1");
});

test("an unknown explicit diagram never falls back to the visible diagram", async () => {
  const ctx = setup();
  const receipt = await ctx.host.editExecutor.apply([createShapeOp({ diagramId: "missing-diagram" })], { title: "建图形" });
  assert.match(receipt, /不会改用其他图表/);
  assert.equal(ctx.shapeState.shapes.length, 1);
});

test("stale inactive canvas caches cannot hide a newly placed shape", async () => {
  const ctx = setup();
  const root = ctx.shapeState.shapes[0];
  ctx.project.ui.graphTabs[0].graph = { rootShape: root, shapeMap: new Map([[root.id, root]]), getChildren: () => [root] };
  const op = { id: "fresh", type: "place-shape", diagramId: "diagram-1", elementId: "sys-1", summary: "摆放", status: "pending" };
  const result = await ctx.host.editExecutor.apply([op], { title: "摆放" });
  assert.equal(op.status, "completed");
  assert.match(result, /placed-1/);
  assert.match(await ctx.host.diagram.readShapes("diagram-1"), /placed-1/);
});

test("diagram frame does not push new shapes outside the canvas", async () => {
  const ctx = setup();
  const op = createShapeOp();
  await ctx.host.editExecutor.apply([op], { title: "创建" });
  const shape = ctx.shapeState.shapes.find(item => item.id === op.shapeIds);
  assert.equal(shape.bounds.x, 80);
  assert.equal(shape.bounds.y, 80);
});

test("create-shape rejects binding an existing element instead of creating a duplicate", async () => {
  const ctx = setup();
  const result = await ctx.host.editExecutor.apply([createShapeOp({ elementId: "sys-1" })], { title: "创建" });
  assert.match(result, /请使用 place-shape/);
  assert.equal(ctx.shapeState.shapes.length, 1);
});
