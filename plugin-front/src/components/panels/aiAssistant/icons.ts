import { ICON_DATA } from "./icons.data";

/**
 * 面板图标：Lucide（ISC 许可）的 24×24 线性图标。
 *
 * 图标数据固化在 icons.data.ts（由 scripts/extract-icons.mjs 从 @iconify-json/lucide 抽取），
 * 因此运行时不依赖图标库、产物里也只有这几个图标，而不是整份图标集。
 */
export type IconName =
  | "shield"
  | "message-square-text"
  | "file-check"
  | "square-pen"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "plus"
  | "settings-2"
  | "search"
  | "arrow-up"
  | "square"
  | "brain"
  | "layers"
  | "file-text"
  | "copy"
  | "x"
  | "trash-2"
  | "eye"
  | "eye-off"
  | "paperclip"
  | "image"
  | "star";

/** 单个 SVG 元素：属性直接透传给渲染组件（描边由组件统一设置） */
export interface IconElement {
  tag: string;
  attrs: Record<string, string>;
}

/** 单个图标的渲染数据：视框边长 + 描边线宽 + 元素列表 */
export interface IconData {
  /** 视框边长（Lucide 缺省 24，个别图标自带覆盖） */
  size: number;
  /**
   * 描边线宽：Lucide 按 24×24 视框、线宽 2 设计，抽取时原样固化下来。
   *
   * 图元上的描边属性在抽取阶段已被剔除，只能由 AiIcon 渲染时统一写回；
   * 缺了它浏览器会按 stroke-width=1 渲染，图标明显细于设计稿。
   * 小尺寸处的微调（如 12-14px 缩到 1.8）留给使用处的样式覆盖。
   */
  strokeWidth: number;
  elements: IconElement[];
}

/** 面板用到的全部图标 */
export const ICONS: Record<IconName, IconData> = ICON_DATA;
