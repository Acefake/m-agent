import { createAiFetchBridge } from "./fetchBridge";
import { apiKeyOf, parseExtraHeaders } from "./nodeProxy";
import type { AiProviderProfile } from "../types";

/** 供应商模型列表里的一项 */
export interface AiModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
}

const modelCache = new Map<string, AiModelInfo[]>();
type ModelCatalog = Record<string, { models?: Record<string, { limit?: { context?: number } }> }>;
let catalogRequest: Promise<ModelCatalog> | undefined;
let catalogLoadedAt = 0;

function openCodeProvider(baseURL: string): string | undefined {
  const url = new URL(baseURL);
  if (url.protocol !== "https:" || url.hostname !== "opencode.ai" || url.port) return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/zen/go/v1") return "opencode-go";
  if (path === "/zen/v1") return "opencode";
  return undefined;
}

function validContext(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** 公共规格目录不携带供应商凭据；复用请求，失败后允许重试。 */
function loadModelCatalog(refresh: boolean): Promise<ModelCatalog> {
  if (!catalogRequest || (catalogLoadedAt && (refresh || Date.now() - catalogLoadedAt > 3600000))) {
    catalogLoadedAt = 0;
    catalogRequest = fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5000), credentials: "omit" })
      .then(async response => {
        if (!response.ok) throw new Error(`Models.dev HTTP ${response.status}`);
        const catalog = await response.json() as ModelCatalog;
        catalogLoadedAt = Date.now();
        return catalog;
      })
      .catch(error => {
        catalogRequest = undefined;
        throw error;
      });
  }
  return catalogRequest;
}

function getCacheKey(profile: AiProviderProfile): string {
  return `${profile.baseURL}|${profile.id}`;
}

function toModelInfo(item: { id?: unknown; name?: unknown; context_length?: unknown }): AiModelInfo | undefined {
  if (typeof item.id !== "string" || !item.id) return undefined;

  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name : undefined,
    contextLength: validContext(item.context_length) ? item.context_length : undefined
  };
}

/**
 * 获取供应商的可用模型列表（GET {baseURL}/models）。
 *
 * @param profile 供应商配置，决定地址与按需注入的 Key
 * @param options refresh 为 true 时跳过缓存
 */
export async function fetchProviderModels(profile: AiProviderProfile, options?: { refresh?: boolean }): Promise<AiModelInfo[]> {
  const cacheKey = getCacheKey(profile);
  const cached = modelCache.get(cacheKey);
  if (cached && !options?.refresh) return cached;

  const bridge = createAiFetchBridge(apiKeyOf(profile), parseExtraHeaders(profile.extraHeaders));
  const response = await bridge(`${profile.baseURL.replace(/\/+$/, "")}/models`);
  if (!response.ok) throw new Error(`获取模型列表失败（HTTP ${response.status}）`);

  const payload = (await response.json()) as { data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown }> };
  const models: AiModelInfo[] = [];

  for (const item of payload.data ?? []) {
    const info = toModelInfo(item);
    if (info) models.push(info);
  }

  if (!models.length) throw new Error("模型列表为空");

  const provider = openCodeProvider(profile.baseURL);
  let catalogFailed = false;
  if (provider && models.some(model => !model.contextLength)) {
    try {
      const catalog = await loadModelCatalog(Boolean(options?.refresh));
      for (const model of models) {
        const context = catalog[provider]?.models?.[model.id]?.limit?.context;
        if (!model.contextLength && validContext(context)) model.contextLength = context;
      }
    } catch (error) {
      catalogFailed = true;
      console.warn("模型规格目录暂不可用，保留供应商模型列表和手动配置", error);
    }
  }

  models.sort((left, right) => left.id.localeCompare(right.id));
  if (!catalogFailed) modelCache.set(cacheKey, models);
  return models;
}
