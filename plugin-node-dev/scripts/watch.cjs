"use strict";
/**
 * agent 插件 Node 侧开发监听。
 *
 * 做三件事：
 * 1. `tsc --watch -p tsconfig.dev.json`，输出到 plugin-front/.temp/buildNode；
 * 2. 监听输出目录变化，每次编译完成后防抖调用宿主 `/plugin/reloadPluginNodeModule`；
 * 3. 在终端打印宿主“插件管理”里需要填的 NodeDevFilePath。
 *
 * 宿主侧只需：插件管理 → agent → NodeDevFilePath =
 *   <plugin-front>/.temp/buildNode/main.js
 * 之后改 Node 代码保存即自动重载，不用再手动改动插件管理里的字段。
 *
 * 可用环境变量覆盖：
 * - AGENT_NODE_RELOAD_URL：重载接口地址（默认 http://127.0.0.1:8237/plugin/reloadPluginNodeModule）
 * - AGENT_NODE_RELOAD=off：只编译不自动重载
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ID = "agent";
const projectRoot = path.resolve(__dirname, "..");
const outDir = path.resolve(projectRoot, "../plugin-front/.temp/buildNode");
const reloadUrl = process.env.AGENT_NODE_RELOAD_URL || "http://127.0.0.1:8237/plugin/reloadPluginNodeModule";
const autoReload = process.env.AGENT_NODE_RELOAD !== "off";
const reloadUserId = process.env.AGENT_NODE_RELOAD_USER_ID || "0";

console.log(`[agent-node-watch] 插件 ID：${PLUGIN_ID}`);
console.log(`[agent-node-watch] 编译输出：${outDir}`);
console.log(`[agent-node-watch] 宿主 NodeDevFilePath 请填：${path.join(outDir, "main.js")}`);
console.log(autoReload ? `[agent-node-watch] 编译完成后自动重载：POST ${reloadUrl}` : "[agent-node-watch] 已按 AGENT_NODE_RELOAD=off 关闭自动重载");

// 1) tsc 监听编译（用依赖里的 typescript，避免 npx 的跨平台差异）
const tscBin = require.resolve("typescript/bin/tsc");
const tsc = spawn(process.execPath, [tscBin, "--watch", "-p", "tsconfig.dev.json"], {
  cwd: projectRoot,
  stdio: "inherit"
});
tsc.on("exit", code => {
  console.log(`[agent-node-watch] tsc 进程退出（code=${code}），监听结束`);
  process.exit(code ?? 0);
});

// 2) 输出目录变化 → 防抖重载
let reloadTimer;
let reloading = false;
let pendingReload = false;
let warningShown = false;

async function reloadNodeModule() {
  if (reloading) {
    pendingReload = true;
    return;
  }
  reloading = true;
  try {
    const response = await fetch(reloadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", userId: reloadUserId },
      body: JSON.stringify({ pluginId: PLUGIN_ID })
    });
    const payload = await response.text();
    const ok = response.ok && payload.includes("\"code\":1000");
    console.log(ok ? "[agent-node-watch] 已通知宿主重载 Node 模块" : `[agent-node-watch] 重载失败：HTTP ${response.status} ${payload.slice(0, 200)}`);
  } catch (error) {
    if (!warningShown) {
      warningShown = true;
      console.warn(`[agent-node-watch] 重载请求失败（${error.message}）：确认宿主 Node 服务在运行，且插件管理里 agent 的 NodeDevFilePath 指向本目录的 main.js`);
    }
  } finally {
    reloading = false;
    if (pendingReload) {
      pendingReload = false;
      void reloadNodeModule();
    }
  }
}

function scheduleReload() {
  if (!autoReload) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void reloadNodeModule(), 400);
}

// tsc 首次输出前目录可能还不存在：存在后再挂监听
function watchOutDir() {
  if (!fs.existsSync(outDir)) {
    setTimeout(watchOutDir, 1000);
    return;
  }
  fs.watch(outDir, { recursive: true }, (_event, filename) => {
    if (!filename || !String(filename).endsWith(".js")) return;
    scheduleReload();
  });
  console.log("[agent-node-watch] 已开始监听编译输出，保存即自动重载");
}

// 首轮编译完成前不重载：等目录出现后挂监听
watchOutDir();

process.on("SIGINT", () => {
  clearTimeout(reloadTimer);
  tsc.kill("SIGINT");
  process.exit(0);
});
