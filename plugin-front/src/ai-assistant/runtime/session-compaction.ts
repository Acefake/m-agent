import type { ModelMessage } from "ai";

/**
 * 会话级上下文压缩。
 *
 * 与 context-compaction.ts 的分工：
 * - context-compaction：缩减单条旧只读结果（去重、属性目录化），保留每一条消息；
 * - 本模块：整个会话超出请求预算时，把较早的完整轮次折叠成结构化摘要，近期消息保持原文。
 *
 * 摘要由本地规则从消息内容生成（不额外请求模型），只保留目标、结论、真实 ID 与执行收据；
 * 属性旧值等细节无法从摘要恢复，提示模型在改动前按 key 重新读取。
 * 压缩结果只用于本次请求，不写回会话历史：磁盘与界面始终保留原始消息。
 */

/** 摘要头部标识：提示模型这是系统生成的早期会话摘要而非用户输入 */
const DIGEST_HEADER = "【较早会话摘要（系统自动压缩，保留目标、结论与真实 ID；属性旧值等细节在改动前必须按 key 重新读取）】";
/** 图片/文件附件按固定开销估算，避免 base64 体积把估算撑爆 */
const ATTACHMENT_TOKENS = 1200;
const MESSAGE_OVERHEAD = 4;
/** 近期消息保留预算：上下文预算的一半，下限 4096 */
const RECENT_SHARE = 0.5;
const MIN_RECENT_TOKENS = 4096;
/** 摘要容量上限；请求预算较小时按比例缩小 */
const DIGEST_MAX_CHARS = 6000;

/**
 * 估算文本 token 数：CJK 一字约一 token，其余按四字符一 token。
 * @param text 待估文本
 * @returns 粗略 token 数
 */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) >= 0x2e80) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function resultTokens(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const record = output as { type?: unknown; value?: unknown };
  if (record.type === "text" || record.type === "error-text") return estimateTextTokens(String(record.value ?? ""));
  if (record.value !== undefined) return estimateTextTokens(safeJson(record.value));
  return 0;
}

/** 单条消息的粗略 token 开销 */
function messageTokens(message: ModelMessage): number {
  const content = message.content;
  if (typeof content === "string") return MESSAGE_OVERHEAD + estimateTextTokens(content);
  let tokens = MESSAGE_OVERHEAD;
  for (const part of content as Array<{ type: string; [key: string]: unknown }>) {
    if (part.type === "text") tokens += estimateTextTokens(String(part.text ?? ""));
    else if (part.type === "image" || part.type === "file") tokens += ATTACHMENT_TOKENS;
    else if (part.type === "tool-call") {
      tokens += estimateTextTokens(String(part.toolName ?? "")) + estimateTextTokens(safeJson(part.input));
    } else if (part.type === "tool-result") tokens += resultTokens(part.output);
    // reasoning 等其余片段不占保留预算
  }
  return tokens;
}

/**
 * 估算一组模型消息占用的上下文容量。
 * @param messages 模型消息列表
 * @returns 粗略 token 数
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 工具调用里最值得保留的字段（ID、名称、类型），最多取 4 个 */
function salientInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const fields: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    if (typeof value === "string" && !value.trim()) continue;
    fields.push(`${key}=${clip(String(value), 40)}`);
    if (fields.length >= 4) break;
  }
  return fields.join(" ");
}

/** 执行收据与失败信息的关键特征：这类结果必须整段保留可定位的内容 */
const RECEIPT_PATTERN = /^(?:已执行|执行未全部完成|已生成|已向用户发起|已从图表|已恢复)/;

function digestLines(message: ModelMessage): string[] {
  const content = message.content;
  if (typeof content === "string") {
    if (!content.trim()) return [];
    if (message.role === "system") return [`系统：${clip(content, 400)}`];
    if (message.role === "user") return [`用户：${clip(content, 500)}`];
    if (message.role === "assistant") return [`助手：${clip(content, 300)}`];
    return [];
  }
  if (message.role === "user") {
    let text = "";
    let attachments = 0;
    for (const part of content) {
      if (part.type === "text") text += part.text;
      else attachments += 1;
    }
    const label = attachments ? `（含 ${attachments} 个附件/图片）` : "";
    return text.trim() || attachments ? [`用户：${clip(text, 500)}${label}`] : [];
  }
  if (message.role === "assistant") {
    const lines: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text.trim()) lines.push(`助手：${clip(part.text, 300)}`);
      else if (part.type === "tool-call") {
        const input = salientInput(part.input);
        lines.push(`调用 ${part.toolName}${input ? `（${input}）` : ""}`);
      }
    }
    return lines;
  }
  const lines: string[] = [];
  for (const part of content) {
    if (part.type !== "tool-result") continue;
    const output = part.output as { type?: unknown; value?: unknown };
    if (output.type === "error-text") {
      lines.push(`[失败] ${part.toolName}：${clip(String(output.value ?? ""), 200)}`);
      continue;
    }
    const value = output.type === "text" ? String(output.value ?? "") : safeJson(output.value);
    if (!value.trim()) continue;
    // 执行收据与追问结果整段保留（含真实 ID 与失败原因），只读结果只留首段
    if (RECEIPT_PATTERN.test(value.trim())) lines.push(`收据：${clip(value, 500)}`);
    else lines.push(`${part.toolName}：${clip(value, 160)}`);
  }
  return lines;
}

interface DigestEntry {
  order: number;
  kind: "goal" | "receipt" | "line";
  text: string;
}

const RECEIPT_LINE_PATTERN = /^收据：|^\[失败\]/;

/** 把一批旧消息展开成带优先级的摘要条目 */
function collectDigestEntries(prefix: ModelMessage[]): DigestEntry[] {
  const firstUser = prefix.findIndex(message => message.role === "user");
  const entries: DigestEntry[] = [];
  prefix.forEach((message, messageIndex) => {
    digestLines(message).forEach((text, lineIndex) => {
      const kind: DigestEntry["kind"] = messageIndex === firstUser ? "goal" : RECEIPT_LINE_PATTERN.test(text) ? "receipt" : "line";
      entries.push({ order: messageIndex * 100 + lineIndex, kind, text });
    });
  });
  return entries;
}

/**
 * 把一批旧消息压成结构化摘要。
 *
 * 保留优先级：原始目标 > 执行收据/失败信息 > 其余；同档内新的优先。
 * 输出按原时间顺序排列，结尾注明被省略的条目数。
 */
function buildDigest(prefix: ModelMessage[], maxChars: number): string {
  const entries = collectDigestEntries(prefix);
  if (!entries.length) return "";
  const picked: DigestEntry[] = [];
  let used = 0;
  const tryPush = (entry: DigestEntry) => {
    if (used + entry.text.length > maxChars) return;
    used += entry.text.length;
    picked.push(entry);
  };
  entries.filter(entry => entry.kind === "goal").forEach(tryPush);
  // 收据与失败信息是续跑防重复写入的关键证据，先于普通段落保留
  [...entries].reverse().filter(entry => entry.kind === "receipt").forEach(tryPush);
  [...entries].reverse().filter(entry => entry.kind === "line").forEach(tryPush);
  if (!picked.length) return "";
  picked.sort((left, right) => left.order - right.order);
  const omitted = entries.length - picked.length;
  return [...picked.map(entry => entry.text), omitted > 0 ? `（另有 ${omitted} 条更早记录已省略）` : ""].filter(Boolean).join("\n");
}

/**
 * 按上下文预算压缩会话：超出预算时把较早消息折成结构化摘要，近期消息保持原文。
 *
 * 切分保证工具调用与结果不分离（摘要消息本身携带两侧内容，尾部不以孤立工具结果开头）。
 * 压缩结果只用于本次请求，不写回会话历史。
 *
 * @param messages 完整模型消息（历史 + 本轮已生成）
 * @param budget 单次请求的输入预算（token）；缺省或不大于零时不压缩
 * @returns 压缩后的消息列表；无需压缩或压缩无收益时原样返回
 */
export function compactSessionMessages(messages: ModelMessage[], budget?: number): ModelMessage[] {
  if (!budget || budget <= 0 || messages.length < 4) return messages;
  const total = estimateMessagesTokens(messages);
  if (total <= budget) return messages;

  // 从尾部累计近期保留量：预算的一半（下限 4096）保持原文
  const recentBudget = Math.max(MIN_RECENT_TOKENS, Math.floor(budget * RECENT_SHARE));
  let cut = messages.length;
  let kept = 0;
  while (cut > 1) {
    const cost = messageTokens(messages[cut - 1]);
    if (kept + cost > recentBudget) break;
    kept += cost;
    cut -= 1;
  }
  // 最后的阶段可能整条超过近期预算：没有可压缩的共同前缀
  if (cut <= 1 || cut >= messages.length) return messages;
  // 工具结果不能与它的调用消息分离：切点回退到成对边界之前
  while (cut > 1 && messages[cut].role === "tool") cut -= 1;
  if (cut <= 1) return messages;

  const digestChars = Math.min(DIGEST_MAX_CHARS, Math.max(1000, Math.floor(budget * 0.15)));
  const digest = buildDigest(messages.slice(0, cut), digestChars);
  if (!digest) return messages;

  // AI SDK 不允许 messages 里出现 system 角色，摘要以带标识的 user 消息注入
  const summary: ModelMessage = { role: "user", content: `${DIGEST_HEADER}\n${digest}` };
  const compacted = [summary, ...messages.slice(cut)];
  // 压缩后没有实际变小就不替换（例如预算过小、摘要本身超预算）
  return estimateMessagesTokens(compacted) < total ? compacted : messages;
}
