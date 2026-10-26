const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function loadMemory(file = "index", overrides = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/ai-assistant/memory", `${file}.ts`), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(
    name => {
      if (name in overrides) return overrides[name];
      if (name === "./index") return loadMemory();
      throw new Error(`未声明依赖 ${name}`);
    },
    mod,
    mod.exports
  );
  return mod.exports;
}

module.exports = { loadMemory };
