import { nanoid } from "nanoid";
import {
  describeRefKind,
  hasRefPrefix,
  parseRefExpression,
  REF_MODEL_FIELDS,
  REF_NAME_PATTERN,
  REF_SHAPE_FIELDS,
  refFieldKind,
  refProvidersOf
} from "./refs";
import type { AiChangeOperation, AiChangeProposal, AiChoiceOption, AiChoicePrompt } from "../types";

/** 模型可提交的操作类型：宿主私有的回滚类型（delete-shape / restore-bounds）不属于提案 */
type ProposalOperationType = Exclude<AiChangeOperation["type"], "delete-shape" | "restore-bounds">;

const operationTypes = new Set<ProposalOperationType>([
  "create-element",
  "update-property",
  "delete-element",
  "replace-sysml-text",
  "create-shape",
  "create-connector",
  "place-shape",
  "arrange-shapes"
]);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const MODEL_CHANGE_PATTERN = /(创建|建立|生成|新增|重建|修改|替换|删除)\S{0,12}(模型|元素|部件|系统)/;

/**
 * 盘点/列举式问法：问的是"现在有什么"，不是要求改动。
 *
 * 这类句子（"模型里已经创建了哪些部件""查看当前已创建的元素"）会因为出现"创建…部件"
 * 而命中 MODEL_CHANGE_PATTERN，又常常不带问号，于是被当成变更请求：只读模式的回答必然带
 * 完成态词（"模型里已经创建了轮胎和车架。"），agent 侧据此报出"模型没有修改模型的能力"，
 * 而用户只是问了个清单——错误提示与事实正好相反。
 */
const LISTING_PATTERN = /哪些|有哪|列出|罗列|清单|列表|统计|概览|查看|看看|看一下|看下|展示|介绍/;

/**
 * 变更动作的"请求形态"：动词后直接跟数量或宾语（"创建一个部件""修改部件名称""新增个元素"）。
 *
 * 用来把"要求改动"和"提到已经改过的东西"分开——盘点式句子里的动作多是完成态或定语
 * （"已创建的元素""已经创建了哪些部件"），带请求形态的才是真要求改
 * （"查看模型后创建一个部件"）。缺了它，"先看后改"的句子会被盘点词误判成只读提问。
 */
const REQUEST_ACTION_PATTERN = /(?:创建|建立|生成|新增|重建|修改|替换|删除)(?:一|个|下|模型|元素|部件|系统)/;

/** 文本里是否有请求形态的变更动作（agent 侧判断"疑问句是不是只在问怎么做"时共用） */
export function hasRequestAction(text: string): boolean {
  return REQUEST_ACTION_PATTERN.test(text);
}

/** 用户是否在要求变更模型（提案兜底与"模型虚报已执行"判定共用的判定） */
export function isModelChangeRequest(text: string): boolean {
  if (!MODEL_CHANGE_PATTERN.test(text)) return false;
  // 请求形态优先：句子同时带盘点词时（"查看模型后创建一个部件"）它仍是变更请求
  if (REQUEST_ACTION_PATTERN.test(text)) return true;
  return !LISTING_PATTERN.test(text);
}

/** 模型漏填 summary 时按类型与关键字段兜底生成，避免整条操作被静默丢弃 */
function describeOperation(type: ProposalOperationType, source: Record<string, unknown>): string {
  const name = readString(source.name);
  const elementId = readString(source.elementId);
  const namespaceId = readString(source.namespaceId);
  const propertyName = readString(source.propertyName);
  const elementConfigId = readString(source.elementConfigId);

  switch (type) {
    case "create-element":
      return `创建元素${name ? `「${name}」` : ""}`;
    case "update-property":
      return `修改属性${propertyName ? ` ${propertyName}` : ""}${elementId ? `（${elementId}）` : ""}`;
    case "delete-element":
      return `删除元素${elementId ? `（${elementId}）` : ""}`;
    case "create-shape":
      return `在画布创建图形${name ? `「${name}」` : ""}${elementConfigId ? `（${elementConfigId}）` : ""}`;
    case "create-connector":
      return `在画布创建连线${elementConfigId ? `（${elementConfigId}）` : ""}`;
    case "place-shape":
      return `把已有元素摆到画布${elementId ? `（${elementId}）` : ""}`;
    case "arrange-shapes":
      return "整理画布图形位置";
    default:
      return `替换 SysML 文本${namespaceId ? `（${namespaceId}）` : ""}`;
  }
}

/** 各类型操作执行时必须具备的字段：缺任意一项都无法执行，不能进入提案 */
const REQUIRED_OPERATION_FIELDS: Record<ProposalOperationType, readonly (keyof AiChangeOperation)[]> = {
  "create-element": ["name", "elementType", "containerId"],
  "update-property": ["elementId", "propertyKey", "oldValue"],
  "delete-element": ["elementId"],
  "replace-sysml-text": ["namespaceId", "textualContent"],
  "create-shape": ["name", "elementConfigId"],
  "create-connector": ["elementConfigId", "sourceShapeId", "targetShapeId"],
  "place-shape": ["elementId"],
  "arrange-shapes": []
};

/**
 * 允许为空字符串的必备字段。
 *
 * 属性的当前值可能本来就是空的（例如尚未设置的类型 / 多重度）——空字符串是合法取值，
 * 不能和"字段缺失"混为一谈；把它判成缺字段会让"补全空属性"这类需求永远无法提交，
 * 模型只能反复换写法试错。
 */
const REQUIRED_FIELDS_ALLOW_EMPTY: ReadonlySet<string> = new Set(["oldValue"]);

function hasRequiredFields(operation: AiChangeOperation, type: ProposalOperationType): boolean {
  return REQUIRED_OPERATION_FIELDS[type].every(field => {
    const value = operation[field];
    if (typeof value !== "string") return false;
    return REQUIRED_FIELDS_ALLOW_EMPTY.has(field) || value.trim().length > 0;
  });
}

/**
 * 指出必备字段的具体问题（缺失 / 不是字符串 / 为空）。
 *
 * 逐字段定位而不是罗列全部字段名：通用文案只会让模型靠换键名试错，
 * 白烧一轮上下文；这里直接告诉它哪个字段、什么问题。
 */
function describeFieldProblems(source: Record<string, unknown>, type: ProposalOperationType): string[] {
  const problems: string[] = [];
  for (const field of REQUIRED_OPERATION_FIELDS[type]) {
    const value = source[field];
    if (value === undefined || value === null) problems.push(`${field} 缺失`);
    else if (typeof value !== "string") problems.push(`${field} 不是字符串`);
    else if (!REQUIRED_FIELDS_ALLOW_EMPTY.has(field) && !value.trim()) problems.push(`${field} 为空`);
  }
  return problems;
}

function parseOperation(value: unknown, index: number): AiChangeOperation | undefined {
  if (!value || typeof value !== "object") return undefined;

  const source = value as Record<string, unknown>;
  const type = readString(source.type) as ProposalOperationType | undefined;
  if (!type || !operationTypes.has(type)) return undefined;

  const operation: AiChangeOperation = {
    id: readString(source.id) ?? `operation-${index + 1}`,
    type,
    summary: readString(source.summary) ?? describeOperation(type, source),
    status: "pending"
  };

  const fields = [
    "name",
    "elementType",
    "containerId",
    "elementId",
    "propertyName",
    "propertyKey",
    "oldValue",
    "newValue",
    "control",
    "namespaceId",
    "textualContent",
    "diagramId",
    "elementConfigId",
    "containerShapeId",
    "x",
    "y",
    "sourceShapeId",
    "targetShapeId",
    "shapeIds",
    "layout",
    "direction",
    "ref",
    "startX",
    "startY"
  ] as const;
  for (const field of fields) {
    const fieldValue = source[field];
    if (typeof fieldValue === "string") operation[field] = fieldValue;
  }

  return hasRequiredFields(operation, type) ? operation : undefined;
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return undefined;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function assignIncrementalCreateNames(operations: AiChangeOperation[]): void {
  const groups = new Map<string, AiChangeOperation[]>();
  operations.forEach(operation => {
    if (operation.type !== "create-element" || !operation.name || !operation.containerId) return;
    const key = `${operation.containerId}\u0000${operation.name}`;
    groups.set(key, [...(groups.get(key) ?? []), operation]);
  });

  groups.forEach(group => {
    if (group.length < 2) return;
    const baseName = group[0].name!.replace(/\d+$/, "") || group[0].name!;
    group.forEach((operation, index) => {
      operation.name = `${baseName}${index + 1}`;
    });
  });
}

/** 变更操作的字段校验结果：可用操作 + 被丢弃的原因 */
export interface NormalizedOperations {
  operations: AiChangeOperation[];
  /** 每条被丢弃操作的原因，用于在编辑模式下把问题回给模型 */
  errors: string[];
}

/**
 * 校验一条操作里的引用字段：只能引用本提案中更早声明 ref 的操作，种类必须匹配。
 *
 * 向前校验天然排除未知引用、前向引用与循环（引用只能向后看）；
 * shapeIds 是逗号分隔列表，其中每一项按图形 id 引用校验。
 *
 * @param operation 待校验操作
 * @param refOwners 已按顺序登记的 ref 归属（名称 → 声明它的操作）
 * @returns 出错说明（不含操作序号），通过时返回 undefined
 */
function findReferenceError(operation: AiChangeOperation, refOwners: Map<string, AiChangeOperation>): string | undefined {
  const check = (field: string, value: string): string | undefined => {
    const name = parseRefExpression(value);
    if (!name) return `的 ${field}「${value}」不是有效引用表达式（引用语法为 @ref:名称，真实 id 不能以 @ 开头）`;
    const owner = refOwners.get(name);
    if (!owner) {
      return `的 ${field} 引用了「${name}」，但该引用名没有在更早的操作中声明（引用只能指向本提案中之前声明 ref 的操作，不能前向引用或引用自己）`;
    }
    const kind = refFieldKind(field) ?? "shape";
    if (!refProvidersOf(owner.type).includes(kind)) {
      return `的 ${field} 不能引用「${name}」：${owner.type} 不产生${describeRefKind(kind)}（请改为引用能产生它的操作，或改用真实 id）`;
    }
    return undefined;
  };

  for (const field of [...REF_MODEL_FIELDS, ...REF_SHAPE_FIELDS]) {
    const value = operation[field];
    if (typeof value !== "string" || !value.trim() || !hasRefPrefix(value)) continue;
    const error = check(field, value);
    if (error) return error;
  }

  if (typeof operation.shapeIds === "string" && hasRefPrefix(operation.shapeIds)) {
    for (const item of operation.shapeIds
      .split(",")
      .map(part => part.trim())
      .filter(Boolean)) {
      if (!hasRefPrefix(item)) continue;
      const error = check("shapeIds", item);
      if (error) return error;
    }
  }

  return undefined;
}

/**
 * 把模型给出的操作数组收敛成可执行的操作，并报告被丢弃的项。
 *
 * 提案、计划转提案与编辑模式的直接执行共用：只有参数齐备、引用合法的操作才会进入执行，
 * 缺失必需字段的项不静默丢弃，而是把原因返回给调用方。
 * 引用预检在此完成：重名、未知引用、前向引用、自引用与种类不匹配都会被拦下。
 *
 * @param value 模型工具里的 operations 参数
 */
export function normalizeOperations(value: unknown): NormalizedOperations {
  if (!Array.isArray(value)) return { operations: [], errors: ["operations 必须是数组"] };

  const errors: string[] = [];
  const parsed: Array<{ operation: AiChangeOperation; index: number }> = [];

  value.forEach((item, index) => {
    const operation = parseOperation(item, index);
    if (operation) {
      parsed.push({ operation, index });
      return;
    }

    const source = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const type = source ? readString(source.type) : undefined;
    if (!type || !operationTypes.has(type as ProposalOperationType)) {
      errors.push(`第 ${index + 1} 项的 type 缺失或不是支持的类型`);
      return;
    }
    const problems = source ? describeFieldProblems(source, type as ProposalOperationType) : [];
    errors.push(`第 ${index + 1} 项（${type}）：${problems.length ? problems.join("、") : "字段不完整"}`);
  });

  // 引用名必须提案内唯一：重复声明的操作都不作为引用目标，避免指错对象
  const nameCounts = new Map<string, number>();
  parsed.forEach(({ operation }) => {
    if (operation.ref) nameCounts.set(operation.ref, (nameCounts.get(operation.ref) ?? 0) + 1);
  });
  const duplicatedNames = new Set([...nameCounts.entries()].filter(([, count]) => count > 1).map(([name]) => name));

  const operations: AiChangeOperation[] = [];
  const refOwners = new Map<string, AiChangeOperation>();

  for (const { operation, index } of parsed) {
    const label = `第 ${index + 1} 项（${operation.type}）`;
    if (operation.ref && duplicatedNames.has(operation.ref)) {
      errors.push(`${label}的引用名「${operation.ref}」在同一提案中重复声明`);
      continue;
    }
    if (operation.ref && !REF_NAME_PATTERN.test(operation.ref)) {
      errors.push(`${label}的引用名「${operation.ref}」不合法：需以字母开头，仅含字母、数字、下划线或连字符，长度不超过 32`);
      continue;
    }

    const referenceError = findReferenceError(operation, refOwners);
    if (referenceError) {
      errors.push(`${label}${referenceError}`);
      continue;
    }

    if (operation.ref) refOwners.set(operation.ref, operation);
    operations.push(operation);
  }

  return { operations, errors };
}

/** 将模型工具的输入收敛成可展示、可执行的提案；缺少 title/summary 时按操作兜底，只有操作本身不可解析才放弃。 */
export function createChangeProposal(value: unknown): AiChangeProposal | undefined {
  const source = parseObject(value);
  if (!source) return undefined;

  const { operations } = normalizeOperations(source.operations);
  if (!operations.length) return undefined;
  assignIncrementalCreateNames(operations);

  return {
    id: nanoid(),
    title: readString(source.title) ?? "模型变更提案",
    summary: readString(source.summary) ?? `${operations.length} 项模型变更`,
    operations,
    status: "pending"
  };
}

function parseChoiceOption(value: unknown, index: number): AiChoiceOption | undefined {
  if (!value || typeof value !== "object") return undefined;

  const source = value as Record<string, unknown>;
  const label = readString(source.label);
  if (!label) return undefined;

  const option: AiChoiceOption = {
    id: readString(source.id) ?? `option-${index + 1}`,
    label
  };
  const description = readString(source.description);
  if (description) option.description = description;
  return option;
}

/** 将模型的选择追问工具输入收敛成可展示的选择卡片；选项不足 2 个时放弃。 */
export function createChoicePrompt(value: unknown): AiChoicePrompt | undefined {
  const source = parseObject(value);
  if (!source) return undefined;

  const question = readString(source.question);
  if (!question || !Array.isArray(source.options)) return undefined;

  const options = source.options.map(parseChoiceOption).filter((option): option is AiChoiceOption => !!option);
  if (options.length < 2) return undefined;

  const customInput = source.allowCustomInput;
  return {
    id: nanoid(),
    question,
    options,
    allowCustomInput: customInput === undefined ? true : customInput !== false,
    status: "pending"
  };
}

/** 将模型漏调提案工具但已输出的 SysML 代码收敛成待确认提案。 */
export function createTextProposalFallback(
  assistantContent: string,
  userContent: string,
  fallbackNamespaceId?: string
): AiChangeProposal | undefined {
  if (!isModelChangeRequest(userContent)) return undefined;

  const namespaceId = fallbackNamespaceId || [...userContent.matchAll(/@\[[^\]]+\]\(([^)]+)\)/g)].at(-1)?.[1];
  const textualContent = /```(?:sysml|text)?\s*([\s\S]*?)```/i.exec(assistantContent)?.[1]?.trim();
  if (!namespaceId || !textualContent) return undefined;

  const title = /[「【]([^」】]+)[」】]\s*变更提案/.exec(assistantContent)?.[1] || "SysML 文本变更提案";
  return {
    id: nanoid(),
    title,
    summary: "检测到模型输出了 SysML 变更文本，请确认后写入目标命名空间。",
    operations: [
      {
        id: nanoid(),
        type: "replace-sysml-text",
        summary: "写入 SysML 文本并同步模型树",
        namespaceId,
        textualContent,
        status: "pending"
      }
    ],
    status: "pending"
  };
}
