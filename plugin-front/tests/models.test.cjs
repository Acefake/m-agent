const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

function fixture({ catalog, modelRows, failCatalog = false }) {
  const requests = [];
  let fail = failCatalog;
  const code = ts.transpileModule(fs.readFileSync(require.resolve("../src/ai-assistant/provider/models.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  const publicFetch = async (url, init) => {
    requests.push({ url, init, public: true });
    if (fail) { fail = false; throw new Error("offline"); }
    return Response.json(catalog);
  };
  const stubs = {
    "./fetchBridge": { createAiFetchBridge: (key, headers) => async url => {
      requests.push({ url, key, headers });
      return Response.json({ data: modelRows });
    } },
    "./nodeProxy": { apiKeyOf: () => "private-key", parseExtraHeaders: () => ({ "x-opencode-session": "private-session" }) }
  };
  new Function("require", "module", "exports", "fetch", "console", code)(name => stubs[name], mod, mod.exports, publicFetch, { warn() {} });
  return { fetchModels: mod.exports.fetchProviderModels, requests };
}

const profile = { id: "go", baseURL: "https://opencode.ai/zen/go/v1", model: "exact" };
test("OpenCode specs match provider and exact ID, preserving endpoint values and credential boundaries", async () => {
  const f = fixture({
    modelRows: [{ id: "exact" }, { id: "provided", context_length: 64000 }, { id: "exact-preview" }, { id: "invalid" }],
    catalog: {
      "opencode-go": { models: { exact: { limit: { context: 1000000 } }, provided: { limit: { context: 2000000 } }, invalid: { limit: { context: -1 } } } },
      opencode: { models: { exact: { limit: { context: 128000 } } } }
    }
  });
  const models = await f.fetchModels(profile);
  assert.equal(models.find(m => m.id === "exact").contextLength, 1000000);
  assert.equal(models.find(m => m.id === "provided").contextLength, 64000);
  assert.equal(models.find(m => m.id === "exact-preview").contextLength, undefined);
  assert.equal(models.find(m => m.id === "invalid").contextLength, undefined);
  const publicRequest = f.requests.find(r => r.public);
  assert.equal(publicRequest.init.credentials, "omit");
  assert.equal(publicRequest.init.headers, undefined);
  assert.equal(publicRequest.key, undefined);
  await f.fetchModels({ ...profile, id: "zen", baseURL: "https://opencode.ai/zen/v1" });
  assert.equal(f.requests.filter(r => r.public).length, 1);
});

test("catalog failure preserves model listing and retries on next load", async () => {
  const f = fixture({ modelRows: [{ id: "exact" }], catalog: { "opencode-go": { models: { exact: { limit: { context: 1000000 } } } } }, failCatalog: true });
  assert.equal((await f.fetchModels(profile))[0].contextLength, undefined);
  assert.equal((await f.fetchModels(profile))[0].contextLength, 1000000);
});

test("custom endpoints never use OpenCode specifications", async () => {
  const f = fixture({ modelRows: [{ id: "exact" }], catalog: {} });
  await f.fetchModels({ ...profile, baseURL: "https://opencode.ai.example.com/zen/go/v1" });
  assert.equal(f.requests.some(r => r.public), false);
});
