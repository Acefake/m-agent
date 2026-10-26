import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { createAiFetchBridge } from "./fetchBridge";
import { apiKeyOf, parseExtraHeaders } from "./nodeProxy";
import "./polyfills";
import type { AiProviderProfile } from "../types";

/**
 * 依据供应商配置创建 AI SDK 语言模型。
 *
 * LLM 请求统一经插件 Node 服务代理发送，API Key 与配置里的额外请求头
 * （如网关要求的会话头）随请求传给代理；未配置密钥时不注入，本地端点可直接使用。
 *
 * @param profile 供应商配置
 */
export function createAiLanguageModel(profile: AiProviderProfile): LanguageModel {
  const provider = createOpenAICompatible({
    name: "ai-assistant",
    baseURL: profile.baseURL,
    apiKey: "managed-by-node-proxy",
    includeUsage: true,
    fetch: createAiFetchBridge(apiKeyOf(profile), parseExtraHeaders(profile.extraHeaders))
  });

  return provider(profile.model);
}
