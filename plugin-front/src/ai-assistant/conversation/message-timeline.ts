import type { AiChatMessage } from "../types";

/** 正文同时保留完整内容和时间线片段，供复制、历史上下文和阶段展示使用。 */
export function appendMessageText(message: AiChatMessage, delta: string): void {
  if (!delta) return;
  const steps = [...(message.steps ?? [])];
  const last = steps[steps.length - 1];
  if (last?.kind === "text") steps[steps.length - 1] = { kind: "text", text: last.text + delta };
  else steps.push({ kind: "text", text: delta });
  message.steps = steps;
  message.content += delta;
}

/** 每段正文结束一个阶段，随后到达的工具和思考属于下一阶段。 */
export function messageStages(message: Pick<AiChatMessage, "steps" | "content">) {
  const stages: { key: number; stepIndexes: number[]; text: string }[] = [];
  let stage = { key: 0, stepIndexes: [] as number[], text: "" };
  for (const [index, step] of (message.steps ?? []).entries()) {
    if (step.kind === "text") {
      stage.text += step.text;
    } else {
      if (stage.text) {
        stages.push(stage);
        stage = { key: index, stepIndexes: [], text: "" };
      }
      stage.stepIndexes.push(index);
    }
  }
  // 旧会话没有正文事件，无法还原先后顺序，沿用单段正文展示。
  if (!message.steps?.some(step => step.kind === "text")) stage.text = message.content;
  stages.push(stage);
  return stages;
}
