import { isElectron } from "./runtime";
import { memoryIdentity } from "../ai-assistant/memory";
import { configureAiAssistant } from "../ai-assistant/host";
import type { AiAssistantHost, AiDiagramHost, AiModelHost, AiModelMention } from "../ai-assistant/host";
import { hasRefPrefix, parseRefExpression, refFieldKind, REF_MODEL_FIELDS, REF_SHAPE_FIELDS } from "../ai-assistant/changes/refs";
import type { AiChangeOperation, AiContextSnapshot, AiProviderSettings } from "../ai-assistant/types";

/**
 * M-Design 宿主适配层。
 *
 * 把 M-Design 客户端的模型树、属性、图表与画布接口接到 ai-assistant 的宿主契约上：
 * - 只读访问走宿主 service（modelService / shapeService / projectService）与 project.nodePool；
 * - 写操作只在用户确认提案（或编辑模式直接执行）时调用宿主真实接口，并写入可回滚的逆操作；
 * - M-Design 没有 SysML 文本模型与文本语言服务，文本能力返回明确不可用，
 *   由 host.features.sysmlText=false 让工具集里不出现文本类工具。
 *
 * 所有 window.app / window.api 访问都在函数内进行，插件加载时（应用可能尚未就绪）不取实例。
 */

/* ------------------------------------------------------------------ *
 * 宿主运行时类型（只声明用到的部分）
 * ------------------------------------------------------------------ */

interface HostApp {
  activeProject?: HostProject;
  projectManager: { getProject(id: string): HostProject | undefined };
  licenseState?: { hasSysMLPermission?(): boolean };
  global?: {
    user?: { id?: string | number; host?: string };
    insertConnectPosition?: string;
  };
}

interface HostProject {
  id: string;
  readonly: boolean;
  config: { id: string; name?: string };
  ui: { isDisplayMode?: boolean; graphTabs?: HostGraphTab[]; activeTabId?: string };
  nodePool: HostNodePool;
  isEditable(): boolean;
}

interface HostNodePool {
  rootNodes?: HostNode[];
  getRootNodeId?(): string | undefined;
  getNode(id: string): HostNode | undefined;
  getChildNodes(id: string): HostNode[];
  getSelectedNodes(): HostNode[];
  loadNodes(node: HostNode): Promise<void>;
  loadNodesWhenSelectOnTree?(pathModelIds: string[], nodeDatas: unknown[]): Promise<void>;
}

interface HostNode {
  id: string;
  data: HostNodeData;
  loaded?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

interface HostNodeData {
  id: string;
  name?: string;
  ownerId?: string;
  metaclass?: string | null;
  hasChild?: boolean;
  sourceId?: string;
  targetId?: string;
  visible?: boolean;
}

interface HostBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  absX?: number;
  absY?: number;
}

interface HostShape {
  id: string;
  name?: string;
  modelName?: string;
  shapeKey?: string;
  shapeType?: string;
  subShapeType?: string;
  modelId?: string;
  sourceId?: string;
  targetId?: string;
  parentId?: string | null;
  diagramId?: string;
  bounds?: HostBounds;
  waypoint?: Array<{ x: number; y: number }>;
}

interface HostGraphModel {
  rootShape?: HostShape;
  shapeMap?: Map<string, HostShape>;
  getShape?(id: string): HostShape | undefined;
  getChildren?(parentId: string | null): HostShape[];
}

interface HostGraphTab {
  id: string;
  modelId: string;
  diagramName?: string;
  visible?: boolean;
  diagramModel?: { id: string; name?: string; sts?: string[]; ownerId?: string };
  modelBaseSt?: string | null;
  graph?: HostGraphModel;
}

interface HostPropertyRow {
  key: string;
  name?: string;
  displayName?: string;
  value?: unknown;
  dataType?: string;
  isMultiplicity?: boolean;
  readonly?: boolean;
}

interface HostModelData {
  id: string;
  name?: string;
  ownerId?: string;
  metaclass?: string | null;
  sts?: string[];
  appliedStereotypes?: string[];
  hasChild?: boolean;
  sourceId?: string;
  targetId?: string;
}

interface HostMenuItem {
  metaclass?: string;
  sts?: string[];
  appliedStereotypes?: string[];
  cnName?: string;
  enName?: string;
  label?: string;
  children?: HostMenuItem[];
  isDiagram?: boolean;
  [p: string]: unknown;
}

interface HostPaletteItem {
  modelId?: string;
  operation?: string;
  operationParam?: unknown;
  payload?: Record<string, unknown>;
  dropdownTag?: string;
  showData?: { name?: string; siderBarkey?: string; metaclass?: string };
  children?: HostPaletteItem[];
}

interface HostPaletteGroup {
  id?: string;
  name?: string;
  children?: HostPaletteItem[];
}

interface HostServices {
  modelService: {
    getNodePath(projectId: string, modelId: string, tipError?: boolean): Promise<HostModelData[]>;
    getNodesWhenSelectOnTree(projectId: string, modelIds: string[]): Promise<unknown[]>;
    getChildNodeDatas(projectId: string, ownerId: string): Promise<unknown[]>;
    getModelData(projectId: string, modelId: string): Promise<HostModelData>;
    getModelDatas(projectId: string, modelIds: string[]): Promise<HostModelData[]>;
    modelSearch(projectId: string, name: string): Promise<HostModelData[]>;
    getCanCreateDiagramTypes(projectId: string, ownerId: string, hasSysMLPermission: boolean): Promise<HostMenuItem[]>;
    getCanCreateChildTypes(projectId: string, ownerId: string, hasSysMLPermission: boolean): Promise<HostMenuItem[]>;
    addModel(
      projectId: string,
      ownerId: string,
      metaclass: string,
      sts?: string[],
      fileInfo?: unknown,
      isAutoOpenDiagram?: boolean,
      payload?: unknown,
      defaultName?: string,
      operation?: string
    ): Promise<HostModelData[]>;
    renameNode(projectId: string, modelId: string, name: string): Promise<unknown>;
    updateModelProperty(dto: {
      projectId: string;
      instanceId: string;
      key: string;
      value: unknown;
      dataType?: string;
      isMultiplicity?: boolean;
      updateMethod?: null;
    }): Promise<unknown>;
    getModelProperties(projectId: string, modelId: string, level?: number): Promise<HostPropertyRow[]>;
    removeModel(projectId: string, modelIds: string[]): Promise<unknown>;
  };
  shapeService: {
    getDiagramAllShape(projectId: string, modelId: string): Promise<HostShape[]>;
    siderBarItemDropValidate(data: Record<string, unknown>): Promise<Array<{ name: string; key: string; priority?: number }>>;
    siderBarItemDrop(data: Record<string, unknown>, tipError?: boolean): Promise<{ shapeId?: string; modelId?: string }>;
    treeDropShape(data: Record<string, unknown>, tipError?: boolean): Promise<unknown>;
    isValidConnectSource(projectId: string, diagramId: string, sourceShapeId: string, edgeKey: string): Promise<boolean>;
    isValidConnectTarget(
      projectId: string,
      diagramId: string,
      sourceShapeId: string,
      edgeKey: string,
      targetShapeId: string,
      tipError?: boolean
    ): Promise<boolean>;
    connectShape(data: Record<string, unknown>, tipError?: boolean): Promise<{ data?: { createdShapes?: HostShape[] } }>;
    removeShape(projectId: string, diagramId: string, shapeIds: string[]): Promise<unknown>;
    deleteShape(projectId: string, diagramId: string, shapeIds: string[]): Promise<unknown>;
    moveShape(projectId: string, diagramId: string, shapeIds: string[], dx: number, dy: number): Promise<HostShape[]>;
    /**
     * 宿主快速布局（/shape/quickLayout）。
     *
     * 传 shapeIds 走局部布局；返回值为宿主原始结果：
     * undefined（未执行：可能为宿主不支持该图种的关系布局，或没有可布局的图形）、"Different Levels"、"Not Supported Graph"
     * 或成功时的布局结果对象。
     */
    handleShapesQucikLayout(
      projectId: string,
      diagramId: string,
      direction: string,
      layoutType: string,
      orderBy?: string,
      shapeIds?: string[]
    ): Promise<unknown>;
  };
  projectService: {
    getDiagramConfigForView(projectId: string, modelId: string): Promise<{ siderbarConfig?: HostPaletteGroup[] }>;
  };
  storage: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    remove(key: string): void;
  };
}

/* ------------------------------------------------------------------ *
 * 运行时取值
 * ------------------------------------------------------------------ */

interface HostWindow extends Window {
  app?: HostApp;
}

function hostWindow(): HostWindow {
  return window as HostWindow;
}

function hostApp(): HostApp {
  const app = hostWindow().app;
  if (!app) throw new Error("请在 M-Design 中打开此插件");
  return app;
}

function hostServices(): HostServices {
  const api = window.api as unknown as HostServices;
  if (!api?.modelService) throw new Error("M-Design 插件接口尚未就绪，请重新打开 AI 助手");
  return api;
}

function activeProject(): HostProject | undefined {
  return hostApp().activeProject;
}

function requireProject(): HostProject {
  const project = activeProject();
  if (!project) throw new Error("请先打开项目");
  return project;
}

function hasSysMLPermission(): boolean {
  return hostApp().licenseState?.hasSysMLPermission?.() ?? true;
}

/** 目标项目可写性：与宿主对创建/修改的检查保持一致 */
function assertEditable(project: HostProject, elementId?: string): void {
  if (hostApp().activeProject?.id !== project.id) throw new Error("目标项目已关闭或切换，请重新打开助手");
  if (!project.isEditable() || project.readonly || project.ui.isDisplayMode) throw new Error("当前项目不可编辑，不能修改模型");
  if (elementId && project.nodePool.getNode(elementId)?.disabled) throw new Error("目标元素不可编辑（可能来自标准库或已封装）");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * 模型读取
 * ------------------------------------------------------------------ */

const MAX_TREE_DEPTH = 8;
const MAX_TREE_NODES = 300;
const MAX_SEARCH_RESULTS = 30;

/** 节点池里的 GraphNode 与接口返回的 ModelData 都可以用来取名称与类型 */
function isHostNode(value: HostNode | HostModelData | undefined): value is HostNode {
  return Boolean(value && (value as HostNode).data);
}

function nodeLabel(node: HostNode | HostModelData | undefined): string {
  if (!node) return "(未知)";
  if (isHostNode(node)) return node.data.name || "(未命名)";
  return node.name || "(未命名)";
}

function nodeMetaclass(node: HostNode | HostModelData | undefined): string {
  if (!node) return "未知类型";
  const metaclass = isHostNode(node) ? node.data.metaclass : node.metaclass;
  return String(metaclass || "未知类型");
}

function formatNodeLine(node: HostNode): string {
  const data = node.data;
  const pending = data.hasChild && node.loaded === false ? "（子节点未加载）" : "";
  return `${data.name || "(未命名)"} [${data.metaclass || "未知类型"}] id=${data.id}${pending}`;
}

function renderSubtree(
  nodes: HostNode[],
  project: HostProject,
  maxDepth: number,
  budget: { remaining: number },
  lines: string[],
  depth = 0
): void {
  for (const node of nodes) {
    if (budget.remaining <= 0) return;

    lines.push(`${"  ".repeat(depth)}- ${formatNodeLine(node)}`);
    budget.remaining -= 1;

    if (depth >= maxDepth || !node.data.hasChild) continue;
    renderSubtree(project.nodePool.getChildNodes(node.id), project, maxDepth, budget, lines, depth + 1);
  }
}

/**
 * 确保元素进入节点池（按需展开其祖先路径）。
 *
 * 与宿主“定位到模型树”的加载方式一致：先按后端返回的路径找第一个未展开的节点，
 * 再把路径节点批量加载进池子；失败时返回池子里已有的节点（可能为 undefined）。
 */
async function ensureElementLoaded(project: HostProject, elementId: string): Promise<HostNode | undefined> {
  const existing = project.nodePool.getNode(elementId);
  if (existing) return existing;

  const services = hostServices();
  const path = await services.modelService.getNodePath(project.id, elementId, false).catch(() => undefined);
  if (!path?.length) return undefined;

  const pool = project.nodePool;
  const firstNotLoaded = path.slice(0, -1).find(item => pool.getNode(item.id)?.loaded === false);
  const startIndex = firstNotLoaded ? path.indexOf(firstNotLoaded) : Math.max(path.length - 1, 0);
  const toLoadIds = path.slice(startIndex).map(item => item.id);

  const nodes = await services.modelService.getNodesWhenSelectOnTree(project.id, toLoadIds);
  if (pool.loadNodesWhenSelectOnTree) await pool.loadNodesWhenSelectOnTree(toLoadIds, nodes);
  return project.nodePool.getNode(elementId);
}

/** 按需加载子树（受节点预算约束），使 depth 在懒加载树上真正生效 */
async function loadSubtree(project: HostProject, parentId: string, depth: number, budget: { remaining: number }): Promise<void> {
  if (depth <= 0 || budget.remaining <= 0) return;

  const parentNode = project.nodePool.getNode(parentId);
  if (!parentNode) return;

  if (parentNode.data.hasChild && parentNode.loaded === false) {
    budget.remaining -= 1;
    await project.nodePool.loadNodes(parentNode).catch(() => undefined);
  }

  for (const child of project.nodePool.getChildNodes(parentId)) {
    if (budget.remaining <= 0) return;
    await loadSubtree(project, child.id, depth - 1, budget);
  }
}

async function getModelTree(options: { rootId?: string; maxDepth?: number; maxNodes?: number }): Promise<string> {
  const project = requireProject();
  const maxDepth = Math.min(Math.max(options.maxDepth ?? 3, 1), MAX_TREE_DEPTH);
  const budget = { remaining: Math.min(Math.max(options.maxNodes ?? MAX_TREE_NODES, 10), 1000) };

  let roots: HostNode[];
  if (options.rootId) {
    const node = await ensureElementLoaded(project, options.rootId);
    roots = node ? [node] : [];
  } else {
    roots = project.nodePool.rootNodes ?? [];
  }
  if (!roots.length) return "未找到模型根节点，模型树可能尚未加载完成";

  const lines: string[] = [];
  renderSubtree(roots, project, maxDepth, budget, lines);
  const truncated = budget.remaining <= 0 ? "\n（已达到节点上限，子树被截断）" : "";
  return `${lines.join("\n")}${truncated}`;
}

async function searchElements(keyword: string): Promise<string> {
  const project = requireProject();
  const results = await hostServices().modelService.modelSearch(project.id, keyword);
  if (!results.length) return `未找到与「${keyword}」匹配的元素`;

  return results
    .slice(0, MAX_SEARCH_RESULTS)
    .map(
      item => `- ${item.name || item.id} [${item.metaclass || "未知类型"}] id=${item.id}${item.ownerId ? ` ownerId=${item.ownerId}` : ""}`
    )
    .join("\n");
}

async function pickMentions(): Promise<AiModelMention[]> {
  const project = requireProject();
  const api = hostWindow().api as unknown as {
    modelTreeSelectWindow?: {
      popup(
        params: Record<string, unknown>
      ): Promise<{ success?: boolean; selectedId?: string | string[]; selectedName?: string | string[] }>;
    };
  };
  const selectWindow = api.modelTreeSelectWindow;
  if (!selectWindow) return [];

  const result = await selectWindow
    .popup({
      loadMethod: "getModelTreeSelectData",
      loadParams: JSON.stringify({ row: {}, projectId: project.id }),
      attrTip: "checkbox",
      title: "选择模型元素",
      // checkable 模式支持多选（与宿主“选择校验对象范围”弹窗的用法一致）
      checkable: true,
      delay: false,
      showNodeLabel: true,
      projectId: project.id
    })
    .catch(() => undefined);
  if (!result?.success) return [];

  const ids = Array.isArray(result.selectedId) ? result.selectedId : result.selectedId ? [result.selectedId] : [];
  const names = Array.isArray(result.selectedName) ? result.selectedName : result.selectedName ? [result.selectedName] : [];
  const mentions: AiModelMention[] = [];
  for (const [index, id] of ids.entries()) {
    const node = project.nodePool.getNode(id) ?? (await ensureElementLoaded(project, id));
    mentions.push({
      id,
      title: node ? nodeLabel(node) : names[index] || id,
      type: node ? nodeMetaclass(node) : "未知类型"
    });
  }
  return mentions;
}

async function getElement(elementId: string): Promise<string> {
  const project = requireProject();
  const node = await ensureElementLoaded(project, elementId);
  const model = node
    ? undefined
    : await hostServices()
        .modelService.getModelData(project.id, elementId)
        .catch(() => undefined);
  if (!node && !model) return `未找到元素 ${elementId}（可用 model_search 按名称检索）`;

  const ownerId = (isHostNode(node) ? node.data.ownerId : model?.ownerId) || "";
  const hasChild = isHostNode(node) ? node.data.hasChild : model?.hasChild;
  const parent = ownerId ? project.nodePool.getNode(ownerId) : undefined;
  const children = project.nodePool.getChildNodes(elementId);

  const lines = [
    `名称: ${nodeLabel(node ?? model)}`,
    `类型: ${nodeMetaclass(node ?? model)}`,
    `id: ${elementId}`,
    `ownerId: ${ownerId || "(无)"}`,
    parent ? `父元素: ${formatNodeLine(parent)}` : "父元素: (不在已加载范围内)",
    `子元素: ${children.length ? `${children.length} 个已加载子节点` : hasChild ? "有子元素但尚未加载（可用 model_get_children 读取）" : "无"}`
  ];

  const childPreview = children.slice(0, 20).map(child => `  - ${formatNodeLine(child)}`);
  if (childPreview.length) lines.push(...childPreview);
  return lines.join("\n");
}

async function getElementChildren(elementId: string, depth = 1): Promise<string> {
  const project = requireProject();
  const node = await ensureElementLoaded(project, elementId);
  if (!node) return `未找到元素 ${elementId}（可用 model_search 按名称检索）`;

  const maxDepth = Math.min(Math.max(depth, 1), MAX_TREE_DEPTH);
  await loadSubtree(project, elementId, maxDepth, { remaining: 40 });

  const children = project.nodePool.getChildNodes(elementId);
  if (!children.length) return `元素 ${elementId} 没有可见子元素`;

  const budget = { remaining: 400 };
  const lines: string[] = [];
  renderSubtree(children, project, maxDepth, budget, lines);
  return lines.join("\n");
}

async function getElementRelationships(elementId: string): Promise<string> {
  const project = requireProject();
  const node = await ensureElementLoaded(project, elementId);
  if (!node) return `未找到元素 ${elementId}（可用 model_search 按名称检索）`;

  if (node.data.hasChild && node.loaded === false) await project.nodePool.loadNodes(node).catch(() => undefined);

  const relations = project.nodePool.getChildNodes(`${elementId}-relations`);
  if (!relations.length) return `元素 ${elementId} 没有已加载的关系子节点`;

  return relations
    .map(item => {
      const data = item.data;
      const source = data.sourceId ? ` sourceId=${data.sourceId}` : "";
      const target = data.targetId ? ` targetId=${data.targetId}` : "";
      return `- ${data.name || "(未命名)"} [${data.metaclass || "关系"}] id=${data.id}${source}${target}`;
    })
    .join("\n");
}

/** 属性值转成一行文本；INSTANCE 等对象值取其 id/name */
function formatPropertyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    const record = value as { id?: unknown; name?: unknown };
    if (record.id !== undefined) return String(record.id);
    if (record.name !== undefined) return String(record.name);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

async function getProperties(elementId: string, propertyNames?: string[]): Promise<string> {
  const project = requireProject();
  const rows = await hostServices().modelService.getModelProperties(project.id, elementId);
  if (!rows?.length) return `元素 ${elementId} 没有可读属性（元素可能不存在或尚未加载）`;

  const selected = propertyNames?.length
    ? rows.filter(row => propertyNames.some(name => name === row.key || name === row.name || name === row.displayName))
    : rows;
  if (!selected.length)
    return `元素 ${elementId} 未找到指定属性：${propertyNames?.join("、")}；请检查名称或不传 propertyNames 查看属性列表。`;

  return selected
    .map(row => {
      const readonly = row.readonly ? "（只读）" : "";
      const value = formatPropertyValue(row.value);
      const current =
        !propertyNames?.length && value.length > 512
          ? "当前值未提供（内容较长，请用 propertyNames 指定此 propertyKey 读取完整当前值后再修改）"
          : `当前值: ${value}`;
      return `- ${row.name || row.displayName || row.key}${readonly}（propertyKey=${row.key}）${current}，类型: ${row.dataType ?? "未知"}`;
    })
    .join("\n");
}

/** M-Design 没有 SysML 文本模型；保持接口并提供明确不可用说明 */
function unsupportedTextAction(): string {
  return "当前宿主（M-Design）没有 SysML 文本模型与文本语言服务：不支持读取/校验/改写 SysML 文本。请改用元素与属性操作（create-element / update-property / delete-element）或画布操作表达改动。";
}

/* ------------------------------------------------------------------ *
 * 图表读取与写操作
 * ------------------------------------------------------------------ */

function diagramNameOf(tab: HostGraphTab): string {
  return tab.diagramName || tab.diagramModel?.name || tab.modelId;
}

/** 解析目标图表：优先按 id 或名称匹配，其次当前可见图表，最后第一个 */
function resolveDiagramTab(diagramId?: string): HostGraphTab | undefined {
  const tabs = activeProject()?.ui.graphTabs ?? [];
  if (!tabs.length) return undefined;

  const wanted = diagramId?.trim();
  if (wanted) {
    const matched = tabs.find(tab => tab.modelId === wanted || tab.id === wanted || diagramNameOf(tab) === wanted);
    if (matched) return matched;
    throw new Error(`目标图表 ${wanted} 未打开，请先打开该图表；不会改用其他图表`);
  }
  return tabs.find(tab => tab.visible) ?? tabs[0];
}

function requireDiagramTab(diagramId?: string): HostGraphTab {
  const tab = resolveDiagramTab(diagramId);
  if (!tab) throw new Error("当前项目没有已打开的图表；请先在界面上打开目标图表");
  return tab;
}

/** 读取后端图形快照；非激活画布不会及时接收推送，不能用缓存确认写入结果。 */
async function listDiagramShapes(tab: HostGraphTab): Promise<HostShape[]> {
  const project = requireProject();
  return hostServices().shapeService.getDiagramAllShape(project.id, tab.modelId);
}

function shapePosition(shape: HostShape): { x: number; y: number } {
  const bounds = shape.bounds;
  return { x: Math.round(bounds?.absX ?? bounds?.x ?? 0), y: Math.round(bounds?.absY ?? bounds?.y ?? 0) };
}

function shapeSize(shape: HostShape): { width: number; height: number } {
  return { width: shape.bounds?.width ?? 0, height: shape.bounds?.height ?? 0 };
}

function formatShapeLine(shape: HostShape): string {
  const name = shape.name || shape.modelName || "(未命名)";
  const configId = shape.shapeKey || shape.subShapeType || "";
  const elementId = shape.modelId ? ` elementId=${shape.modelId}` : "";
  const position = shapePosition(shape);
  const parts = [`- ${name} [${configId}] id=${shape.id}${elementId} 位置(${position.x}, ${position.y})`];
  if (shape.shapeType === "Edge") parts.push(`连线 ${shape.sourceId} → ${shape.targetId}`);
  return parts.join(" ");
}

function renderShapes(graph: HostGraphModel | undefined, shapes: HostShape[], lines: string[], budget: { remaining: number }): void {
  if (graph?.getChildren) {
    const walk = (parentId: string | null, depth: number) => {
      for (const shape of graph.getChildren!(parentId)) {
        if (budget.remaining <= 0) return;
        budget.remaining -= 1;
        lines.push(`${"  ".repeat(depth)}${formatShapeLine(shape)}`);
        walk(shape.id, depth + 1);
      }
    };
    if (graph.rootShape) walk(null, 0);
    if (lines.length) return;
  }

  for (const shape of shapes) {
    if (budget.remaining <= 0) return;
    budget.remaining -= 1;
    lines.push(formatShapeLine(shape));
  }
}

async function readShapes(diagramId?: string, maxNodes = 300): Promise<string> {
  const tab = resolveDiagramTab(diagramId);
  if (!tab) return "当前项目没有已打开的图表";

  const shapes = await listDiagramShapes(tab);
  if (!shapes.length) return `图表「${diagramNameOf(tab)}」当前没有图形`;

  const budget = { remaining: Math.min(Math.max(maxNodes, 10), 1000) };
  const lines: string[] = [];
  renderShapes(undefined, shapes, lines, budget);
  const truncated = budget.remaining <= 0 ? "\n（已达到图形数量上限，仅显示部分）" : "";
  return `图表: ${diagramNameOf(tab)}（diagramId=${tab.modelId}）\n${lines.join("\n")}${truncated}`;
}

/** 展平组件区清单：dropdown 分组节点也递归进来 */
function collectPaletteEntries(items: HostPaletteItem[], depth: number, lines: string[], entries: Map<string, HostPaletteItem>): void {
  for (const item of items) {
    const siderBarkey = item.showData?.siderBarkey;
    const label = item.showData?.name || item.operation || siderBarkey || "(未命名组件)";
    if (siderBarkey) {
      entries.set(siderBarkey, item);
      lines.push(`${"  ".repeat(depth)}- ${label}（elementConfigId=${siderBarkey}）`);
    } else {
      lines.push(`${"  ".repeat(depth)}${label}`);
    }
    if (item.children?.length && !siderBarkey) collectPaletteEntries(item.children, depth + 1, lines, entries);
  }
}

async function readPalette(diagramId?: string): Promise<string> {
  const tab = resolveDiagramTab(diagramId);
  if (!tab) return "当前项目没有已打开的图表";

  const project = requireProject();
  const diagramStId = tab.diagramModel?.sts?.[0];
  if (!diagramStId) return `图表「${diagramNameOf(tab)}」缺少视图类型（sts），无法读取组件清单`;

  const config = await hostServices().projectService.getDiagramConfigForView(project.id, diagramStId);
  const groups = config?.siderbarConfig ?? [];
  if (!groups.length) return `未取到图表「${diagramNameOf(tab)}」的组件清单`;

  const lines: string[] = [];
  const entries = new Map<string, HostPaletteItem>();
  for (const group of groups) {
    lines.push(`${group.name || group.id || "组件组"}`);
    collectPaletteEntries(group.children ?? [], 1, lines, entries);
  }
  if (!lines.length) return `图表「${diagramNameOf(tab)}」的组件清单为空`;
  return `图表: ${diagramNameOf(tab)}（diagramId=${tab.modelId}）\n${lines.join("\n")}`;
}

function listDiagrams(): Promise<string> {
  const tabs = activeProject()?.ui.graphTabs ?? [];
  if (!tabs.length) return Promise.resolve("当前项目没有已打开的图表");

  return Promise.resolve(
    tabs
      .map(tab => {
        const loaded = tab.graph?.shapeMap?.size ? "已加载图形" : "未加载图形";
        const active = tab.visible ? "，当前可见" : "";
        return `- ${diagramNameOf(tab)} diagramId=${tab.modelId}（${loaded}${active}）`;
      })
      .join("\n")
  );
}

/* ------------------------------------------------------------------ *
 * 变更执行（提案确认与编辑模式共用）
 * ------------------------------------------------------------------ */

/** 本提案新建的图形（记录所属图表，arrange-shapes 缺省只整理目标图内的新建图形） */
interface CreatedShapeRecord {
  shapeId: string;
  diagramId: string;
}

/** 本地引用名解析出的真实对象：模型元素 id 与图形 id 分开存，按字段语义取用 */
interface ProposalRefTarget {
  operationId: string;
  modelId?: string;
  shapeId?: string;
  diagramId?: string;
}

const createdShapeIdsByProposal = new Map<string, CreatedShapeRecord[]>();
const refTargetsByProposal = new Map<string, Map<string, ProposalRefTarget>>();

function trackCreatedShape(proposalId: string, shapeId: string, diagramId: string): void {
  const records = createdShapeIdsByProposal.get(proposalId);
  if (records) records.push({ shapeId, diagramId });
  else createdShapeIdsByProposal.set(proposalId, [{ shapeId, diagramId }]);
}

/** 登记操作的本地引用名；未声明 ref 的操作不登记 */
function recordRefTarget(proposalId: string, operation: AiChangeOperation, target: Omit<ProposalRefTarget, "operationId">): void {
  if (!operation.ref) return;
  let table = refTargetsByProposal.get(proposalId);
  if (!table) {
    table = new Map();
    refTargetsByProposal.set(proposalId, table);
  }
  table.set(operation.ref, { operationId: operation.id, ...target });
}

function releaseProposalScope(proposalId: string): void {
  createdShapeIdsByProposal.delete(proposalId);
  refTargetsByProposal.delete(proposalId);
}

/**
 * 解析操作里的 @ref:名称 引用字段：按字段语义取模型元素 id 或图形 id。
 *
 * 找不到对应结果、种类不符或跨图表引用图形时抛错（不静默降级或改用名称匹配）；
 * 引用只能指向本提案中更早已成功执行并登记的操作。
 */
function resolveOperationRefs(operation: AiChangeOperation, proposalId: string): void {
  const table = refTargetsByProposal.get(proposalId);

  const resolve = (field: string, value: string): string => {
    const name = parseRefExpression(value);
    if (!name) throw new Error(`${field} 的「${value}」不是有效的引用表达式（应为 @ref:名称）`);

    const target = table?.get(name);
    if (!target) throw new Error(`${field} 引用的「${name}」没有对应的已完成操作（引用只能指向本提案中更早成功执行的操作）`);

    const kind = refFieldKind(field) ?? "shape";
    if (kind === "model") {
      if (!target.modelId) throw new Error(`${field} 引用的「${name}」对应的操作没有生成模型元素 id，无法引用（例如纯图形组件不建模型）`);
      return target.modelId;
    }

    if (!target.shapeId) throw new Error(`${field} 引用的「${name}」对应的操作没有生成图形 id，无法引用`);
    const currentDiagram = resolveDiagramTab(operation.diagramId)?.modelId;
    if (target.diagramId && currentDiagram && target.diagramId !== currentDiagram) {
      throw new Error(`${field} 引用的「${name}」是另一个图表（diagramId=${target.diagramId}）里的图形，不能跨图表引用`);
    }
    return target.shapeId;
  };

  for (const field of [...REF_MODEL_FIELDS, ...REF_SHAPE_FIELDS]) {
    const value = operation[field];
    if (typeof value !== "string" || !value.trim() || !hasRefPrefix(value)) continue;
    operation[field] = resolve(field, value);
  }

  if (typeof operation.shapeIds === "string" && hasRefPrefix(operation.shapeIds)) {
    operation.shapeIds = operation.shapeIds
      .split(",")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => (hasRefPrefix(item) ? resolve("shapeIds", item) : item))
      .join(",");
  }
}

function requireField(operation: AiChangeOperation, field: keyof AiChangeOperation): string {
  const value = operation[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`操作缺少 ${String(field)}`);
  return value.trim();
}

/** 可创建元素类型的编码：metaclass 或 metaclass::st1,st2（与 model_get_creatable_element_types 的返回值一致） */
function encodeElementType(metaclass: string, sts: string[]): string {
  return sts.length ? `${metaclass}::${sts.join(",")}` : metaclass;
}

function decodeElementType(value: string, sts: string[]): { metaclass: string; sts: string[] } | undefined {
  const index = value.indexOf("::");
  if (index < 0) return { metaclass: value, sts: [] };
  const metaclass = value.slice(0, index);
  const list = value
    .slice(index + 2)
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  return metaclass && list.length ? { metaclass, sts: list } : undefined;
}

/** 宿主把普通元素与图表分成两个菜单；展平图表分组后统一交给 create-element。 */
async function creatableTypes(projectId: string, containerId: string): Promise<HostMenuItem[]> {
  const service = hostServices().modelService;
  const children = await service.getCanCreateChildTypes(projectId, containerId, hasSysMLPermission());
  const diagramGroups = await service.getCanCreateDiagramTypes(projectId, containerId, hasSysMLPermission());
  const diagrams: HostMenuItem[] = [];
  const collect = (items: HostMenuItem[]) => {
    for (const item of items) {
      if (item.metaclass) diagrams.push({ ...item, isDiagram: true });
      if (item.children?.length) collect(item.children);
    }
  };
  collect(diagramGroups);
  return [...children, ...diagrams];
}

/** 把模型给出的 elementType 解析到容器允许的类型；支持逐字 id、中文名与唯一末段名 */
function resolveCreatableElementType(requested: string, options: HostMenuItem[]): { metaclass: string; sts: string[] } | undefined {
  for (const item of options) {
    const metaclass = String(item.metaclass ?? "");
    const sts = item.appliedStereotypes ?? item.sts ?? [];
    if (!metaclass) continue;
    const encoded = encodeElementType(metaclass, sts);
    if (encoded === requested) return { metaclass, sts };
    if (metaclass === requested && !sts.length) return { metaclass, sts };
  }

  // 中文名 / 唯一尾段名兜底：模型经常只写 Package、部件 这类短名
  const matches = options.filter(item => {
    const metaclass = String(item.metaclass ?? "");
    const label = String(item.cnName ?? item.label ?? item.enName ?? "");
    return (
      label === requested ||
      metaclass.toLowerCase() === requested.toLowerCase() ||
      metaclass.toLowerCase().endsWith(`.${requested.toLowerCase()}`)
    );
  });
  if (matches.length !== 1) return undefined;

  const metaclass = String(matches[0].metaclass ?? "");
  const sts = matches[0].appliedStereotypes ?? matches[0].sts ?? [];
  return metaclass ? { metaclass, sts } : undefined;
}

function describeCreatableTypes(options: HostMenuItem[], limit = 12): string {
  return options
    .slice(0, limit)
    .map(item => encodeElementType(String(item.metaclass ?? ""), item.appliedStereotypes ?? item.sts ?? []))
    .join("、");
}

/** 创建后等待新节点进入节点池（后端推送式更新），用于把真实 id 回写给模型 */
async function waitForCreatedNode(
  project: HostProject,
  containerId: string,
  existingIds: Set<string>,
  expectedId?: string
): Promise<HostNode | undefined> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const created = project.nodePool
      .getChildNodes(containerId)
      .find(node => (expectedId ? node.id === expectedId : !existingIds.has(node.id)));
    if (created) return created;
    await sleep(80);
  }
  return project.nodePool.getChildNodes(containerId).find(node => (expectedId ? node.id === expectedId : !existingIds.has(node.id)));
}

async function executeCreateElement(operation: AiChangeOperation, proposalId: string, project: HostProject): Promise<string> {
  const containerId = requireField(operation, "containerId");
  const requestedType = requireField(operation, "elementType");
  const name = requireField(operation, "name");

  assertEditable(project, containerId);
  const container = await ensureElementLoaded(project, containerId);
  if (!container) throw new Error(`未找到容器元素 ${containerId}（可用 model_search 确认 id）`);

  const options = await creatableTypes(project.id, containerId);
  const resolved = resolveCreatableElementType(requestedType, options);
  if (!resolved) {
    throw new Error(
      `容器「${nodeLabel(container)}」不支持元素类型「${requestedType}」；请先调用 model_get_creatable_element_types，可用类型示例：${describeCreatableTypes(options)}`
    );
  }

  // 容器子节点必须先加载：未加载的父节点在创建后不会重新请求子列表，新节点进不了节点池
  if (container.data.hasChild && container.loaded === false) {
    await project.nodePool.loadNodes(container).catch(() => undefined);
  }
  const beforeIds = new Set(project.nodePool.getChildNodes(containerId).map(node => node.id));

  const isDiagram = options.some(
    item =>
      item.isDiagram &&
      encodeElementType(String(item.metaclass), item.appliedStereotypes ?? item.sts ?? []) ===
        encodeElementType(resolved.metaclass, resolved.sts)
  );
  const createdModels = await hostServices().modelService.addModel(
    project.id,
    containerId,
    resolved.metaclass,
    resolved.sts,
    undefined,
    isDiagram,
    undefined,
    name
  );
  const createdId =
    createdModels?.find(model => model.metaclass === resolved.metaclass && model.ownerId === containerId)?.id ??
    createdModels?.find(model => model.metaclass === resolved.metaclass)?.id ??
    createdModels?.[0]?.id;
  if (!createdId) throw new Error(`创建「${name}」未返回元素 id`);

  const createdNode = await waitForCreatedNode(project, containerId, beforeIds, createdId);
  if (createdNode && createdNode.data.name !== name) {
    // 后端可能生成了默认名：按用户要求的名称改名，失败则如实报错
    await hostServices().modelService.renameNode(project.id, createdId, name);
  }

  recordRefTarget(proposalId, operation, { modelId: createdId });
  operation.result = isDiagram
    ? `已创建图表「${name}」（diagramId=${createdId}），已请求宿主打开图表；后续用 diagram_list 确认后再操作画布`
    : `已创建元素「${name}」(${createdId})`;
  operation.revert = {
    id: `${operation.id}-revert`,
    type: "delete-element",
    summary: `删除新建元素「${name}」`,
    elementId: createdId,
    status: "pending"
  };
  return operation.result;
}

/** 把模型给出的新值按属性类型转换 */
function convertPropertyValue(raw: string, row: HostPropertyRow): unknown {
  const value = raw.trim();
  switch (row.dataType) {
    case "Boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      throw new Error(`属性「${row.name || row.key}」是布尔类型，newValue 必须是 true 或 false`);
    case "Integer":
    case "Real":
    case "UnlimitedNatural": {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`属性「${row.name || row.key}」是数值类型，newValue 必须是数字`);
      return parsed;
    }
    default:
      return raw;
  }
}

async function executeUpdateProperty(operation: AiChangeOperation, project: HostProject): Promise<string> {
  const elementId = requireField(operation, "elementId");
  const propertyKey = requireField(operation, "propertyKey");
  const newValue = typeof operation.newValue === "string" ? operation.newValue : "";

  assertEditable(project, elementId);
  const rows = await hostServices().modelService.getModelProperties(project.id, elementId);
  const row = rows.find(item => item.key === propertyKey);
  if (!row) {
    const sample = rows
      .filter(item => !item.readonly)
      .slice(0, 12)
      .map(item => item.key)
      .join("、");
    throw new Error(`元素 ${elementId} 没有属性 ${propertyKey}；请先调用 model_get_properties。可写属性示例：${sample || "(无)"}`);
  }
  if (row.readonly) throw new Error(`属性「${row.name || row.key}」只读，不能修改`);

  const value = convertPropertyValue(newValue, row);
  const previous = formatPropertyValue(row.value);
  await hostServices().modelService.updateModelProperty({
    projectId: project.id,
    instanceId: elementId,
    key: propertyKey,
    value,
    dataType: row.dataType,
    isMultiplicity: row.isMultiplicity,
    updateMethod: null
  });

  // 回读校验：后端失败可能是静默的，属性没变就不算成功
  const after = (await hostServices().modelService.getModelProperties(project.id, elementId)).find(item => item.key === propertyKey);
  const applied = formatPropertyValue(after?.value);
  if (String(applied) !== String(newValue) && String(applied) !== String(value)) {
    throw new Error(`属性「${row.name || row.key}」提交后回读仍是「${applied || "(空)"}」，改动未生效`);
  }

  operation.result = `已把「${row.name || row.key}」从「${previous || "(空)"}」改为「${applied || "(空)"}」`;
  operation.revert = {
    id: `${operation.id}-revert`,
    type: "update-property",
    summary: `恢复属性「${row.name || row.key}」为「${previous || "(空)"}」`,
    elementId,
    propertyName: row.name || row.key,
    propertyKey,
    oldValue: applied,
    newValue: previous,
    status: "pending"
  };
  return operation.result;
}

async function executeDeleteElement(operation: AiChangeOperation, project: HostProject): Promise<string> {
  const elementId = requireField(operation, "elementId");
  assertEditable(project, elementId);
  const node = project.nodePool.getNode(elementId) ?? (await ensureElementLoaded(project, elementId));
  const label = nodeLabel(node) ?? elementId;
  await hostServices().modelService.removeModel(project.id, [elementId]);
  operation.result = `已删除元素「${label}」(${elementId})；删除不可撤销`;
  return operation.result;
}

function paletteItemOf(entries: Map<string, HostPaletteItem>, elementConfigId: string): HostPaletteItem | undefined {
  return entries.get(elementConfigId);
}

async function paletteEntriesOf(tab: HostGraphTab): Promise<Map<string, HostPaletteItem>> {
  const project = requireProject();
  const diagramStId = tab.diagramModel?.sts?.[0];
  if (!diagramStId) throw new Error(`图表「${diagramNameOf(tab)}」缺少视图类型（sts），无法校验组件`);

  const config = await hostServices().projectService.getDiagramConfigForView(project.id, diagramStId);
  const entries = new Map<string, HostPaletteItem>();
  for (const group of config?.siderbarConfig ?? []) {
    collectPaletteEntries(group.children ?? [], 0, [], entries);
  }
  return entries;
}

/** 模型读取用图表模型 ID，画布写入必须用根图形 ID，两者不能混用。 */
async function diagramShapeIdOf(tab: HostGraphTab): Promise<string> {
  const id = tab.graph?.rootShape?.id || rootShapeIdOf(await listDiagramShapes(tab));
  if (!id) throw new Error(`图表「${diagramNameOf(tab)}」没有根图形，无法执行画布操作`);
  return id;
}

function rootShapeIdOf(shapes: HostShape[]): string | undefined {
  return shapes.find(shape => shape.shapeType === "Diagram")?.id ?? shapes.find(shape => !shape.parentId)?.id;
}

function insertConnectPositionOf(): string | undefined {
  return hostApp().global?.insertConnectPosition;
}

/** 在画布找一块空闲位置，避免新图形压住已有图形 */
function findFreeSpot(shapes: HostShape[], preferred?: { x?: number; y?: number }): { x: number; y: number } {
  const rects = shapes
    .filter(shape => shape.shapeType !== "Edge" && shape.shapeType !== "Diagram")
    .map(shape => {
      const position = shapePosition(shape);
      const size = shapeSize(shape);
      return size.width > 0 && size.height > 0 ? { x: position.x, y: position.y, width: size.width, height: size.height } : undefined;
    })
    .filter((rect): rect is { x: number; y: number; width: number; height: number } => Boolean(rect));

  const originX = Math.round(preferred?.x ?? 80);
  const originY = Math.round(preferred?.y ?? 80);
  const probe = { x: 0, y: 0, width: 180, height: 100 };
  const stepX = probe.width + 40;
  const stepY = probe.height + 40;
  const overlap = (left: typeof probe, right: typeof probe) =>
    left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height;

  for (let row = 0; row < 20; row += 1) {
    for (let column = 0; column < 20; column += 1) {
      probe.x = originX + column * stepX;
      probe.y = originY + row * stepY;
      if (!rects.some(rect => overlap(probe, rect))) return { x: probe.x, y: probe.y };
    }
  }
  return { x: originX + rects.length * 20, y: originY + rects.length * 20 };
}

function readNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(`坐标必须是数字，收到「${value}」`);
  return parsed;
}

/** 组件区拖放的校验行为：取优先级最高的一个（多行为时不再弹菜单，由模型选择） */
function chooseBehavior(
  behaviors: Array<{ name: string; key: string; priority?: number }>,
  elementConfigId: string
): { key: string; name: string } {
  if (!behaviors.length) throw new Error(`图表目标容器不允许放置组件 ${elementConfigId}（siderBarItemDropValidate 返回空）`);
  const sorted = [...behaviors].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  return { key: sorted[0].key, name: sorted[0].name || sorted[0].key };
}

async function executeCreateShape(operation: AiChangeOperation, proposalId: string, project: HostProject): Promise<string> {
  const elementConfigId = requireField(operation, "elementConfigId");
  if (operation.elementId) throw new Error("create-shape 会新建模型；摆放已有 elementId 请使用 place-shape，未执行任何创建");
  const name = typeof operation.name === "string" ? operation.name.trim() : "";
  const tab = requireDiagramTab(operation.diagramId);
  assertEditable(project);

  const entries = await paletteEntriesOf(tab);
  const paletteItem = paletteItemOf(entries, elementConfigId);
  if (!paletteItem) {
    throw new Error(
      `图表「${diagramNameOf(tab)}」不支持组件 ${elementConfigId}（elementConfigId 必须逐字取自 diagram_read_palette 返回值）`
    );
  }

  const shapes = await listDiagramShapes(tab);
  const containerShapeId = operation.containerShapeId?.trim() || rootShapeIdOf(shapes);
  if (!containerShapeId) throw new Error(`图表「${diagramNameOf(tab)}」没有可用的容器图形`);
  const containerShape = shapes.find(shape => shape.id === containerShapeId);
  if (!containerShape) throw new Error(`未在图表「${diagramNameOf(tab)}」中找到容器图形 ${operation.containerShapeId}`);

  const behaviors = await hostServices().shapeService.siderBarItemDropValidate({
    projectId: project.id,
    diagramId: await diagramShapeIdOf(tab),
    siderBarKey: elementConfigId,
    shapeId: containerShapeId,
    shapeModelId: containerShape.modelId,
    // 与组件区拖放一致：带上组件自身的元类/构造型，后端按它校验
    stdId: paletteItem.modelId,
    diagramStdId: tab.diagramModel?.sts?.[0],
    insertConnectPosition: insertConnectPositionOf()
  });
  const behavior = chooseBehavior(behaviors, elementConfigId);

  const point = findFreeSpot(shapes, {
    x: readNumber(operation.x),
    y: readNumber(operation.y)
  });

  const result = await hostServices().shapeService.siderBarItemDrop(
    {
      projectId: project.id,
      diagramId: await diagramShapeIdOf(tab),
      point,
      targetShapeId: containerShapeId,
      sourceType: elementConfigId,
      behaviorKey: behavior.key,
      operation: paletteItem.operation,
      payload: {
        ...paletteItem.payload,
        ...(paletteItem.modelId && paletteItem.showData?.metaclass === "Stereotype" ? { applyStereotypes: [paletteItem.modelId] } : {}),
        insertConnectPosition: insertConnectPositionOf()
      }
    },
    false
  );

  const shapeId = result?.shapeId;
  if (!shapeId) throw new Error(`创建图形请求已发送，但没有返回图形 id；请用 diagram_read_shapes 确认结果`);

  let elementId = result?.modelId;
  if (name && elementId) {
    await hostServices().modelService.renameNode(project.id, elementId, name);
  } else if (name && !elementId) {
    // 部分纯图形组件不建元素：名称只记录在图形上，无法改名，如实说明
    elementId = undefined;
  }

  trackCreatedShape(proposalId, shapeId, tab.modelId);
  recordRefTarget(proposalId, operation, { shapeId, modelId: elementId, diagramId: tab.modelId });
  operation.shapeIds = shapeId;
  operation.diagramId = tab.modelId;
  operation.revert = {
    id: `${operation.id}-revert`,
    type: "delete-shape",
    summary: `移除新建图形${name ? `「${name}」` : ""}`,
    diagramId: tab.modelId,
    shapeIds: shapeId,
    revertScope: "shape-and-model",
    status: "pending"
  };
  operation.result = `已在「${diagramNameOf(tab)}」创建图形 id=${shapeId}（位置 ${point.x}, ${point.y}${elementId ? `，elementId=${elementId}` : ""}，行为：${behavior.name}）${name && !elementId ? "；该组件没有绑定模型元素，名称未设置" : ""}`;
  return operation.result;
}

/**
 * 从连线返回的图形集合里确定主对象。
 *
 * 连线会同时返回可能的标签图形（边名称、概率等），不能盲取第一个；
 * 只有恰好一条 Edge（或唯一一个图形）才算明确的主对象，否则返回 undefined。
 */
function pickCreatedMainShape(shapes: HostShape[]): HostShape | undefined {
  const edges = shapes.filter(shape => shape.shapeType === "Edge");
  if (edges.length === 1) return edges[0];
  if (shapes.length === 1) return shapes[0];
  return undefined;
}

/** 连线校验返回值必须明确为 true 才继续；false 与无法识别的值分别报错（网络/后端异常直接向上抛） */
async function requireConnectAllowed(kind: "起点" | "终点", check: Promise<unknown>, description: string): Promise<void> {
  let value: unknown;
  try {
    value = await check;
  } catch (error) {
    throw new Error(`连线${kind}校验请求失败（未执行连线）：${errorText(error)}`);
  }
  if (value === true) return;
  if (value === false) throw new Error(description);
  throw new Error(`连线${kind}校验返回了无法识别的结果（${String(value)}），出于安全未执行连线`);
}

/** 依据两端图形边界生成初始折线路径，宿主会继续处理吸附与连线样式。 */
function connectorWaypoints(source: HostShape, target: HostShape): Array<{ x: number; y: number }> {
  const a = { ...shapePosition(source), ...shapeSize(source) };
  const b = { ...shapePosition(target), ...shapeSize(target) };
  if (!a.width || !a.height || !b.width || !b.height) throw new Error("连线两端缺少有效边界，无法计算路径");
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (ac.x === bc.x && ac.y === bc.y) throw new Error("连线两端图形重叠，请先整理位置再连线");
  let points: Array<{ x: number; y: number }>;
  if (Math.abs(bc.x - ac.x) >= Math.abs(bc.y - ac.y)) {
    const sign = bc.x >= ac.x ? 1 : -1;
    const start = { x: ac.x + (sign * a.width) / 2, y: ac.y };
    const end = { x: bc.x - (sign * b.width) / 2, y: bc.y };
    const mid = (start.x + end.x) / 2;
    points = [start, { x: mid, y: start.y }, { x: mid, y: end.y }, end];
  } else {
    const sign = bc.y >= ac.y ? 1 : -1;
    const start = { x: ac.x, y: ac.y + (sign * a.height) / 2 };
    const end = { x: bc.x, y: bc.y - (sign * b.height) / 2 };
    const mid = (start.y + end.y) / 2;
    points = [start, { x: start.x, y: mid }, { x: end.x, y: mid }, end];
  }
  return points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
}

async function executeCreateConnector(operation: AiChangeOperation, proposalId: string, project: HostProject): Promise<string> {
  const edgeKey = requireField(operation, "elementConfigId");
  const sourceShapeId = requireField(operation, "sourceShapeId");
  const targetShapeId = requireField(operation, "targetShapeId");
  if (sourceShapeId === targetShapeId) throw new Error("连线的源图形与目标图形不能是同一个");

  const tab = requireDiagramTab(operation.diagramId);
  assertEditable(project);

  const entries = await paletteEntriesOf(tab);
  if (!paletteItemOf(entries, edgeKey)) {
    throw new Error(`图表「${diagramNameOf(tab)}」不支持连线组件 ${edgeKey}（elementConfigId 必须逐字取自 diagram_read_palette）`);
  }

  const shapes = await listDiagramShapes(tab);
  if (!shapes.some(shape => shape.id === sourceShapeId)) throw new Error(`未在图表「${diagramNameOf(tab)}」中找到源图形 ${sourceShapeId}`);
  if (!shapes.some(shape => shape.id === targetShapeId))
    throw new Error(`未在图表「${diagramNameOf(tab)}」中找到目标图形 ${targetShapeId}`);

  // 校验必须明确允许才继续：网络异常、后端异常与无法识别的返回值都不吞掉
  await requireConnectAllowed(
    "起点",
    hostServices().shapeService.isValidConnectSource(project.id, await diagramShapeIdOf(tab), sourceShapeId, edgeKey),
    `后端校验不允许从图形 ${sourceShapeId} 拉出 ${edgeKey} 连线（可用 diagram_read_palette 确认连线组件）`
  );
  await requireConnectAllowed(
    "终点",
    hostServices().shapeService.isValidConnectTarget(project.id, await diagramShapeIdOf(tab), sourceShapeId, edgeKey, targetShapeId, false),
    `后端校验不允许 ${edgeKey} 连接 ${sourceShapeId} → ${targetShapeId}（两端图形类型可能不匹配）`
  );

  const response = await hostServices().shapeService.connectShape(
    {
      projectId: project.id,
      diagramId: await diagramShapeIdOf(tab),
      sourceShapeId,
      targetShapeId,
      edgeKey,
      waypoint: connectorWaypoints(shapes.find(shape => shape.id === sourceShapeId)!, shapes.find(shape => shape.id === targetShapeId)!)
    },
    false
  );
  const createdShapes = response?.data?.createdShapes ?? [];
  const createdShape = pickCreatedMainShape(createdShapes);
  const createdShapeId = createdShape?.id;
  if (!createdShapeId) {
    throw new Error(
      `连线请求已发送，但没有返回可识别的连线图形（返回 ${createdShapes.length} 个图形，无法确定主对象）；请用 diagram_read_shapes 确认结果`
    );
  }

  trackCreatedShape(proposalId, createdShapeId, tab.modelId);
  recordRefTarget(proposalId, operation, { shapeId: createdShapeId, diagramId: tab.modelId });
  operation.shapeIds = createdShapeId;
  operation.diagramId = tab.modelId;
  operation.revert = {
    id: `${operation.id}-revert`,
    type: "delete-shape",
    summary: `移除新建连线`,
    diagramId: tab.modelId,
    shapeIds: createdShapeId,
    revertScope: "shape-and-model",
    status: "pending"
  };
  operation.result = `已创建连线 id=${createdShapeId}（${sourceShapeId} → ${targetShapeId}）`;
  return operation.result;
}

async function executePlaceShape(operation: AiChangeOperation, proposalId: string, project: HostProject): Promise<string> {
  const elementId = requireField(operation, "elementId");
  const tab = requireDiagramTab(operation.diagramId);
  assertEditable(project);

  const node = await ensureElementLoaded(project, elementId);
  if (
    !node &&
    !(await hostServices()
      .modelService.getModelData(project.id, elementId)
      .catch(() => undefined))
  ) {
    throw new Error(`未找到模型元素 ${elementId}（可用 model_search 按名称检索）`);
  }

  const shapes = await listDiagramShapes(tab);
  const beforeIds = new Set(shapes.map(shape => shape.id));
  const containerShapeId = operation.containerShapeId?.trim() || rootShapeIdOf(shapes);
  if (!containerShapeId) throw new Error(`图表「${diagramNameOf(tab)}」没有可用的容器图形`);

  const point = findFreeSpot(shapes, { x: readNumber(operation.x), y: readNumber(operation.y) });
  await hostServices().shapeService.treeDropShape(
    {
      projectId: project.id,
      point,
      shapeId: containerShapeId,
      modelId: elementId,
      diagramId: await diagramShapeIdOf(tab)
    },
    false
  );

  // 回读确认：拖入后后端推送新图形，画布/图形接口里应能看到绑定该元素的图形
  let createdShape: HostShape | undefined;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !createdShape) {
    const current = await listDiagramShapes(tab);
    createdShape = current.find(shape => !beforeIds.has(shape.id) && shape.modelId === elementId);
    if (!createdShape) await sleep(150);
  }
  if (!createdShape) throw new Error(`摆放请求已发送，但图表上没有出现绑定元素 ${elementId} 的新图形；请用 diagram_read_shapes 确认`);

  trackCreatedShape(proposalId, createdShape.id, tab.modelId);
  recordRefTarget(proposalId, operation, { shapeId: createdShape.id, modelId: elementId, diagramId: tab.modelId });
  operation.shapeIds = createdShape.id;
  operation.diagramId = tab.modelId;
  operation.revert = {
    id: `${operation.id}-revert`,
    type: "delete-shape",
    summary: `移除刚摆上的图形`,
    diagramId: tab.modelId,
    shapeIds: createdShape.id,
    // 只移除图形，保留模型元素本身
    revertScope: "shape",
    status: "pending"
  };
  operation.result = `已把元素「${node ? nodeLabel(node) : elementId}」摆到「${diagramNameOf(tab)}」，图形 id=${createdShape.id}`;
  return operation.result;
}

/** arrange-shapes layout=auto 支持的宿主布局方向（与宿主 ShapeLayoutDirection 定义核对） */
const AUTO_LAYOUT_DIRECTIONS = ["DOWN", "UP", "RIGHT"];

function readLayoutDirection(value: string | undefined): string {
  const direction = value?.trim().toUpperCase() || "DOWN";
  if (!AUTO_LAYOUT_DIRECTIONS.includes(direction)) {
    throw new Error(`direction 必须是 DOWN、UP 或 RIGHT，收到「${value}」`);
  }
  return direction;
}

/** 关系布局回读专用：直接读后端图形接口，画布模型可能还没收到布局后的推送 */
async function fetchDiagramShapes(tab: HostGraphTab): Promise<HostShape[]> {
  const project = requireProject();
  return hostServices().shapeService.getDiagramAllShape(project.id, tab.modelId);
}

/** 目标图形相关连线的几何签名（waypoint 序列化），用于比较布局前后连线路径 */
function edgeGeometryOf(shapes: HostShape[], targetIds: string[]): string {
  const targetSet = new Set(targetIds);
  return shapes
    .filter(shape => shape.shapeType === "Edge" && (targetSet.has(shape.sourceId ?? "") || targetSet.has(shape.targetId ?? "")))
    .map(shape => `${shape.id}:${JSON.stringify(shape.waypoint ?? [])}`)
    .sort()
    .join("|");
}

/**
 * arrange-shapes layout=auto：复用宿主快速布局（quickLayout 局部布局）做关系驱动整理。
 *
 * 只把明确目标集合传给宿主（绝不因为集合为空退化成全图布局）；
 * 宿主返回的“跨层级 / 不支持 / 未执行”都明确报错，不吞掉后假装成功。
 * 宿主布局会同时调整尺寸、端口方向与连线路径，且由宿主 Step 覆盖：插件无法只还原节点坐标，
 * 因此本操作不写 revert（不伪造部分回滚），回滚限制写进执行结果。
 */
async function executeRelationLayout(
  operation: AiChangeOperation,
  project: HostProject,
  tab: HostGraphTab,
  targets: HostShape[]
): Promise<string> {
  const direction = readLayoutDirection(operation.direction);
  const targetIds = targets.map(target => target.id);
  operation.diagramId = tab.modelId;

  if (targetIds.length < 2) {
    operation.result = `目标图表「${diagramNameOf(tab)}」本轮仅整理 ${targetIds.length} 个图形，少于 2 个无需关系布局，图形位置未调整`;
    return operation.result;
  }

  // 布局前后都回读一次边界与连线几何；读取失败（网络/后端异常）直接报错，不假装布局成功
  const before = await fetchDiagramShapes(tab);
  const beforePositions = new Map(before.map(shape => [shape.id, shapePosition(shape)]));
  const beforeEdges = edgeGeometryOf(before, targetIds);

  const result = await hostServices().shapeService.handleShapesQucikLayout(
    project.id,
    await diagramShapeIdOf(tab),
    direction,
    "CLASS",
    undefined,
    targetIds
  );

  if (result === "Different Levels") {
    throw new Error("所选图形不在同一层级，宿主局部布局不支持跨层级整理；请分开整理，或改用 row/column/grid");
  }
  if (result === "Not Supported Graph") {
    throw new Error("宿主判定当前图形组合不支持自动布局（可能包含复杂连线、泳道等嵌套图形）；请改用 row/column/grid 或手动布局");
  }
  if (result === undefined || result === null) {
    throw new Error("宿主未执行自动布局（该图表可能不支持关系布局，或所选图形没有可布局的符号）；图形位置未变化，可改用 row/column/grid");
  }

  // 回读校验：坐标未变化不认定失败（可能已满足布局），但变化情况要如实说明
  const after = await fetchDiagramShapes(tab);
  const movedCount = targetIds.filter(id => {
    const beforePosition = beforePositions.get(id);
    const afterShape = after.find(shape => shape.id === id);
    if (!beforePosition || !afterShape) return false;
    const afterPosition = shapePosition(afterShape);
    return afterPosition.x !== beforePosition.x || afterPosition.y !== beforePosition.y;
  }).length;
  const edgeChanged = edgeGeometryOf(after, targetIds) !== beforeEdges;

  const details = [`${movedCount}/${targetIds.length} 个图形位置已变化`];
  if (edgeChanged) details.push("相关连线路径已更新");
  if (!movedCount) details.push("坐标未变化可能已满足布局");
  operation.result = `已用宿主关系布局整理 ${targetIds.length} 个图形（方向 ${direction}）：${details.join("，")}。该步不提供插件级回滚（宿主布局会同时调整图形尺寸与连线路径）；如需撤销请在画布使用宿主撤销，会按 Step 逆序回滚`;
  return operation.result;
}

async function executeArrangeShapes(operation: AiChangeOperation, proposalId: string, project: HostProject): Promise<string> {
  const tab = requireDiagramTab(operation.diagramId);
  assertEditable(project);

  const explicitIds = (operation.shapeIds ?? "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  // 缺省整理本提案在目标图新建的图形；不在目标图创建过图形时明确报错，不退化成全图布局
  const trackedIds = (createdShapeIdsByProposal.get(proposalId) ?? [])
    .filter(record => record.diagramId === tab.modelId)
    .map(record => record.shapeId);
  const shapeIds = explicitIds.length ? explicitIds : trackedIds;
  if (!shapeIds.length) {
    throw new Error(
      `没有可整理的图形：「${diagramNameOf(tab)}」中本提案没有新建图形，请先在提案中创建图形，或在 shapeIds 里指定图形 id（不会触发全图布局）`
    );
  }

  const shapes = await listDiagramShapes(tab);
  const targets = shapeIds
    .map(id => shapes.find(shape => shape.id === id))
    .filter((shape): shape is HostShape => Boolean(shape) && shape!.shapeType !== "Edge");
  if (!targets.length) throw new Error("指定的图形在画布上不存在、是连线或缺少有效边界，无法整理");

  const layout = (operation.layout ?? "grid").trim().toLowerCase() || "grid";
  if (layout === "auto") return executeRelationLayout(operation, project, tab, targets);
  if (!["grid", "row", "column"].includes(layout)) throw new Error(`layout 必须是 auto、grid、row 或 column，收到「${operation.layout}」`);

  const columns = layout === "column" ? 1 : layout === "row" ? targets.length : Math.ceil(Math.sqrt(targets.length));
  const gapX = 240;
  const gapY = 160;
  const origin = shapePosition(targets[0]);
  const startX = Math.round(readNumber(operation.startX) ?? origin.x);
  const startY = Math.round(readNumber(operation.startY) ?? origin.y);

  const previousPositions: Array<{ shapeId: string; x: number; y: number }> = [];
  for (const [index, target] of targets.entries()) {
    const current = shapePosition(target);
    previousPositions.push({ shapeId: target.id, x: current.x, y: current.y });
    const next = { x: startX + (index % columns) * gapX, y: startY + Math.floor(index / columns) * gapY };
    const dx = next.x - current.x;
    const dy = next.y - current.y;
    if (!dx && !dy) continue;
    await hostServices().shapeService.moveShape(project.id, await diagramShapeIdOf(tab), [target.id], dx, dy);
  }

  operation.diagramId = tab.modelId;
  operation.revertSource = JSON.stringify(previousPositions);
  operation.revert = {
    id: `${operation.id}-revert`,
    type: "restore-bounds",
    summary: `恢复整理前的图形位置`,
    diagramId: tab.modelId,
    shapeIds: targets.map(target => target.id).join(","),
    revertSource: operation.revertSource,
    status: "pending"
  };
  operation.result = `已整理 ${targets.length} 个图形（${layout} 布局，可一键回滚位置）`;
  return operation.result;
}

async function executeOperation(operation: AiChangeOperation, context: { proposalId: string }): Promise<string> {
  const project = requireProject();
  // 执行前先把 @ref:名称 解析成真实 id（找不到结果或种类不符时报错，不静默跳过）
  resolveOperationRefs(operation, context.proposalId);
  switch (operation.type) {
    case "create-element":
      return executeCreateElement(operation, context.proposalId, project);
    case "update-property":
      return executeUpdateProperty(operation, project);
    case "delete-element":
      return executeDeleteElement(operation, project);
    case "replace-sysml-text":
      throw new Error(unsupportedTextAction());
    case "create-shape":
      return executeCreateShape(operation, context.proposalId, project);
    case "create-connector":
      return executeCreateConnector(operation, context.proposalId, project);
    case "place-shape":
      return executePlaceShape(operation, context.proposalId, project);
    case "arrange-shapes":
      return executeArrangeShapes(operation, context.proposalId, project);
    case "delete-shape": {
      const diagramId = requireField(operation, "diagramId");
      const shapeIds = (operation.shapeIds ?? "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
      if (!shapeIds.length) throw new Error("delete-shape 缺少 shapeIds");
      assertEditable(project);
      if (operation.revertScope === "shape") {
        await hostServices().shapeService.removeShape(project.id, await diagramShapeIdOf(requireDiagramTab(diagramId)), shapeIds);
        return `已从图表移除图形（保留模型元素）：${shapeIds.join(", ")}`;
      }
      await hostServices().shapeService.deleteShape(project.id, await diagramShapeIdOf(requireDiagramTab(diagramId)), shapeIds);
      return `已从图表删除图形及其模型：${shapeIds.join(", ")}`;
    }
    case "restore-bounds": {
      const diagramId = requireField(operation, "diagramId");
      const positions = JSON.parse(operation.revertSource ?? "[]") as Array<{ shapeId: string; x: number; y: number }>;
      if (!positions.length) throw new Error("restore-bounds 缺少位置快照");
      assertEditable(project);

      const shapes = await listDiagramShapes(requireDiagramTab(diagramId));
      for (const position of positions) {
        const shape = shapes.find(item => item.id === position.shapeId);
        if (!shape) continue;
        const current = shapePosition(shape);
        const dx = position.x - current.x;
        const dy = position.y - current.y;
        if (!dx && !dy) continue;
        await hostServices().shapeService.moveShape(
          project.id,
          await diagramShapeIdOf(requireDiagramTab(diagramId)),
          [position.shapeId],
          dx,
          dy
        );
      }
      return `已恢复 ${positions.length} 个图形的整理前位置`;
    }
    default:
      throw new Error(`不支持的操作类型：${String(operation.type)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 宿主能力组装
 * ------------------------------------------------------------------ */

/** 设置存储：桌面端落用户数据目录、Web 端落 localStorage（宿主 storage 统一封装） */
function settingsStorage(): AiAssistantHost["settingsStorage"] {
  return {
    get: () => {
      const value = hostServices().storage.get("aiProvider");
      return value && typeof value === "object" ? (value as AiProviderSettings) : null;
    },
    set: (value: AiProviderSettings) => hostServices().storage.set("aiProvider", value)
  };
}

function attachmentStorage() {
  const keyOf = (key: string) => `aiAttachment-${key}`;
  return {
    get: (key: string) => {
      const value = hostServices().storage.get(keyOf(key));
      return typeof value === "string" ? value : null;
    },
    set: (key: string, value: string) => hostServices().storage.set(keyOf(key), value),
    remove: (key: string) => hostServices().storage.remove(keyOf(key))
  };
}

/**
 * 捕获随消息发送的界面上下文。
 *
 * 只带当前图表：助手的工作范围始终是整个项目模型（选中与否都按全部处理），
 * 不把模型树选中项注入上下文；选中节点作为引用上下文的能力后续再做。
 */
function captureContext(): AiContextSnapshot | undefined {
  const project = activeProject();
  if (!project) return undefined;

  const tab = (project.ui.graphTabs ?? []).find(item => item.visible);
  if (!tab) return undefined;

  return {
    diagram: { id: tab.modelId, name: diagramNameOf(tab), shapeCount: tab.graph?.shapeMap?.size }
  };
}

function buildHost(): AiAssistantHost {
  const model: AiModelHost = {
    getModelTree,
    searchElements,
    pickMentions,
    getCreatableElementTypes: async (containerId: string) => {
      const project = requireProject();
      const options = await creatableTypes(project.id, containerId);
      return options
        .filter(item => item.metaclass)
        .map(item => ({
          id: encodeElementType(String(item.metaclass), item.appliedStereotypes ?? item.sts ?? []),
          label: `${item.isDiagram ? "[图表] " : ""}${String(item.cnName || item.label || item.enName || item.metaclass)}`
        }));
    },
    getElement,
    getElementChildren,
    getElementRelationships,
    getProperties,
    readSysmlText: async () => unsupportedTextAction(),
    validateSysmlText: async () => unsupportedTextAction()
  };

  const diagram: AiDiagramHost = {
    listDiagrams,
    readShapes,
    readPalette
  };

  return {
    model,
    diagram,
    features: { sysmlText: false },
    getActiveProjectName: () => activeProject()?.config?.name || "",
    getActiveProjectId: () => activeProject()?.id || "",
    getMemoryIdentity: () => memoryIdentity(hostApp().global?.user),
    settingsStorage: settingsStorage(),
    attachmentStorage: attachmentStorage(),
    proposalExecutor: {
      execute: executeOperation,
      finish: releaseProposalScope
    },
    editExecutor: {
      apply: async (operations: AiChangeOperation[], context: { title: string; signal?: AbortSignal }) => {
        const proposalId = `edit-${crypto.randomUUID()}`;
        const results: string[] = [];
        try {
          for (const operation of operations) {
            if (context.signal?.aborted) break;
            assertEditable(requireProject(), operation.containerId || operation.elementId);
            operation.status = "running";
            try {
              const result = await executeOperation(operation, { proposalId });
              operation.status = "completed";
              operation.result = result;
              results.push(`- ${operation.summary}：${result}`);
            } catch (error) {
              operation.status = "failed";
              operation.result = errorText(error);
              results.push(`- ${operation.summary}：失败：${operation.result}`);
              break;
            }
          }
        } finally {
          releaseProposalScope(proposalId);
        }

        const failed = operations.find(operation => operation.status === "failed");
        if (failed || context.signal?.aborted) return `执行未全部完成（后续操作已停止）：\n${results.join("\n")}`;
        return `已执行 ${results.length} 项改动：\n${results.join("\n")}`;
      }
    },
    revertExecutor: {
      execute: async (operation: AiChangeOperation) => executeOperation(operation, { proposalId: `revert-${crypto.randomUUID()}` })
    },
    context: { capture: captureContext }
  };
}

/** 注入宿主能力；幂等，面板与工具在首次使用前调用 */
export function configureMDesignHost(): void {
  configureAiAssistant(buildHost());
}

/** 供面板显示：是否运行在 Electron 桌面端（设置落盘位置不同） */
export function isDesktopHost(): boolean {
  return isElectron;
}
