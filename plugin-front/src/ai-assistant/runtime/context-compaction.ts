import type { ModelMessage } from "ai";

const RECENT_TOOL_MESSAGES = 2;
const LARGE_RESULT_LENGTH = 1600;
const RECENT_RESULT_BUDGET = 6000;
const READ_TOOLS = new Set([
  "model_get_tree",
  "model_search",
  "model_get_element",
  "model_get_children",
  "model_get_relationships",
  "model_get_properties",
  "text_read_sysml",
  "diagram_read_shapes",
  "diagram_read_palette",
  "model_get_creatable_element_types"
]);
const SUMMARY_MARKER = "【旧只读结果摘要】";
const ID_PATTERN = /(?:[\w.-]*id|uuid)["']?\s*[:=]\s*["']?[^\s,"'，；;）)\]}>]+|\b\d{16,}\b|\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi;

/** 保留标明的 ID、长整数 ID 和 UUID，字符串处理以免 long 精度丢失。 */
function identifiers(text: string): string[] {
  const values = [...new Set(text.match(ID_PATTERN) ?? [])];
  return values.filter(value => !values.some(other => other !== value && /[:=]/.test(other) && other.endsWith(value)));
}

function summarize(text: string): string {
  if (text.length <= LARGE_RESULT_LENGTH || text.startsWith(SUMMARY_MARKER)) return text;

  const index = text.split("\n").flatMap(line => {
    const ids = identifiers(line);
    const label = line
      .replace(ID_PATTERN, "")
      .replace(/\[[^\]]*\]/g, "")
      .replace(/^[\s│├└─*-]+/, "")
      .trim()
      .slice(0, 80);
    return ids.length ? [`${label}: ${ids.join(" ")}`] : [];
  });
  const summary = `${SUMMARY_MARKER}\n${text.slice(0, 400)}\n${index.join("\n")}\n旧属性值和详情已省略；需要时用原工具参数重新读取，修改属性前按 key 重新读取当前值。`;
  return summary.length < text.length ? summary : text;
}

/** 仅缩减发给模型的旧只读结果；调用配对、写入收据、错误及原始会话保持原样。 */
export function compactToolResults(messages: ModelMessage[]): ModelMessage[] {
  let remaining = messages.filter(message => message.role === "tool").length;
  // 之前用户轮次的读取不再占用当前轮次的完整结果预算。
  let lastUserIndex = -1;
  messages.forEach((message, index) => {
    if (message.role === "user") lastUserIndex = index;
  });
  let recentChars = 0;
  const previousReads = new Map<string, { id: string; full: boolean }>();
  const targetedProperties = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.toolName !== "model_get_properties") continue;
      const input = part.input;
      if (
        input &&
        typeof input === "object" &&
        "propertyNames" in input &&
        Array.isArray(input.propertyNames) &&
        input.propertyNames.length
      ) {
        targetedProperties.add(part.toolCallId);
      }
    }
  }
  return messages.map((message, messageIndex) => {
    if (message.role !== "tool") return message;
    const recent = --remaining < RECENT_TOOL_MESSAGES && messageIndex > lastUserIndex;
    return {
      ...message,
      content: message.content.map(part => {
        if (part.type !== "tool-result" || !READ_TOOLS.has(part.toolName)) return part;
        const output = part.output;
        let text: string;
        if (output.type === "text") text = output.value;
        else if (output.type === "json" && part.toolName === "model_get_creatable_element_types" && Array.isArray(output.value)) {
          // 类型和名称完整保留，只省去重复的 JSON 字段名。
          const entries = output.value;
          if (!entries.every(item => item && typeof item === "object" && "elementType" in item && "name" in item)) return part;
          text =
            "可创建类型（每行 [elementType, name]）：\n" +
            entries
              .map(item => {
                const row = item as { elementType: unknown; name: unknown };
                return JSON.stringify([row.elementType, row.name]);
              })
              .join("\n");
        } else return part;
        const key = `${part.toolName}\n${text}`;
        const previous = previousReads.get(key);
        const keepCurrentValues = recent && part.toolName === "model_get_properties";
        if (previous && text.length > LARGE_RESULT_LENGTH && (!keepCurrentValues || previous.full)) {
          return {
            ...part,
            output: {
              type: "text" as const,
              value: `与此前工具调用 ${previous.id} 的只读结果相同；沿用其结果和真实 ID，需要当前详情时重新读取。`
            }
          };
        }
        recentChars += recent ? text.length : 0;
        const keepFull =
          keepCurrentValues || (recent && recentChars <= RECENT_RESULT_BUDGET) || part.toolName === "model_get_creatable_element_types";
        // 全量属性表过大时只返回属性目录，按 key 重读时才保留完整当前值。
        const propertyCatalog =
          keepCurrentValues && recentChars > RECENT_RESULT_BUDGET && !targetedProperties.has(part.toolCallId)
            ? text
                .split("\n")
                .filter(line => line.includes("propertyKey="))
                .map(line => line.split("当前值:")[0].trim())
            : [];
        const value = propertyCatalog.length
          ? `属性目录（当前值未提供，请用 propertyNames 指定下列 key 按需读取）：\n${propertyCatalog.join("\n")}`
          : keepFull
            ? text
            : summarize(text);
        previousReads.set(key, { id: part.toolCallId, full: value === text });
        return { ...part, output: { type: "text" as const, value } };
      })
    };
  });
}
