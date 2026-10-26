"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");

/**
 * 供应商配置与传输细节测试：
 * - 额外请求头文本解析（合法行保留、非法/注入/保留头场景在 Node 侧再兜底）；
 * - 预设里的会话占位替换（OpenCode Go 需要 x-opencode-session）；
 * - describeAiError 优先展示供应商真实报错（如 MissingSessionID）。
 */

function transpileSource(relativePath) {
  const source = fs.readFileSync(require.resolve(relativePath), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}

function load(relativePath, stubs = {}) {
  const code = transpileSource(relativePath);
  const module = { exports: {} };
  vm.runInNewContext(code, {
    exports: module.exports,
    module,
    require: name => (name in stubs ? stubs[name] : require(name)),
    console,
    Error,
    TypeError,
    JSON,
    Object,
    RegExp,
    String
  });
  return module.exports;
}

test("额外请求头解析：保留合法行，丢弃注释、非法名与换行注入", () => {
  const { parseExtraHeaders } = load("../src/ai-assistant/provider/nodeProxy.ts", {
    "../../host/runtime": { axios: {}, isElectron: false },
    "../ai-error": { describeHostEnvelope: () => undefined }
  });

  assert.equal(parseExtraHeaders(""), undefined);
  assert.equal(parseExtraHeaders("   \n# 只有注释\n"), undefined);

  const parsed = parseExtraHeaders(
    [
      "# 会话头",
      "x-opencode-session: mdesign-abc123",
      "X-CUSTOM:  value with spaces ",
      "",
      "bad name: x",
      "no-colon",
      "x-inject: line\r\nbreak"
    ].join("\n")
  );
  assert.equal(parsed["x-opencode-session"], "mdesign-abc123");
  assert.equal(parsed["X-CUSTOM"], "value with spaces");
  assert.equal(parsed["bad name"], undefined);
  // 按行解析天然保证任何头值都不含换行：注入的 CRLF 被拆行，最多留下无害残片
  Object.values(parsed).forEach(value => assert.ok(!/[\r\n]/.test(value)));
});

test("OpenCode Go 预设携带会话占位，创建配置时生成会话 ID", () => {
  const { AI_PROVIDER_PRESETS, createProfileFromPreset, resolvePresetHeaders } = load("../src/ai-assistant/provider/providerConfig.ts", {
    "../host": { tryGetAiAssistantHost: () => undefined }
  });

  const preset = AI_PROVIDER_PRESETS.find(item => item.name === "OpenCode Go");
  assert.ok(preset, "应存在 OpenCode Go 预设");
  assert.match(preset.extraHeaders, /x-opencode-session/);
  assert.match(preset.extraHeaders, /\$\{session\}/);

  const profile = createProfileFromPreset(preset);
  assert.match(profile.extraHeaders, /^x-opencode-session: mdesign-[A-Za-z0-9_-]+$/);
  assert.ok(!profile.extraHeaders.includes("${session}"));

  // 切换预设时同样会生成一份新的会话 ID
  assert.match(resolvePresetHeaders(preset), /^x-opencode-session: mdesign-/);
  assert.equal(resolvePresetHeaders({ name: "x", baseURL: "", model: "" }), undefined);
});

test("模型收藏：键用 :: 分隔保留模型 id，槽位顺序即 Ctrl+N，取消后前移", () => {
  const { favoriteModelKey, parseFavoriteModelKey, toggleFavoriteModelKey } = load("../src/ai-assistant/provider/providerConfig.ts", {
    "../host": { tryGetAiAssistantHost: () => undefined }
  });
  const flat = keys => keys.join("|");

  // modelId 自身含 "/"：分隔符必须是 "::"，解析后模型 id 原样保留
  const key = favoriteModelKey("p1", "deepseek/deepseek-v4-flash");
  assert.equal(key, "p1::deepseek/deepseek-v4-flash");

  const parsed = parseFavoriteModelKey(key);
  assert.equal(parsed.profileId, "p1");
  assert.equal(parsed.modelId, "deepseek/deepseek-v4-flash");
  // 缺分隔符或分隔符在开头都视为非法
  assert.equal(parseFavoriteModelKey("no-separator"), undefined);
  assert.equal(parseFavoriteModelKey("::only-model"), undefined);

  // 新收藏追加到末尾（槽位号即数组序号）；再点一次取消；取消后其余槽位前移
  const two = toggleFavoriteModelKey(toggleFavoriteModelKey(undefined, "p1::a"), "p2::b");
  assert.equal(flat(two), "p1::a|p2::b");
  assert.equal(flat(toggleFavoriteModelKey(two, "p1::a")), "p2::b");
  assert.equal(flat(toggleFavoriteModelKey(two, "p3::c")), "p1::a|p2::b|p3::c");
  // 纯函数：不改动入参
  assert.equal(flat(two), "p1::a|p2::b");
});

test("内置建模和技能创建指引：加载时自动补齐并刷新，builtin 标记声明不可删除", () => {
  const { AI_SKILL_PRESETS, ensureBuiltinSkills, loadAiProviderSettings } = load("../src/ai-assistant/provider/providerConfig.ts", {
    "../host": { tryGetAiAssistantHost: () => undefined }
  });

  // 预设列表只保留最新的内置技能
  assert.equal(AI_SKILL_PRESETS.length, 4);
  assert.equal(AI_SKILL_PRESETS[2].name, "expert-manager");
  assert.equal(AI_SKILL_PRESETS[2].enabled, false);
  assert.equal(AI_SKILL_PRESETS[1].name, "skill-creator");
  assert.equal(AI_SKILL_PRESETS[1].enabled, false);
  const preset = AI_SKILL_PRESETS[0];
  assert.equal(preset.name, "sysml-modeling");
  assert.equal(preset.enabled, true);
  assert.equal(preset.builtin, true);
  assert.ok(preset.content.length > 0);

  // 未配置时默认设置内置该技能
  const settings = loadAiProviderSettings();
  const skill = (settings.skills ?? []).find(item => item.builtin);
  assert.ok(skill, "默认设置应内置建模技能");
  assert.equal(skill.name, "sysml-modeling");
  assert.equal(skill.enabled, true);

  // 存量设置缺失内置技能时补齐；用户自建技能不受影响
  const profile = { id: "p1", name: "x", baseURL: "", model: "" };
  const mine = { id: "mine", name: "mine", description: "", content: "x", enabled: false };
  const filled = ensureBuiltinSkills({ activeProfileId: "p1", profiles: [profile], skills: [mine] });
  assert.equal(filled.skills.length, 5);
  assert.ok(filled.skills.some(item => item.builtin));
  assert.equal(filled.skills.find(item => item.id === "mine").enabled, false);

  // 旧版本内置技能刷新为最新内容，用户的启用开关保留
  const stale = ensureBuiltinSkills({
    activeProfileId: "p1",
    profiles: [profile],
    skills: [{ id: "builtin-sysml-modeling", name: "sysml-modeling", description: "旧", content: "旧正文", enabled: false }]
  });
  const refreshed = stale.skills.find(item => item.builtin);
  assert.notEqual(refreshed.content, "旧正文");
  assert.equal(refreshed.enabled, false);

  // 已是最新时返回原对象，避免无谓重建
  const stable = ensureBuiltinSkills(filled);
  assert.equal(stable, filled);
});

test("记忆协作内置技能默认启用，升级保留停用选择且可随请求加载", () => {
  const { ensureBuiltinSkills } = load("../src/ai-assistant/provider/providerConfig.ts", {
    "../host": { tryGetAiAssistantHost: () => undefined }
  });
  const { resolveActiveSkills } = load("../src/ai-assistant/skills.ts");
  const settings = ensureBuiltinSkills({ profiles: [], activeProfileId: "" });
  const memory = settings.skills.find(skill => skill.name === "memory-cooperation");
  assert.ok(memory.builtin);
  assert.equal(memory.enabled, true);
  assert.ok(resolveActiveSkills(settings.skills).some(skill => skill.id === memory.id));
  memory.enabled = false;
  memory.content = "旧版本";
  const updated = ensureBuiltinSkills(settings);
  const refreshed = updated.skills.find(skill => skill.id === memory.id);
  assert.equal(refreshed.enabled, false);
  assert.notEqual(refreshed.content, "旧版本");
  assert.ok(!resolveActiveSkills(updated.skills).some(skill => skill.id === memory.id));
  assert.ok(resolveActiveSkills(updated.skills, ["memory-cooperation"]).some(skill => skill.id === memory.id));
});

test("已下线的旧预设副本在加载设置时被清理，改过的副本保留", () => {
  const { RETIRED_PRESET_SKILLS, ensureBuiltinSkills, pruneLegacyPresetSkills } = load("../src/ai-assistant/provider/providerConfig.ts", {
    "../host": { tryGetAiAssistantHost: () => undefined }
  });

  assert.equal(RETIRED_PRESET_SKILLS.length, 4);
  const profile = { id: "p1", name: "x", baseURL: "", model: "" };
  const retired = RETIRED_PRESET_SKILLS[0];
  const legacyCopy = { id: "legacy", name: retired.name, description: "旧预设", content: retired.content, enabled: true };
  const customized = { id: "custom", name: RETIRED_PRESET_SKILLS[1].name, description: "改过", content: "改过的正文", enabled: false };
  const mine = { id: "mine", name: "mine", description: "", content: "x", enabled: true };
  const settings = { activeProfileId: "p1", profiles: [profile], skills: [legacyCopy, customized, mine] };

  const pruned = pruneLegacyPresetSkills(settings);
  assert.equal(pruned.skills.length, 2);
  assert.ok(!pruned.skills.some(item => item.id === "legacy"), "未改动的旧副本应被删除");
  assert.ok(
    pruned.skills.some(item => item.id === "custom"),
    "改过正文的同名技能应保留"
  );
  assert.ok(pruned.skills.some(item => item.id === "mine"));

  // 先补内置再清理：内置技能不受影响
  const chained = pruneLegacyPresetSkills(ensureBuiltinSkills(settings));
  assert.equal(chained.skills.length, 6);
  assert.ok(chained.skills.some(item => item.builtin));

  // 清空后按持久化约定移除 skills 字段；无命中时返回原对象
  assert.equal(pruneLegacyPresetSkills({ activeProfileId: "p1", profiles: [profile], skills: [legacyCopy] }).skills, undefined);
  assert.equal(pruneLegacyPresetSkills(pruned), pruned);
});

test("describeAiError 展示供应商真实报错并保留状态码提示", () => {
  const { describeAiError } = load("../src/ai-assistant/ai-error.ts");

  const missingSession = {
    statusCode: 400,
    responseBody: JSON.stringify({
      type: "error",
      error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed efficiently." }
    })
  };
  const text = describeAiError(missingSession);
  assert.match(text, /400/);
  assert.match(text, /x-opencode-session/);
  assert.match(text, /MissingSessionID/);

  // 非 400 的状态码也带上供应商信息
  assert.match(describeAiError({ statusCode: 429, data: { error: { message: "rate limited" } } }), /rate limited/);

  // 无法识别的错误保留原文；网络错误给中文提示
  assert.equal(describeAiError(new Error("ECONNREFUSED 127.0.0.1:1")), "AI 服务拒绝连接，请确认供应商接口地址与端口");
  assert.equal(describeAiError({ responseBody: "not-json" }).includes("not-json"), false);

  // 宿主接口失败抛出的是 ResData 信封对象（非 Error）：取信封里的 message 而不是 [object Object]
  assert.equal(describeAiError({ code: 5005, message: "操作失败", title: "", data: null }), "操作失败");
  // 信封 data 里带更具体的报错时优先展示
  assert.equal(describeAiError({ code: 5005, message: "操作失败", data: { message: "名称已存在" } }), "名称已存在");
  // 没有 message 时退回 title
  assert.equal(describeAiError({ code: 5005, title: "保存失败" }), "保存失败");

  // 宿主全局异常过滤器的信封：异常堆栈放在 title 里，带出第一行（真实异常）
  assert.equal(
    describeAiError({
      code: 5005,
      message: "操作失败",
      title: "Error: connect ECONNREFUSED 127.0.0.1:443\n    at TCPConnectWrap.afterConnect",
      data: null
    }),
    "操作失败：connect ECONNREFUSED 127.0.0.1:443"
  );
  // 细节也可能放在 data 里
  assert.equal(
    describeAiError({
      code: 5005,
      message: "操作失败",
      data: "Error: connect ECONNREFUSED 127.0.0.1:443\n    at TCPConnectWrap.afterConnect"
    }),
    "操作失败：connect ECONNREFUSED 127.0.0.1:443"
  );
  // AI SDK 把响应体放在 responseBody（JSON 字符串）时同样带出 data 细节
  assert.equal(
    describeAiError({
      statusCode: 500,
      responseBody: JSON.stringify({ code: 5005, message: "操作失败", data: "Error: 供应商响应超时\n at Socket" })
    }),
    "AI 服务内部错误（500），请稍后重试：操作失败：供应商响应超时"
  );
});

test("桥接层把额外请求头透传给 Node 代理", async () => {
  const aiErrorSource = fs.readFileSync(require.resolve("../src/ai-assistant/ai-error.ts"), "utf8");
  const aiErrorCode = ts.transpileModule(aiErrorSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const aiErrorModule = { exports: {} };
  vm.runInNewContext(aiErrorCode, { exports: aiErrorModule.exports, module: aiErrorModule, console, Error, RegExp, Set });
  const aiError = aiErrorModule.exports;

  const source = fs.readFileSync(require.resolve("../src/ai-assistant/provider/fetchBridge.ts"), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;

  let beginPayload;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    exports: module.exports,
    module,
    require: name => {
      if (name === "./nodeProxy") {
        return {
          beginAiRequest: async payload => {
            beginPayload = payload;
            return { requestId: payload.requestId, status: 200, statusText: "OK", headers: {} };
          },
          pollAiRequest: async () => ({ chunks: ["data: [DONE]\n\n"], done: true }),
          abortAiRequest: async () => undefined
        };
      }
      if (name === "./polyfills") return {};
      if (name === "../ai-error") return aiError;
      return require(name);
    },
    console,
    Error,
    DOMException,
    TextEncoder,
    Request,
    Response,
    ReadableStream,
    setTimeout,
    clearTimeout
  });

  const fetchImpl = module.exports.createAiFetchBridge("key-1", { "x-opencode-session": "session-1" });
  const response = await fetchImpl("https://example.test/v1/chat/completions", { method: "POST", body: "{}" });
  assert.deepEqual(beginPayload.extraHeaders, { "x-opencode-session": "session-1" });
  assert.equal(beginPayload.apiKey, "key-1");
  assert.equal(await response.text(), "data: [DONE]\n\n");
});
