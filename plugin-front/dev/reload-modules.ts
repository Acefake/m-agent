import type { Plugin } from "vite";
import ts from "typescript";
import { resolve } from "node:path";

/** 宿主仅刷新 main.ts 的时间戳，开发模式下需让本地依赖共享新的模块版本。 */
export function reloadPluginModules(root: string): Plugin {
  const sourceRoot = resolve(root, "src").replace(/\\/g, "/") + "/";
  let revision = Date.now().toString(36);
  let sequence = 0;
  return {
    name: "agent-dev-reload-modules",
    apply: "serve",
    enforce: "post",
    transformIndexHtml() {
      return [{ tag: "script", children: "window.__AGENT_DEV_REVISION__=" + JSON.stringify(revision), injectTo: "head" }];
    },
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/src/main.ts" && url.searchParams.has("t")) {
          revision = Date.now().toString(36) + (++sequence).toString(36);
          server.moduleGraph.invalidateAll();
        }
        next();
      });
    },
    transform(code, id) {
      const normalized = id.replace(/\\/g, "/");
      if (!normalized.startsWith(sourceRoot)) return;
      const query = id.includes("?") ? id.slice(id.indexOf("?") + 1) : "";
      const version = new URLSearchParams(query).get("agentRevision") ?? revision;
      const source = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const replacements: { from: number; to: number; value: string }[] = [];
      const revise = (literal: ts.Expression | undefined) => {
        if (!literal || !ts.isStringLiteral(literal)) return;
        const value = literal.text;
        if (!(value.startsWith("./") || value.startsWith("../") || value.startsWith("/src/") || value.startsWith(sourceRoot))) return;
        if (/[?&]agentRevision=/.test(value)) return;
        replacements.push({
          from: literal.getStart(source) + 1,
          to: literal.end - 1,
          value: value.includes("?") ? value.replace("?", "?agentRevision=" + version + "&") : value + "?agentRevision=" + version
        });
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) revise(node.moduleSpecifier);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) revise(node.arguments[0]);
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!replacements.length) return;
      let revised = code;
      for (const replacement of replacements.sort((a, b) => b.from - a.from)) {
        revised = revised.slice(0, replacement.from) + replacement.value + revised.slice(replacement.to);
      }
      return { code: revised, map: null };
    }
  };
}
