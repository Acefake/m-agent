import type { AiChatMessage } from "../types";

/**
 * 会话历史摘要：会话消息超过本地上限被截断时，把被丢弃的旧消息折成纯文本摘要，
 * 保证早期目标、约束与真实执行收据不会随截断从模型上下文中彻底消失。
 *
 * 摘要是本地的确定性提取（不拼接模型输出），只保留：
 * 用户原文片段、助手结论片段、写入收据、提案状态；属性旧值等细节一律要求重新读取。
 */

const MAX_DIGEST_CHARS = 8000;
const USER_TEXT_LIMIT = 200;
const ASSISTANT_TEXT_LIMIT = 200;
const RECEIPT_LIMIT = 400;

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 把一条被截断的消息提取成摘要行 */
function messageDigest(message: AiChatMessage): string {
  if (message.role === "user") {
    const text = clip(message.content, USER_TEXT_LIMIT);
    const attachments = message.attachments?.length ? `（附件 ${message.attachments.length} 个）` : "";
    return text || attachments ? `用户：${text}${attachments}` : "";
  }
  const lines: string[] = [];
  if (message.content) lines.push(`助手：${clip(message.content, ASSISTANT_TEXT_LIMIT)}`);
  // 写入收据含真实 ID：必须保留，续跑时据此避免重复创建
  for (const call of message.toolCalls) {
    if (call.name === "model_apply_changes" && call.state === "done" && call.output) {
      lines.push(`执行收据：${clip(call.output, RECEIPT_LIMIT)}`);
    }
  }
  if (message.proposal) lines.push(`曾生成提案「${clip(message.proposal.title, 60)}」（状态：${message.proposal.status}）`);
  return lines.join("\n");
}

/**
 * 把一批被截断的消息合成摘要文本。
 * @param messages 被丢弃的消息（按原时间顺序）
 * @returns 摘要文本；没有可提取内容时返回空字符串
 */
export function buildConversationDigest(messages: AiChatMessage[]): string {
  return messages.map(messageDigest).filter(Boolean).join("\n");
}

/**
 * 合并旧摘要与新截断的消息；总长超限时从头部截断（更早的摘要先让位）。
 * @param previous 之前保存的摘要
 * @param dropped 本次被截断的消息
 * @returns 合并后的摘要；无内容时返回空字符串
 */
export function mergeConversationDigest(previous: string | undefined, dropped: AiChatMessage[]): string {
  const merged = [previous?.trim(), buildConversationDigest(dropped)].filter(Boolean).join("\n");
  if (merged.length <= MAX_DIGEST_CHARS) return merged;
  return `（更早摘要已省略）\n${merged.slice(merged.length - MAX_DIGEST_CHARS)}`;
}
