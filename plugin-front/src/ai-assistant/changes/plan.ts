import { nanoid } from "nanoid";
import type { AiChangeOperation, AiChangePlan, AiPlanStep } from "../types";

type ProposalOperationType = AiChangeOperation["type"];

const STEP_TYPES = new Set<ProposalOperationType>(["create-element", "update-property", "delete-element", "replace-sysml-text", "create-shape", "create-connector", "place-shape", "arrange-shapes"]);

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 把一条步骤值解析成可执行操作的来源对象。
 *
 * 计划步骤比提案操作宽松：acceptance / options / doc 这类纯信息字段不进入操作；
 * 操作字段（create-element 的 elementType 等）才保留。非法步骤返回 undefined。
 */
function parseStep(value: unknown): AiChangeOperation | undefined {
  if (!value || typeof value !== "object") return undefined;

  const source = value as Record<string, unknown>;
  const type = readString(source.type) as ProposalOperationType | undefined;
  if (!type || !STEP_TYPES.has(type)) return undefined;

  const operation: AiChangeOperation = {
    id: readString(source.id) ?? `step-${nanoid(6)}`,
    type,
    summary: readString(source.summary) ?? describeStep(type, source),
    status: "pending"
  };

  const fields = ["name", "elementType", "containerId", "elementId", "propertyName", "propertyKey", "oldValue", "newValue", "control", "namespaceId", "textualContent", "diagramId", "elementConfigId", "containerShapeId", "x", "y", "sourceShapeId", "targetShapeId", "shapeIds", "layout", "direction", "ref", "startX", "startY"] as const;
  for (const field of fields) {
    const fieldValue = source[field];
    if (typeof fieldValue === "string") operation[field] = fieldValue;
  }

  return operation;
}

/** 步骤缺 summary 时按类型与关键字段兜底，避免显示空白 */
function describeStep(type: ProposalOperationType, source: Record<string, unknown>): string {
  const name = readString(source.name);
  const elementId = readString(source.elementId);
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
      return `替换 SysML 文本${readString(source.namespaceId) ? `（${readString(source.namespaceId)}）` : ""}`;
  }
}

/** 步骤里允许出现的纯信息字段（不进操作本体） */
function describeStepExtra(step: Record<string, unknown>): { acceptance?: string; doc?: string } {
  const result: { acceptance?: string; doc?: string } = {};
  const acceptance = readString(step.acceptance);
  if (acceptance) result.acceptance = acceptance;
  const doc = readString(step.doc);
  if (doc) result.doc = doc;
  return result;
}

/**
 * 把模型工具的输入收敛成一份可展示、可勾选执行的计划。
 *
 * 与提案不同：步骤允许带 acceptance / doc 这类说明，且不要求每个步骤现在就参数齐备
 * （用户可以先看计划、再决定执行哪几步；真正执行时仍走提案/编辑同一套字段校验）。
 * 只接受 type 合法的操作类步骤，纯说明段被丢弃。至少 1 个可执行步骤才成立。
 */
export function createChangePlan(value: unknown): AiChangePlan | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.steps)) return undefined;

  const steps: AiPlanStep[] = [];
  source.steps.forEach(item => {
    const operation = parseStep(item);
    if (!operation) return;
    const step: AiPlanStep = { ...describeStepExtra(item as Record<string, unknown>), ...operation };
    steps.push(step);
  });

  if (!steps.length) return undefined;

  return {
    id: readString(source.id) ?? `plan-${nanoid()}`,
    title: readString(source.title) ?? "变更计划",
    summary: readString(source.summary) ?? `${steps.length} 个步骤`,
    steps,
    status: "pending"
  };
}
