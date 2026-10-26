import { nanoid } from "nanoid";
import { tryGetAiAssistantHost } from "../host";
import type { AiAttachment, AiChatMessage } from "../types";

/** 单条消息允许的附件数量上限 */
export const MAX_FILES_PER_MESSAGE = 4;
/** 文本附件读取上限（按 UTF-8 字节计，与 file.size 同口径）：超出截断，避免大文件随每轮对话重复发送 */
export const MAX_TEXT_BYTES = 256 * 1024;
/** 图片长边上限：主流视觉模型按 1568px 左右降采样 */
const IMAGE_MAX_EDGE = 1568;
const IMAGE_QUALITY = 0.85;
/** 只有最近这几条含图用户消息的图片随请求发送，更早的换成占位文本（控制上下文与费用） */
const MAX_IMAGE_TURNS = 3;
/** 文件选择框接受的类型（文本类 + 图片） */
export const ATTACHMENT_ACCEPT = [".sysml", ".kerml", ".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".log", "image/*"].join(",");

/** 允许作为文本附件读取的扩展名 */
const TEXT_EXTENSIONS = new Set(["sysml", "kerml", "txt", "md", "markdown", "json", "csv", "tsv", "xml", "yaml", "yml", "log"]);

/** 附件存储：优先用宿主注入的存储，缺省回退 localStorage（与设置存储同一套降级策略） */
const LOCAL_STORAGE_PREFIX = "ai-assistant:attachment:";

/** 附件被拒的原因（界面提示用） */
export interface AttachmentRejection {
  name: string;
  reason: string;
}

export interface AttachmentCollectResult {
  attachments: AiAttachment[];
  rejected: AttachmentRejection[];
}

/**
 * 图片附件的存储 key：与设置分开存放，会话 JSON 里只留附件 id。
 *
 * 宿主桌面端把每个 key 落成一个 `<key>.json`，所以这里只能用文件名安全字符（冒号在 Windows 非法）。
 */
function imageKey(attachmentId: string): string {
  return `image-${attachmentId}`;
}

function readAttachment(key: string): string | null {
  const storage = tryGetAiAssistantHost()?.attachmentStorage;
  if (storage) return storage.get(key);

  try {
    return window.localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`);
  } catch {
    return null;
  }
}

function writeAttachment(key: string, value: string): boolean {
  const storage = tryGetAiAssistantHost()?.attachmentStorage;
  if (storage) {
    try {
      storage.set(key, value);
      return true;
    } catch {
      return false;
    }
  }

  try {
    window.localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, value);
    return true;
  } catch {
    return false;
  }
}

function removeAttachment(key: string): void {
  const storage = tryGetAiAssistantHost()?.attachmentStorage;
  if (storage) {
    storage.remove(key);
    return;
  }

  try {
    window.localStorage.removeItem(`${LOCAL_STORAGE_PREFIX}${key}`);
  } catch {
    // 存储不可用时无需处理：没有写入也就没有可清理的内容
  }
}

/** 扩展名（小写，不含点）；没有扩展名时返回空串 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** 展示用的体积文本 */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件在气泡里的类型标签 */
export function attachmentKindLabel(attachment: AiAttachment): string {
  if (attachment.kind === "image") return "图片";
  return extensionOf(attachment.name).toUpperCase() || "文本";
}

/**
 * 按 UTF-8 字节裁剪文本，与 file.size 同口径。
 *
 * 不能直接用 `text.slice(0, MAX_TEXT_BYTES)`：slice 数的是 UTF-16 码元，中文注释一个字符占 3 字节，
 * 同样长度的文本实际体积能到上限的 3 倍。这里二分收敛，同时避免把多字节字符或代理对切成两半。
 */
function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return { text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).length <= maxBytes) low = middle;
    else high = middle - 1;
  }

  // 尾部若停在半个代理对（emoji 等）上，再去掉一个码元
  const tail = text.charCodeAt(low - 1);
  const end = tail >= 0xd800 && tail <= 0xdbff ? low - 1 : low;
  return { text: text.slice(0, end), truncated: true };
}

/** 读一个文本类文件为附件；最多读上限两倍的字节，再按字节裁到上限 */
async function readFileAttachment(file: File): Promise<AiAttachment> {
  // 2 倍读取窗口足够覆盖任意 UTF-8 字符宽度，避免超大文件整份读进内存
  const raw = await file.slice(0, MAX_TEXT_BYTES * 2).text();
  const { text, truncated } = truncateToBytes(raw, MAX_TEXT_BYTES);

  return {
    id: nanoid(),
    kind: "file",
    name: file.name,
    size: file.size,
    mimeType: file.type || undefined,
    text: truncated ? `${text}\n\n（内容过长，此处已截断）` : text,
    truncated: truncated || file.size > MAX_TEXT_BYTES || undefined
  };
}

/**
 * 把图片压到长边 1568 并转 JPEG。
 *
 * 粘贴来的截图常见是 2–4MB 的 PNG，直接进请求既贵又容易超限；统一铺白底再导 JPEG，
 * 透明通道不会变黑。图元解码失败（如 SVG）时由调用方回退为原文件。
 */
async function downscaleImage(file: File): Promise<{ dataUrl: string; mimeType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布上下文");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  return { dataUrl: canvas.toDataURL("image/jpeg", IMAGE_QUALITY), mimeType: "image/jpeg" };
}

/** 读原始文件为 data URL（降采样失败时的兜底） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

/** 读一个图片文件为附件（降采样优先，失败退回原图） */
async function readImageAttachment(file: File): Promise<AiAttachment> {
  const base = { id: nanoid(), kind: "image" as const, name: file.name || "粘贴的图片", size: file.size };

  try {
    const { dataUrl, mimeType } = await downscaleImage(file);
    return { ...base, mimeType, dataUrl };
  } catch {
    return { ...base, mimeType: file.type || "image/png", dataUrl: await readAsDataUrl(file) };
  }
}

/**
 * 把用户选中的文件收敛成附件列表。
 *
 * @param files 来自粘贴、拖拽或文件选择框的文件
 * @param remaining 本条消息还能再加几个附件
 */
export async function collectAttachments(files: File[], remaining = MAX_FILES_PER_MESSAGE): Promise<AttachmentCollectResult> {
  const attachments: AiAttachment[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const file of files) {
    if (attachments.length >= remaining) {
      rejected.push({ name: file.name, reason: `单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件` });
      continue;
    }

    const isImage = file.type.startsWith("image/");
    const isText = file.type.startsWith("text/") || TEXT_EXTENSIONS.has(extensionOf(file.name));

    if (!isImage && !isText) {
      rejected.push({ name: file.name, reason: "暂不支持该类型，请上传文本类文件或图片" });
      continue;
    }

    try {
      attachments.push(isImage ? await readImageAttachment(file) : await readFileAttachment(file));
    } catch {
      rejected.push({ name: file.name, reason: "读取失败" });
    }
  }

  return { attachments, rejected };
}

/**
 * 组装发给模型的用户文本：正文 + 文本附件块。
 *
 * 文本类附件内联进正文而不是走多模态文件通道——OpenAI 兼容端点的文件 part 支持参差，
 * 内联成带文件名的代码块则任何模型都能读。
 */
export function composeUserContent(content: string, attachments: AiAttachment[] = []): string {
  const files = attachments.filter(attachment => attachment.kind === "file" && attachment.text);
  if (!files.length) return content;

  const blocks = files.map(attachment => {
    const language = extensionOf(attachment.name);
    const title = `【附件：${attachment.name}${attachment.truncated ? "（已截断）" : ""}】`;
    return `${title}\n\`\`\`${language}\n${attachment.text}\n\`\`\``;
  });

  const head = content.trim();
  return [head, ...blocks].filter(Boolean).join("\n\n");
}

/** 早期含图消息里的图片不再随请求发送时的占位文本 */
export function imagePlaceholder(attachment: AiAttachment): string {
  return `[图片 ${attachment.name}：已从本轮请求中省略以控制上下文]`;
}

/**
 * 本轮请求里真正要发送的图片附件 id。
 *
 * 历史里的图片每轮都会重发，费用随对话轮数增长；只带最近 MAX_IMAGE_TURNS 条含图用户消息的图片，
 * 更早的由调用方换成占位文本（界面里图片照常显示）。
 */
export function selectRequestImageIds(messages: AiChatMessage[], maxTurns = MAX_IMAGE_TURNS): Set<string> {
  const ids = new Set<string>();
  const withImages = messages.filter(message => message.role === "user" && message.attachments?.some(attachment => attachment.kind === "image" && attachment.dataUrl));

  withImages.slice(-maxTurns).forEach(message => {
    message.attachments?.forEach(attachment => {
      if (attachment.kind === "image" && attachment.dataUrl) ids.add(attachment.id);
    });
  });

  return ids;
}

/** 已写入存储的图片 id：避免每轮 persist 重写同一份 base64 */
const writtenImageIds = new Set<string>();

export interface PersistedMessages {
  messages: AiChatMessage[];
  /** 因存储写入失败而没能保存的图片数量（0 表示全部成功） */
  unsavedImages: number;
}

/**
 * 会话落盘前的处理：把图片写进附件存储，并返回剥离了 dataUrl 的副本。
 *
 * 副本是浅拷贝，内存里的消息仍持有图片，界面与请求都不受影响；
 * 剥离是为了不让 base64 进入会话 JSON——那份 JSON 每轮都会整体重写。
 */
export function serializeMessagesForPersist(messages: AiChatMessage[]): PersistedMessages {
  let unsavedImages = 0;

  const persisted = messages.map(message => {
    if (!message.attachments?.length) return message;

    const attachments = message.attachments.map(attachment => {
      const { dataUrl } = attachment;
      if (attachment.kind !== "image" || !dataUrl) return attachment;
      if (!writtenImageIds.has(attachment.id) && !writeAttachment(imageKey(attachment.id), dataUrl)) unsavedImages += 1;
      else writtenImageIds.add(attachment.id);
      return { ...attachment, dataUrl: undefined };
    });

    return { ...message, attachments };
  });

  return { messages: persisted, unsavedImages };
}

/** 会话加载后回填图片：命中存储则补回 dataUrl，未命中标记 missing 供界面提示 */
export function hydrateMessageImages(messages: AiChatMessage[]): void {
  messages.forEach(message => {
    message.attachments?.forEach(attachment => {
      if (attachment.kind !== "image") return;

      const dataUrl = readAttachment(imageKey(attachment.id));
      if (dataUrl) {
        attachment.dataUrl = dataUrl;
        delete attachment.missing;
        writtenImageIds.add(attachment.id);
        return;
      }

      attachment.missing = true;
    });
  });
}

/** 释放图片：会话被删除、会话与消息被上限淘汰时调用 */
export function releaseMessageImages(messages: AiChatMessage[]): void {
  messages.forEach(message => {
    message.attachments?.forEach(attachment => {
      if (attachment.kind !== "image") return;
      removeAttachment(imageKey(attachment.id));
      writtenImageIds.delete(attachment.id);
    });
  });
}

/** 消息里全部图片附件（清理与统计用） */
export function imageAttachmentsOf(messages: AiChatMessage[]): AiAttachment[] {
  return messages.flatMap(message => message.attachments?.filter(attachment => attachment.kind === "image") ?? []);
}
