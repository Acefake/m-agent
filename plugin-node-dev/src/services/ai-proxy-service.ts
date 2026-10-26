import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import { ResData } from "../preload/host-api";
import type { RequestDto, BeginDto } from "../controllers/dto";

export interface RequestContext {
  headers: IncomingHttpHeaders;
}
interface Job {
  chunks: string[];
  bytes: number;
  done: boolean;
  touchedAt: number;
  error?: string;
  wake?: () => void;
  request?: ClientRequest;
}
const jobs = new Map<string, Job>();
let cleanupTimer: NodeJS.Timeout | undefined;

function jobKey(dto: RequestDto, request: RequestContext): string {
  const userId = request.headers.userid;
  if (typeof userId !== "string" || !userId) throw new Error("缺少用户上下文");
  // 渲染层的 requestId 来自 nanoid（URL 安全字符集，含下划线），校验需与之一致
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(dto.requestId)) throw new Error("无效请求标识");
  return userId + ":" + dto.requestId;
}

function stopJob(job: Job, reason: string): void {
  job.error = reason;
  job.done = true;
  job.request?.destroy(new Error(reason));
  job.wake?.();
}

/** 不允许渲染层覆盖的请求头：连接/长度/编码由 Node 自己管理，Host 由 URL 决定 */
const RESERVED_HEADER_NAMES = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "authorization"]);

/**
 * 过滤供应商额外请求头。
 *
 * 只保留合法 token 名称、单行值、受控数量与长度；reserved 名直接丢弃，
 * 避免渲染层借头注入改写连接语义或覆盖 Authorization。
 */
function sanitizeExtraHeaders(extraHeaders: BeginDto["extraHeaders"]): Record<string, string> {
  if (!extraHeaders || typeof extraHeaders !== "object") return {};

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (Object.keys(result).length >= 16) break;
    if (typeof value !== "string" || !value || value.length > 2048 || /[\r\n]/.test(value)) continue;
    const key = name.trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || RESERVED_HEADER_NAMES.has(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}

function validateRequest(dto: BeginDto, request: RequestContext) {
  const key = jobKey(dto, request);
  if (jobs.has(key)) throw new Error("请求标识重复");
  if (jobs.size >= 32) throw new Error("AI 请求过多，请稍后重试");
  const url = new URL(dto.url);
  const method = dto.method ?? "POST";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("仅支持 HTTP/HTTPS 的供应商接口");
  }
  const secret = request.headers["x-agent-api-key"];
  if (secret && (typeof secret !== "string" || secret.length > 4096 || /[\r\n]/.test(secret))) throw new Error("无效 API Key");
  const extraHeaders = sanitizeExtraHeaders(dto.extraHeaders);

  // GET 只用于拉取模型列表：GET {baseURL}/models
  if (method === "GET") {
    if (!url.pathname.endsWith("/models")) throw new Error("GET 仅支持模型列表接口 /models");
    if (dto.body) throw new Error("GET 请求不能带请求体");
    return { key, url, secret, method, extraHeaders };
  }

  if (!url.pathname.endsWith("/chat/completions")) {
    throw new Error("仅支持 HTTP/HTTPS 的 OpenAI 兼容 chat/completions 接口");
  }
  if (Buffer.byteLength(dto.body) > 2 * 1024 * 1024) throw new Error("AI 请求体过大");
  const body = JSON.parse(dto.body) as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
  };
  if (typeof body.model !== "string" || !Array.isArray(body.messages) || body.stream !== true) throw new Error("无效 AI 请求");
  return { key, url, secret, method, extraHeaders };
}

/** 发起供应商请求，分片按用户和请求 ID 隔离。 */
export function begin(dto: BeginDto, request: RequestContext) {
  const { key, url, secret, method, extraHeaders } = validateRequest(dto, request);
  const job: Job = { chunks: [], bytes: 0, done: false, touchedAt: Date.now() };
  jobs.set(key, job);
  return new Promise<
    InstanceType<
      typeof ResData<{
        requestId: string;
        status: number;
        statusText: string;
        headers: Record<string, string>;
      }>
    >
  >((resolve, reject) => {
    const headers: Record<string, string> = method === "GET" ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "text/event-stream" };
    if (secret) headers.Authorization = "Bearer " + secret;
    // 标识客户端身份：部分网关（如 OpenCode Go）要求非通用 SDK/HTTP 库的 UA（仅 ASCII）
    headers["User-Agent"] = "m-design-agent/0.2.0 (M-Design AI Assistant)";
    // 供应商要求的额外头（如 x-opencode-session）；reserved 名已在校验阶段剔除
    Object.assign(headers, extraHeaders);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(url, { method, headers }, response => {
      response.setEncoding("utf8");
      resolve(
        new ResData({
          requestId: dto.requestId,
          status: response.statusCode || 502,
          statusText: response.statusMessage || "",
          headers: {
            "content-type": String(response.headers["content-type"] || "application/json")
          }
        })
      );
      response.on("data", (chunk: string) => {
        job.bytes += Buffer.byteLength(chunk);
        if (job.bytes > 8 * 1024 * 1024) {
          stopJob(job, "AI 响应超过8MB上限");
          return;
        }
        job.chunks.push(chunk);
        job.wake?.();
      });
      response.on("end", () => {
        job.done = true;
        job.wake?.();
      });
      response.on("error", (error: Error) => stopJob(job, error.message));
      response.on("aborted", () => stopJob(job, "供应商连接中断"));
    });
    job.request = outgoing;
    outgoing.setTimeout(90000, () => stopJob(job, "供应商响应超时"));
    outgoing.on("error", error => {
      stopJob(job, error.message);
      reject(new Error(error.message));
    });
    outgoing.end(method === "GET" ? undefined : dto.body);
  });
}

/** 长轮询取走当前分片，已完成请求在读取后释放。 */
export async function poll(dto: RequestDto, request: RequestContext) {
  const key = jobKey(dto, request);
  const job = jobs.get(key);
  if (!job) throw new Error("AI 请求已结束或不存在");
  if (job.wake) throw new Error("同一请求不能并发读取");
  job.touchedAt = Date.now();
  if (!job.chunks.length && !job.done) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        job.wake = undefined;
        resolve();
      }, 15000);
      job.wake = () => {
        clearTimeout(timer);
        job.wake = undefined;
        resolve();
      };
    });
  }
  const result = {
    chunks: job.chunks.splice(0),
    done: job.done,
    error: job.error
  };
  if (job.done) jobs.delete(key);
  return new ResData(result);
}

export function abort(dto: RequestDto, request: RequestContext) {
  const key = jobKey(dto, request);
  const job = jobs.get(key);
  if (job) {
    stopJob(job, "已停止");
    jobs.delete(key);
  }
  return new ResData(true);
}

export function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    for (const [key, job] of jobs) {
      if (Date.now() - job.touchedAt > 120000) {
        stopJob(job, "请求已过期");
        jobs.delete(key);
      }
    }
  }, 30000);
  cleanupTimer.unref();
}

export function stopAll(): void {
  clearInterval(cleanupTimer);
  cleanupTimer = undefined;
  for (const job of jobs.values()) stopJob(job, "插件已停用");
  jobs.clear();
}
