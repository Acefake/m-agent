import { axios, isElectron } from "../../host/runtime";
import { describeHostEnvelope } from "../ai-error";
import type { AiProviderProfile } from "../types";

/**
 * 插件 Node 服务的 AI 代理接口。
 *
 * 请求由 Node 插件（/pluginApi/agent/assistant）发出，渲染层只传地址、请求体与临时 API Key：
 * - begin：发起一次供应商请求，返回响应头；
 * - poll：长轮询取走流式分片（Node 按 userId + requestId 隔离）；
 * - abort：中止进行中的请求。
 *
 * Key 只放在请求头，避免进入宿主 axios 拦截器的日志与错误提示。
 */
const endpoint = "/pluginApi/agent/assistant";

export interface AiRequestHead {
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface AiPollResult {
  chunks: string[];
  done: boolean;
  error?: string;
}

interface ResWrap<T> {
  code: number;
  data: T;
  message?: string;
  title?: string;
}

/** 组装代理请求头：桌面端 userId 固定 0（与宿主 ModelHttpClient 的规则一致） */
function proxyHeaders(apiKey?: string): Record<string, string> {
  const host = (window as Window & { app?: { global?: { user?: { id: string | number } } } }).app;
  const userId = isElectron ? "0" : String(host?.global?.user?.id ?? "");
  const headers: Record<string, string> = { userId };
  if (apiKey) headers["x-agent-api-key"] = apiKey;
  return headers;
}

/**
 * 读取接口返回；宿主原始 axios 下错误码藏在 ResData 里。
 *
 * 失败信封的 message 往往是通用文案（"操作失败"），真实异常在其 data 里，
 * 交给 describeHostEnvelope 拼出可定位的说明。
 */
function unwrap<T>(payload: ResWrap<T> | undefined, fallback: string): T {
  if (!payload) throw new Error(fallback);
  if (payload.code !== 1000) throw new Error(describeHostEnvelope(payload) || payload.message || fallback);
  return payload.data;
}

/** 传输层错误：优先读信封里的真实异常，其次 axios 的 message */
function describeTransportError(error: unknown, fallback: string): string {
  const detail = error as { response?: { data?: unknown }; message?: string };
  return describeHostEnvelope(detail?.response?.data) || detail?.message || fallback;
}

/**
 * 解析供应商配置里的「额外请求头」文本（按行 “名称: 值”）。
 *
 * 只保留形如 `Name: value` 的行；空行与 `#` 注释忽略；名称做 HTTP token 校验，
 * 值里出现换行直接丢弃（防止头注入）。没有任何合法行时返回 undefined。
 *
 * @param text 配置里的多行文本
 */
export function parseExtraHeaders(text?: string): Record<string, string> | undefined {
  if (!text?.trim()) return undefined;

  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;

    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || !value || /[\r\n]/.test(value)) continue;

    headers[name] = value;
  }

  return Object.keys(headers).length ? headers : undefined;
}

/**
 * 发起一次供应商请求。
 *
 * @param payload 请求地址、方法、请求体、临时 Key 与额外请求头
 */
export async function beginAiRequest(payload: {
  requestId: string;
  url: string;
  method: string;
  body: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}): Promise<AiRequestHead> {
  const { requestId, url, method, body, apiKey, extraHeaders } = payload;
  try {
    const response = await axios.post<ResWrap<AiRequestHead>>(
      `${endpoint}/begin`,
      { requestId, url, method, body, extraHeaders },
      { baseURL: modelBaseURL(), headers: proxyHeaders(apiKey) }
    );
    return unwrap(response.data, "AI 代理请求失败");
  } catch (error) {
    throw new Error(describeTransportError(error, "AI 代理连接失败"));
  }
}

/** 长轮询取走当前分片；Node 侧等待新分片或请求结束时返回 */
export async function pollAiRequest(requestId: string): Promise<AiPollResult> {
  try {
    const response = await axios.get<ResWrap<AiPollResult>>(`${endpoint}/poll`, {
      baseURL: modelBaseURL(),
      headers: proxyHeaders(),
      params: { requestId }
    });
    return unwrap(response.data, "AI 代理读取失败");
  } catch (error) {
    throw new Error(describeTransportError(error, "AI 代理读取失败"));
  }
}

/** 中止进行中的请求；请求已结束时静默 */
export async function abortAiRequest(requestId: string): Promise<void> {
  try {
    await axios.post<ResWrap<boolean>>(`${endpoint}/abort`, { requestId }, { baseURL: modelBaseURL(), headers: proxyHeaders() });
  } catch {
    // 中止失败不影响渲染层：请求可能已经结束
  }
}

function modelBaseURL(): string {
  return window.api.modelHttp.axios.defaults.baseURL;
}

/** 供应商配置读取临时 Key 的入口：面板把 Key 存在 profile 上 */
export function apiKeyOf(profile: AiProviderProfile): string | undefined {
  const key = profile.apiKey?.trim();
  return key ? key : undefined;
}
