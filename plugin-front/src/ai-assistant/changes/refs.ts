import type { AiChangeOperation } from "../types";

/**
 * 提案内本地引用的语法与字段约定（提案预检与宿主执行解析共用）。
 *
 * 模型在创建类操作上声明 ref（提案内唯一），后续操作的 id 字段写 `@ref:名称`；
 * 解析按字段语义区分模型元素 id 与图形 id，不做名称匹配。
 */

/** ID 字段里的引用表达式前缀 */
export const REF_EXPRESSION_PREFIX = "@ref:";

/** 本地引用名的合法形式：字母开头，仅含字母、数字、下划线、连字符，最长 32 */
export const REF_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** 引用结果的种类：模型元素 id 或图形 id */
export type RefResultKind = "model" | "shape";

/** 期望模型元素 id 的引用字段 */
export const REF_MODEL_FIELDS = ["containerId", "elementId"] as const;

/** 期望图形 id 的引用字段 */
export const REF_SHAPE_FIELDS = ["containerShapeId", "sourceShapeId", "targetShapeId"] as const;

/**
 * 解析引用表达式，取引用名；不是合法引用表达式时返回 undefined。
 * 形如 `@ref:名称`，名称两侧空白会被去掉。
 */
export function parseRefExpression(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith(REF_EXPRESSION_PREFIX)) return undefined;
  const name = trimmed.slice(REF_EXPRESSION_PREFIX.length).trim();
  return name || undefined;
}

/** 看起来是引用（以 @ 开头）但没有用 @ref: 语法 */
export function hasRefPrefix(value: string): boolean {
  return value.trim().startsWith("@");
}

/** 字段期望的引用结果种类；不是引用类字段时返回 undefined */
export function refFieldKind(field: string): RefResultKind | undefined {
  if ((REF_MODEL_FIELDS as readonly string[]).includes(field)) return "model";
  if ((REF_SHAPE_FIELDS as readonly string[]).includes(field)) return "shape";
  return undefined;
}

/**
 * 各操作类型能提供的引用结果种类。
 *
 * create-shape 是否提供模型元素 id 取决于组件行为（纯图形组件不建模型），
 * 预检按“可能提供”放行，执行后按实际结果确认。
 */
export function refProvidersOf(type: AiChangeOperation["type"]): RefResultKind[] {
  switch (type) {
    case "create-element":
      return ["model"];
    case "create-shape":
      return ["model", "shape"];
    case "place-shape":
      return ["model", "shape"];
    case "create-connector":
      return ["shape"];
    default:
      return [];
  }
}

/** 引用结果种类的中文说明（错误信息用） */
export function describeRefKind(kind: RefResultKind): string {
  return kind === "model" ? "模型元素 id" : "图形 id";
}
