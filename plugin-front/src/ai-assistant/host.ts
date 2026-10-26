import type { AiChangeOperation, AiContextSnapshot, AiProviderSettings } from "./types";
import type { MemoryIdentity } from "./memory";

/** 可插入对话输入框的模型节点引用。 */
export interface AiModelMention {
  id: string;
  title: string;
  type: string;
}

/** 宿主注入的界面上下文捕获能力（自动带上用户当前在看什么） */
export interface AiContextHost {
  /** 捕获当前可见图表；没有任何内容时返回 undefined（选中项与文本页后续再做） */
  capture(): AiContextSnapshot | undefined;
}

/** 容器允许创建的元素类型。 */
export interface AiCreatableElementType {
  id: string;
  label: string;
}

/** 宿主应用提供的只读模型访问能力（由主应用实现并注入） */
export interface AiModelHost {
  /** 获取模型树（缩进文本） */
  getModelTree(options: { rootId?: string; maxDepth?: number; maxNodes?: number }): Promise<string>;
  /** 按关键字检索元素 */
  searchElements(keyword: string): Promise<string>;
  /** 打开模型树选择器并返回用户选中的节点 */
  pickMentions(): Promise<AiModelMention[]>;
  /** 查询指定容器允许创建的元素类型 */
  getCreatableElementTypes(containerId: string): Promise<AiCreatableElementType[]>;
  /** 获取单个元素的概要信息 */
  getElement(elementId: string): Promise<string>;
  /** 获取元素的子元素 */
  getElementChildren(elementId: string, depth?: number): Promise<string>;
  /** 获取元素的关系列表 */
  getElementRelationships(elementId: string): Promise<string>;
  /** 获取元素的可编辑属性行（key、名称、当前值与数据类型） */
  getProperties(elementId: string, propertyNames?: string[]): Promise<string>;
  /** 读取元素的 SysML 文本 */
  readSysmlText(elementId?: string): Promise<string>;
  /** 校验 SysML 文本语法 */
  validateSysmlText(elementId?: string): Promise<string>;
}

/** 主应用提供的图表（画布）只读访问能力 */
export interface AiDiagramHost {
  /** 列出当前项目已打开的图表及其加载状态 */
  listDiagrams(): Promise<string>;
  /** 读取指定图表的图形树；diagramId 缺省用当前可见图表 */
  readShapes(diagramId?: string, maxNodes?: number): Promise<string>;
  /** 查询指定图表允许创建的图形组件清单 */
  readPalette(diagramId?: string): Promise<string>;
}

/** 宿主应用注入的能力集合 */
export interface AiAssistantHost {
  /** 模型只读访问 */
  model: AiModelHost;
  /** 图表只读访问（画布相关工具用） */
  diagram?: AiDiagramHost;
  /**
   * 宿主能力开关。
   * - sysmlText：是否支持 SysML 文本读写与校验；为 false 时不向模型暴露文本类工具，
   *   replace-sysml-text 操作也会被宿主拒绝（M-Design 使用元类/构造型与画布建模）。
   * 缺省按 true 处理，兼容支持文本建模的宿主。
   */
  features?: {
    sysmlText?: boolean;
  };
  /** 当前项目名称（输入区上下文提示用） */
  getActiveProjectName?: () => string;
  /** 当前项目标识（会话本地隔离用） */
  getActiveProjectId?: () => string;
  /** 非零真实账号及服务地址；不可识别时使用当前设备配置。 */
  getMemoryIdentity?: () => MemoryIdentity;
  /** 供应商设置持久化（缺省回退到 localStorage） */
  settingsStorage?: {
    get(): AiProviderSettings | null;
    set(value: AiProviderSettings): void;
  };
  /**
   * 附件持久化（图片按附件 id 单独存放，缺省回退到 localStorage）。
   *
   * 与设置分开：会话 JSON 每轮都会整体重写，base64 图片放进去会让每次落盘都变重。
   */
  attachmentStorage?: {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  /** 已确认提案的执行入口；不会暴露给 AI 工具。 */
  proposalExecutor?: {
    execute(operation: AiChangeOperation, context: { proposalId: string }): Promise<string>;
    /** 整轮执行结束（含失败）后调用，供宿主释放本轮的执行期状态 */
    finish?(proposalId: string): void;
  };
  /**
   * 编辑模式的直接执行入口：由 model_apply_changes 工具调用，立即落盘、不等待界面确认。
   * 传入的 operations 已通过提案同一套字段校验。
   */
  editExecutor?: {
    apply(operations: AiChangeOperation[], context: { title: string; signal?: AbortSignal }): Promise<string>;
  };
  /**
   * 回滚入口：执行 operation.revert 描述的逆操作。
   * 与 proposalExecutor.execute 语义一致，因此复用同一实现；缺省表示宿主不支持回滚。
   */
  revertExecutor?: {
    execute(operation: AiChangeOperation): Promise<string>;
  };
  /** 界面上下文捕获（当前图表），随用户消息一起发送；助手范围不因选中项收窄 */
  context?: AiContextHost;
}

let assistantHost: AiAssistantHost | undefined;

/** 注入宿主能力；主应用启动时调用一次 */
export function configureAiAssistant(host: AiAssistantHost): void {
  assistantHost = host;
}

/** 获取宿主能力；未注入时抛错 */
export function getAiAssistantHost(): AiAssistantHost {
  if (!assistantHost) throw new Error("AI 助手尚未完成宿主能力注入");
  return assistantHost;
}

/** 尝试获取宿主能力；未注入时返回 undefined */
export function tryGetAiAssistantHost(): AiAssistantHost | undefined {
  return assistantHost;
}
