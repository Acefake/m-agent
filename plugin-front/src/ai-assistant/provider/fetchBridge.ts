import { nanoid } from "nanoid";
import { isTransportError } from "../ai-error";
import { abortAiRequest, beginAiRequest, pollAiRequest } from "./nodeProxy";
import "./polyfills";

/**
 * 创建供 AI SDK 使用的 fetch 实现。
 *
 * 请求经插件 Node 服务代理发出（Key 与网络都在 Node 侧，避免浏览器 CORS 与宿主日志泄露），
 * 响应体以流式分片回推，这里拼成 ReadableStream 交给 AI SDK，SSE 解析仍由 AI SDK 完成。
 *
 * @param apiKey 当前供应商配置里的 API Key；本地无鉴权端点可以不传
 * @param extraHeaders 供应商要求的额外请求头（如 OpenCode Go 的 x-opencode-session）
 */
export function createAiFetchBridge(apiKey?: string, extraHeaders?: Record<string, string>): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const requestId = nanoid();
    const signal = init?.signal ?? request.signal;
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? "" : await request.text();

    const createAbortError = () => new DOMException("请求已中断", "AbortError");
    const abort = () => void abortAiRequest(requestId);
    if (signal) {
      if (signal.aborted) {
        abort();
        throw createAbortError();
      }
      signal.addEventListener("abort", abort, { once: true });
    }

    let head;
    try {
      head = await beginAiRequest({ requestId, url: request.url, method, body, apiKey, extraHeaders });
    } catch (error) {
      signal?.removeEventListener("abort", abort);
      abort();
      if (signal?.aborted) throw createAbortError();
      // AI SDK 只把 fetch failed / 网络错误码视为可重试，普通 Error 会让整段输出丢失
      if (isTransportError(error)) throw new TypeError("fetch failed", { cause: error });
      throw error;
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        /** 中止时立即结束读取：不等 Node 侧最长 15 秒的长轮询返回 */
        const raceAbort = <T>(promise: Promise<T>): Promise<T> => {
          if (!signal) return promise;
          return Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              if (signal.aborted) reject(createAbortError());
              else signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
            })
          ]);
        };

        try {
          for (;;) {
            if (signal?.aborted) throw createAbortError();
            const result = await raceAbort(pollAiRequest(requestId));
            result.chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
            if (result.error) throw new Error(result.error);
            if (result.done) {
              controller.close();
              break;
            }
          }
        } catch (error) {
          controller.error(signal?.aborted ? createAbortError() : error);
          abort();
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
      cancel() {
        signal?.removeEventListener("abort", abort);
        abort();
      }
    });

    return new Response(stream, { status: head.status, statusText: head.statusText, headers: head.headers });
  };
}
