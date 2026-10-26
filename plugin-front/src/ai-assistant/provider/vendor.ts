/** 从模型 id 推断供应商：优先用前缀，其次识别常见命名 */
export function vendorOf(id: string): string {
  if (id.includes("/")) return id.split("/")[0];
  if (id.startsWith("gpt")) return "openai";
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gemini")) return "google";
  if (id.startsWith("grok")) return "xai";

  return "其他";
}

/**
 * 模型名是否像支持图片输入的视觉模型。
 *
 * 供应商的 /models 不返回能力字段，profile 里也没有视觉标记，只能按命名判断；
 * 这里只用于**提示**（附加图片时提醒一句），不阻断发送——真正不支持时由供应商报错兜底。
 */
export function likelyVisionModel(id: string): boolean {
  const name = id.toLowerCase();
  if (/vision|-vl\b|vl-|omni|multimodal/.test(name)) return true;
  if (/^(?:gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|o[134])/.test(name)) return true;
  if (/^claude-(?:3|4|sonnet|opus|haiku)/.test(name)) return true;
  if (/^gemini/.test(name)) return true;
  if (/^(?:glm-4v|qwen(?:\d)?-?vl|internvl|llava|pixtral|moonshot-v1-vision)/.test(name)) return true;

  return false;
}

/** 未收录品牌的首字母文字 */
export function vendorMonogram(vendor: string): string {
  return vendor.slice(0, 1).toUpperCase();
}
