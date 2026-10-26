import type { AiContextSnapshot } from "../types";

/**
 * 会话上下文快照：把用户当前正在看的图表带进本轮请求。
 *
 * 助手的工作范围始终是整个项目模型：模型树是否选中节点都按全部处理，
 * 不注入选中项（选中节点作为引用上下文的能力后续再做）。
 * 快照随消息一起落盘（见 AiChatMessage.context），历史气泡据此显示当时在看什么。
 */
export interface ContextCaptureHost {
  /** 捕获当前界面上下文；拿不到任何内容时返回 undefined */
  capture(): AiContextSnapshot | undefined;
}

/**
 * 捕获上下文快照并渲染成注入正文的一段。
 *
 * @param host 宿主注入的捕获能力；缺省时返回空结果
 * @returns 快照与注入正文（正文为空表示没有可注入的上下文）
 */
export function captureContext(host: ContextCaptureHost | undefined): { snapshot?: AiContextSnapshot; block: string } {
  if (!host) return { block: "" };

  const snapshot = host.capture();
  if (!snapshot) return { block: "" };

  const block = renderContextBlock(snapshot);
  return block ? { snapshot, block } : { block: "" };
}

/**
 * 把快照渲染成注入用户消息的文本块。
 *
 * 用【上下文】标记而不是系统提示：系统提示按会话缓存、每轮不变，
 * 而当前所在图表每轮都可能变；放在消息里也让历史轮次各自保留当时的上下文。
 */
export function renderContextBlock(snapshot: AiContextSnapshot): string {
  const lines: string[] = [];

  if (snapshot.diagram) {
    const shapes = snapshot.diagram.shapeCount === undefined ? "" : `，${snapshot.diagram.shapeCount} 个图形`;
    lines.push(`【当前图表】${snapshot.diagram.name}（diagramId=${snapshot.diagram.id}${shapes}）`);
  }

  if (snapshot.textNamespace) {
    lines.push(`【当前文本】${snapshot.textNamespace.name}（命名空间 id=${snapshot.textNamespace.id}）`);
  }

  if (!lines.length) return "";
  return `${lines.join("\n")}\n（以上是用户当前界面上下文；助手的工作范围是整个项目模型，不受界面选中项限制）`;
}
