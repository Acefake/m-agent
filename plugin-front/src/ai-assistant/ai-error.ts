/** HTTP 状态码对应的中文提示（AI SDK 的 APICallError 带 statusCode） */
const HTTP_STATUS_HINTS: Record<number, string> = {
  400: "AI 请求参数有误（400），请检查模型名称等配置",
  401: "AI 服务鉴权失败（401），请重新保存该供应商的 API Key",
  403: "AI 服务拒绝访问（403），请检查 API Key 权限与模型可用性",
  404: "AI 接口地址不存在（404），请检查供应商接口地址",
  429: "请求过于频繁（429），请稍后重试或更换模型",
  500: "AI 服务内部错误（500），请稍后重试",
  502: "AI 网关错误（502），请稍后重试",
  503: "AI 服务暂不可用（503），请稍后重试",
  504: "AI 网关超时（504），请稍后重试"
};

/** 底层网络/证书错误的中文提示，渲染层与 Node 代理共用 */
const NETWORK_ERROR_HINTS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i, message: "无法解析 AI 服务域名，请检查网络或供应商接口地址" },
  { pattern: /ECONNREFUSED/i, message: "AI 服务拒绝连接，请确认供应商接口地址与端口" },
  { pattern: /ECONNRESET|socket hang up|socket disconnected/i, message: "AI 服务连接被中断，请重试；若持续出现请检查代理或防火墙" },
  { pattern: /ETIMEDOUT|timed out|timeout/i, message: "AI 服务连接超时，请重试" },
  { pattern: /TLS|certificate|EPROTO|SSL/i, message: "TLS 握手失败，通常是网络或代理中断了连接：请检查代理、防火墙与供应商接口地址" }
];

/**
 * 判断错误是否属于传输层失败（域名解析、连接被拒/重置、超时、TLS 中断）。
 *
 * 只用于把传输层失败翻译成 fetch 语义：AI SDK 只重试这一层失败，
 * 业务校验与鉴权失败重发同样的请求也不会成功，必须保持原对象不被标记为可重试。
 *
 * @param error 原始错误
 */
export function isTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return NETWORK_ERROR_HINTS.some(item => item.pattern.test(message));
}

/**
 * 供应商返回体里的错误说明。
 *
 * AI SDK 把上游响应体放在 responseBody（字符串）或 data（已解析对象）里；
 * 网关的附加要求（例如 OpenCode Go 的 MissingSessionID / x-opencode-session）
 * 只会出现在这里，取出来拼进提示，用户才知道要补什么。
 */
function readProviderMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;

  const candidate = error as { responseBody?: unknown; data?: unknown; cause?: unknown };
  const payload = parseProviderPayload(candidate.responseBody) ?? parseProviderPayload(candidate.data) ?? parseProviderPayload(candidate.cause);
  if (!payload) return undefined;

  const nested = payload.error && typeof payload.error === "object" ? (payload.error as { message?: unknown; type?: unknown }) : undefined;
  const message = typeof nested?.message === "string" ? nested.message : typeof payload.message === "string" ? payload.message : undefined;
  const type = typeof nested?.type === "string" ? nested.type : undefined;
  if (!message) return undefined;

  const base = type ? `${message}（${type}）` : message;
  const detail = envelopeDetail(payload.data);
  return detail && !detail.includes(message) && !base.includes(detail) ? `${base}：${detail}` : base;
}

function parseProviderPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.error || record.message) return record;
    // data 可能是嵌套的 ResData / 已包装结构
    if (record.data && typeof record.data === "object") return parseProviderPayload(record.data);
    return undefined;
  }
  if (typeof value !== "string") return undefined;

  const text = value.trim();
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parseProviderPayload(parsed);
  } catch {
    return undefined;
  }
}

/** 去掉 Electron IPC 包装前缀："Error invoking remote method 'ai:http-request': Error: xxx" */
function stripIpcWrapper(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

function readHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : undefined;
}

/**
 * 宿主接口失败时抛出的是错误信封对象（ResData / ResException）。
 *
 * 宿主全局异常过滤器把所有未捕获异常统一成
 * `{ message: "操作失败", title: exception.toString(), data: null }`——
 * 通用文案之外必须把 title（异常堆栈）或 data 里的真实原因带出来，
 * 否则用户只看到"操作失败"。
 */
export function describeHostEnvelope(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || payload instanceof Error) return undefined;

  const record = payload as { message?: unknown; title?: unknown; data?: unknown };
  const message = typeof record.message === "string" && record.message.trim() ? record.message.trim() : "";
  const rawTitle = typeof record.title === "string" ? record.title : "";
  const titleLooksLikeDump = rawTitle.includes("\n") || /(^|\W)Error\b|at\s+\S+:\d+/.test(rawTitle);
  const title = rawTitle.trim();

  const detail = envelopeDetail(record.data) || (titleLooksLikeDump ? firstLine(rawTitle) : "");
  const head = message || (titleLooksLikeDump ? "" : title);

  if (head && detail) return detail.includes(head) ? detail : `${head}：${detail}`;
  return head || detail || undefined;
}

/** 取信封 data 里的细节：可能是异常字符串，也可能是嵌套的 { message, data } */
function envelopeDetail(data: unknown): string {
  if (typeof data === "string") return firstLine(data);
  if (data && typeof data === "object") {
    const record = data as { message?: unknown; data?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return firstLine(record.message);
    if (record.data !== undefined) return envelopeDetail(record.data);
  }
  return "";
}

/** 异常文本常常带堆栈，只取第一行（错误本体），并去掉统一的 "Error: " 前缀 */
function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0].trim().replace(/^Error:\s*/, "");
}

/**
 * 把底层错误转成中文提示；无法识别的错误保留原文，便于定位。
 *
 * 供应商有明确报错信息时优先展示（并保留状态码语义），
 * 否则退回状态码/网络错误的中文提示。
 *
 * @param error 原始错误
 */
export function describeAiError(error: unknown): string {
  const providerMessage = readProviderMessage(error);
  const status = readHttpStatus(error);

  if (status !== undefined) {
    const hint = HTTP_STATUS_HINTS[status];
    if (hint) return providerMessage ? `${hint}：${providerMessage}` : hint;
    if (providerMessage) return `AI 服务返回错误（HTTP ${status}）：${providerMessage}`;
  } else if (providerMessage) {
    return providerMessage;
  }

  const envelopeMessage = describeHostEnvelope(error);
  if (envelopeMessage) return envelopeMessage;

  const raw = error instanceof Error ? error.message : String(error);
  const message = stripIpcWrapper(raw);
  return NETWORK_ERROR_HINTS.find(item => item.pattern.test(message))?.message ?? message;
}
