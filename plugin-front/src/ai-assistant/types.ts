import type { ModelMessage } from "ai";

export interface AiRunState {
  status: "running" | "continuing" | "finished" | "waiting-user" | "waiting-approval" | "step-limit" | "stalled" | "cancelled" | "error";
  message: string;
  modelSteps: number;
  continuations: number;
  finishReason?: string;
  rawFinishReason?: string;
}

/** AI 供应商配置（含本机保存的 API Key；Key 随请求头传给插件的 Node 代理发送） */
export interface AiProviderProfile {
  /** profile 唯一标识 */
  id: string;
  name: string;
  baseURL: string;
  model: string;
  /** API Key；随插件设置保存在本机，未配置时表示端点无需鉴权 */
  apiKey?: string;
  /** 模型上下文窗口（token 数），取自供应商的模型列表 */
  contextLength?: number;
  /** 推理强度（reasoning effort），缺省表示不显式指定 */
  effort?: string;
  /** 模型使用方式：all（默认）该供应商全部模型都可在输入区选用；single 只使用指定模型 */
  modelMode?: "all" | "single";
  /**
   * 额外请求头（按行 “名称: 值” 保存）。
   *
   * 部分网关在标准 OpenAI 协议之外要求附加头（例如 OpenCode Go 的
   * `x-opencode-session` 会话标识），由插件 Node 代理在转发时携带。
   */
  extraHeaders?: string;
}

/**
 * AI 助手的权限模式。
 *
 * - chat：只读，只回答问题，可给出方案文字但不生成提案、不修改模型
 * - proposal：读 + 生成结构化提案，等用户在界面上确认后才执行（默认）
 * - edit：读 + 直接执行模型变更，不再逐条确认
 */
export type AiPermissionMode = "chat" | "proposal" | "edit";

/** 设置面板的左侧分区：供应商与技能 */
export type AiSettingsSection = "providers" | "skills" | "experts" | "memory";

/** 会话执行对象；单专家与专家团各自选择，旧会话的策略值保持兼容。 */
export type AiExecutionStrategy = "assistant" | "sysml-team" | `expert:${AiExpertRole}`;
export type AiExpertRole = "lead" | "requirements" | "semantics" | "layout" | "checker";
export interface AiExpertRun {
  metrics?: AiRunMetrics;
  contextUsage?: AiContextUsage;
  id: string;
  role: AiExpertRole;
  task: string;
  status: "queued" | "running" | "completed" | "error" | "cancelled" | "not-called";
  result?: string;
  error?: string;
  usage?: AiUsage;
  toolCalls: AiToolCallView[];
}
export interface AiTeamRun {
  id: string;
  profileId: string;
  model: string;
  permissionMode: AiPermissionMode;
  status: "running" | "completed" | "error" | "cancelled" | "waiting-approval" | "waiting-user" | "interrupted";
  members: AiExpertRun[];
  reviewPending?: boolean;
  error?: string;
}

/** 供应商设置 */
export interface AiProviderSettings {
  activeProfileId: string;
  profiles: AiProviderProfile[];
  /** 已确认可向对应供应商发送当前项目模型数据的 profile 标识 */
  dataSharingConfirmedProfileIds?: string[];
  /** 按项目保存的最近会话 */
  conversationsByProject?: Record<string, AiConversation[]>;
  /** 权限模式；缺省按 proposal（审批模式）处理，兼容旧数据 */
  permissionMode?: AiPermissionMode;
  /** 用户自定义的提示词技能（全局，与供应商配置同层存放） */
  skills?: AiSkill[];
  /** 收藏的模型，元素形如 `profileId::modelId`；序号即 Ctrl+1–9 的切换槽位 */
  favoriteModels?: string[];
}

/** 本地保存的一条 AI 会话 */
/** 会话独立的请求选项；凭据仍从供应商配置读取。 */
export interface AiConversationOptions {
  profileId?: string;
  model?: string;
  effort?: string;
  contextLength?: number;
  permissionMode?: AiPermissionMode;
}

/** 会话输入草稿，包含输入中的技能与模型引用 token。 */
export interface AiConversationDraft {
  html: string;
  attachments: AiAttachment[];
  notice: string;
  scrollTop: number;
}

export interface AiConversation {
  options?: AiConversationOptions;
  strategy?: AiExecutionStrategy;
  id: string;
  title: string;
  messages: AiChatMessage[];
  /**
   * 被条数上限截断的旧消息摘要（见 history-digest.ts）。
   * 随会话持久化，并作为系统消息注入后续请求，保证早期目标与真实 ID 不因截断丢失。
   */
  digest?: string;
  updatedAt: number;
}

/** AI 生成、等待用户确认的模型变更提案。 */
export interface AiChangeProposal {
  id: string;
  title: string;
  summary: string;
  operations: AiChangeOperation[];
  status: "pending" | "executing" | "completed" | "partial" | "rejected";
}

/** 一项待确认的模型变更。 */
export interface AiChangeOperation {
  id: string;
  type:
    | "create-element"
    | "update-property"
    | "delete-element"
    | "replace-sysml-text"
    | "create-shape"
    | "create-connector"
    | "place-shape"
    | "arrange-shapes"
    /**
     * 以下两种仅由宿主生成（作为 revert 逆操作），不暴露给 AI：
     * - delete-shape：移除本次创建的图形，用于回滚 create-shape / place-shape / create-connector
     * - restore-bounds：恢复图形位置，用于回滚 arrange-shapes
     */
    | "delete-shape"
    | "restore-bounds";
  summary: string;
  name?: string;
  elementType?: string;
  containerId?: string;
  elementId?: string;
  propertyName?: string;
  propertyKey?: string;
  oldValue?: string;
  newValue?: string;
  control?: string;
  namespaceId?: string;
  textualContent?: string;
  /** 目标图表 id（画布操作用）；缺省为当前可见图表 */
  diagramId?: string;
  /** 图形组件 id（画布操作用，必须取自 diagram_read_palette 返回值） */
  elementConfigId?: string;
  /** 容器图形 id（create-shape 用）；缺省为画布根图形 */
  containerShapeId?: string;
  /** 期望位置（create-shape 用，数字字符串）；缺省自动找空闲位置 */
  x?: string;
  y?: string;
  /** 连线两端图形 id（create-connector 用，取自 diagram_read_shapes） */
  sourceShapeId?: string;
  targetShapeId?: string;
  /** 待整理图形 id（arrange-shapes 用，英文逗号分隔）；缺省整理本提案刚创建的图形 */
  shapeIds?: string;
  /** 整理布局：auto 关系驱动（复用宿主 quickLayout）、row 横排、column 竖排、grid 网格（默认） */
  layout?: string;
  /** 关系布局方向（arrange-shapes layout=auto 用）：DOWN（默认，从上到下）/ UP / RIGHT */
  direction?: string;
  /**
   * 本地引用名：给本操作创建的对象起一个提案内唯一的英文短名，
   * 后续操作的 id 字段可用 @ref:名称 引用它（仅限本提案中更早声明 ref 的操作）。
   */
  ref?: string;
  /** 整理起点（数字字符串）；缺省沿用图形现有位置 */
  startX?: string;
  startY?: string;
  /**
   * 回滚用的原始状态（宿主内部使用，不暴露给 AI）：
   * - replace-sysml-text：执行前的命名空间原文（回滚时重新提交）
   * - arrange-shapes：整理前的图形位置 newBounds JSON（回滚时恢复）
   */
  revertSource?: string;
  /**
   * delete-shape 逆操作的执行范围（宿主内部使用）：
   * - shape：只移除图形，保留模型元素（place-shape 的回滚）
   * - shape-and-model：同时删除图形与新建的模型（create-shape / create-connector 的回滚，缺省）
   */
  revertScope?: "shape" | "shape-and-model";
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  /**
   * 执行成功后由宿主写入的逆操作：把本次操作的影响整体还原。
   * 用同一个 AiChangeOperation 结构描述（同样由宿主执行），
   * 缺省表示该操作无法自动回滚（例如删除元素）。
   */
  revert?: AiChangeOperation;
  /** 该操作是否已被用户回滚（界面据此标注，避免重复回滚） */
  reverted?: boolean;
}

/** 计划里的一步：一个可执行操作 + 可选的验收说明。 */
export interface AiPlanStep extends AiChangeOperation {
  /** 执行完成后的验收标准 / 预期结果（用户据此判断这步做得对不对） */
  acceptance?: string;
  /** 相关文档或说明 */
  doc?: string;
}

/** AI 生成的变更计划：分步、可勾选执行（执行时转提案确认）。 */
export interface AiChangePlan {
  id: string;
  title: string;
  summary: string;
  steps: AiPlanStep[];
  /** converted：用户勾选后已转成提案；rejected：用户忽略 */
  status: "pending" | "converted" | "rejected";
}

/** 界面上下文快照里的一项模型元素。 */
export interface AiContextElementRef {
  id: string;
  title: string;
  type: string;
}

/** 随用户消息一起捕获的当前界面上下文（当前图表；选中项与文本页后续再做）。 */
export interface AiContextSnapshot {
  /**
   * 模型树选中项；当前版本不再捕获（助手默认在整个项目模型上工作，选中也按全部处理），
   * 仅保留字段以兼容历史会话数据；选中节点作为引用上下文的能力后续再做。
   */
  selection?: AiContextElementRef[];
  diagram?: { id: string; name: string; shapeCount?: number };
  textNamespace?: { id: string; name: string };
}

/** 一次已执行变更的回滚结果，用于界面提示与二次确认。 */
export interface AiRollbackResult {
  /** 成功回滚的操作数 */
  reverted: number;
  /** 无法回滚的操作摘要（含原因），空数组表示全部回滚成功 */
  skipped: string[];
}

/** 用户选择卡片中的单个选项。 */
export interface AiChoiceOption {
  id: string;
  label: string;
  description?: string;
}

/** AI 发起的一次用户选择追问；用户选择、输入或跳过后继续。 */
export interface AiChoicePrompt {
  id: string;
  question: string;
  options: AiChoiceOption[];
  allowCustomInput: boolean;
  status: "pending" | "answered" | "skipped";
  answer?: string;
}

/** 工具调用在面板中的展示状态 */
export interface AiToolCallView {
  id: string;
  name: string;
  input: unknown;
  state: "running" | "done" | "error";
  output?: string;
  error?: string;
}

/** 一次 AI 运行的 token 使用量 */
export interface AiUsage {
  /** 最近一次请求的输入量，用于上下文窗口占用，不能使用累计量替代。 */
  latestInputTokens?: number;
  latestOutputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 缓存命中属于输入用量的一部分，不能再加到总量。 */
  cachedInputTokens?: number;
}

/** 累计请求工作耗时；并行专家的工作时间可能超过整轮墙钟耗时。 */
export interface AiRunMetrics {
  modelMs: number;
  toolMs: number;
  firstTokenMsTotal: number;
  firstTokenCount: number;
  generationMs: number;
  /** 仅统计同时具有供应商输出用量和生成计时的请求。 */
  timedOutputTokens: number;
}

/** 最近一次实际发出请求的上下文分项，均为本地估算。 */
export interface AiContextUsage {
  /** 本次请求完成后供应商返回的实际输入用量；未完成或缺失时不填。 */
  inputTokens?: number;
  systemTokens: number;
  toolTokens: number;
  messageTokens: number;
  /** 与本次请求匹配的模型窗口，避免切换模型后使用错误分母。 */
  contextLength?: number;
  model: string;
}

/** 时间线中的思考片段 */
export interface AiReasoningStep {
  kind: "reasoning";
  text: string;
}

export interface AiToolStep {
  kind: "tool";
  /** 对应 toolCalls 中的 id */
  id: string;
}

export interface AiTextStep {
  kind: "text";
  text: string;
}

export type AiMessageStep = AiReasoningStep | AiToolStep | AiTextStep;

/**
 * 随用户消息一起发送的附件。
 *
 * 文本类文件的内容直接内联进消息正文（任何模型都能读），图片则以多模态 part 发送；
 * 图片的 dataUrl 只在内存与独立 storage key 里存在，不会写进会话 JSON（见 attachments.ts）。
 */
export interface AiAttachment {
  id: string;
  kind: "file" | "image";
  /** 原始文件名（展示与内联标题用） */
  name: string;
  /** 原始字节数（界面展示用） */
  size: number;
  mimeType?: string;
  /** kind=file：文件正文；超限时已截断 */
  text?: string;
  /** 文本因超限被截断，界面据此标注 */
  truncated?: boolean;
  /** kind=image：降采样后的 data URL */
  dataUrl?: string;
  /** kind=image：历史图片已被清理或未命中存储 */
  missing?: boolean;
}

/**
 * 用户自定义的提示词技能。
 *
 * 只影响系统提示：默认启用的每轮注入，未启用的在输入区用 /name 单轮启用；
 * 不改变权限模式与工具集。
 */
export interface AiSkill {
  id: string;
  /** 调用名（/[a-z0-9-]{2,32}），全局唯一 */
  name: string;
  /** 一句话说明（技能菜单与设置列表展示） */
  description: string;
  /** 指令正文，注入系统提示 */
  content: string;
  /** 默认启用：每轮注入；false 时用 /name 单轮启用 */
  enabled: boolean;
  /** 内置技能：随产品分发，加载设置时确保存在并刷新到最新版本，界面不可删除、不可编辑（可停用） */
  builtin?: boolean;
}

/** 会话消息（面板展示用） */
export interface AiChatMessage {
  metrics?: AiRunMetrics;
  contextUsage?: AiContextUsage;
  team?: AiTeamRun;
  /** SDK 工具上下文的 JSON；避免 Vue 深层代理模型消息联合类型。 */
  modelContext?: string;
  runState?: AiRunState;
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 用户消息携带的附件（文件内容与图片） */
  attachments?: AiAttachment[];
  /** 发送该消息时捕获的界面上下文（选中项、当前图表、当前文本页） */
  context?: AiContextSnapshot;
  /** 本轮显式启用的技能名（输入区 /name 触发）；历史气泡据此展示技能标记 */
  skillNames?: string[];
  /** 正文、思考与工具调用按发生顺序保存 */
  steps?: AiMessageStep[];
  /** 工具调用明细 */
  toolCalls: AiToolCallView[];
  /** 从发起到产出首个内容的耗时（毫秒） */
  thinkingMs?: number;
  /** 本轮从发起到结束的总耗时（毫秒） */
  durationMs?: number;
  /** 本轮使用的模型 id */
  model?: string;
  /** 模型返回的 token 使用量 */
  usage?: AiUsage;
  /** AI 工具生成的结构化变更提案；仅在用户确认后才可执行。 */
  proposal?: AiChangeProposal;
  /** AI 工具生成的分步变更计划；用户勾选若干步骤后转提案确认执行。 */
  plan?: AiChangePlan;
  /** 最近一次回滚的结果（界面据此展示已回滚项与未能回滚的原因） */
  rollback?: AiRollbackResult;
  /** AI 工具发起的用户选择追问；用户点选/手动输入后自动作为下一轮输入继续。 */
  choicePrompt?: AiChoicePrompt;
  createdAt: number;
}

/** 一次 AI 运行的流式回调 */
export interface AiAgentEvents {
  onMetrics?: (metrics: AiRunMetrics) => void;
  onContextUsage?: (usage: AiContextUsage) => void;
  onTeam?: (team: AiTeamRun) => void;
  onModelContext?: (messages: ModelMessage[]) => void;
  onRunState?: (state: AiRunState) => void;
  onReasoningDelta: (delta: string) => void;
  onTextDelta: (delta: string) => void;
  onToolCallStart: (call: { id: string; name: string; input: unknown }) => void;
  onToolCallEnd: (call: { id: string; output?: string; error?: string }) => void;
  onProposal: (proposal: AiChangeProposal) => void;
  onPlan: (plan: AiChangePlan) => void;
  onChoicePrompt: (prompt: AiChoicePrompt) => void;
  onUsage: (usage: AiUsage) => void;
  onError: (message: string) => void;
  onFinish: () => void;
}
