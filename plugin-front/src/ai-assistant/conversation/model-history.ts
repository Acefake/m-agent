import type { ModelMessage } from "ai";
import type { AiChatMessage } from "../types";

/** 历史优先保留工具调用及结果；旧会话补入执行收据，避免续跑时丢失已创建 ID。 */
export function assistantHistory(message: AiChatMessage): ModelMessage[] {
  if (message.modelContext) {
    try {
      const context = JSON.parse(message.modelContext) as ModelMessage[];
      // 上轮内部推理不参与后续请求；正文结论、工具配对及写入收据原样保留。
      return context.flatMap(item => {
        if (item.role !== "assistant" || !Array.isArray(item.content)) return [item];
        const content = item.content.filter(part => part.type !== "reasoning");
        return content.length ? [{ ...item, content }] : [];
      });
    } catch {
      /* Fall back to recorded receipts. */
    }
  }
  const receipts = message.toolCalls
    .filter(call => call.name === "model_apply_changes" && call.state === "done" && call.output)
    .map(call => call.output);
  const content = [message.content, receipts.length ? "此前工具的实际执行结果（不要重复执行）：\n" + receipts.join("\n") : ""]
    .filter(Boolean)
    .join("\n\n");
  return content ? [{ role: "assistant", content }] : [];
}
