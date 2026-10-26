# Agent 前端

负责“工具 → AI 建模助手”、模型树右键入口、聊天 UI、会话存储、AI SDK 工具循环和创建进度。
Vue 与弹窗能力来自宿主公开的 `window.api`，不打包第二份 Vue，也不依赖无法从公共源安装的私有 API 包。

`src/main.ts` 注册/注销插件；`src/assistant` 包含宿主适配、网络代理、工具和界面。
`.temp/buildNode` 是兄弟后端工程同步来的构建产物，不能在此维护业务源码。
构建/开发/安装方法与验证边界见 [插件说明](../README.md)。

- `pnpm start`：前端开发服务器，8889 端口。
- `pnpm typecheck`：Vue/TypeScript 检查。
- `pnpm test`：工具执行边界测试。
- `pnpm build`：生成 `dist/main.mjs`、`dist/main.css`。
- `pnpm build-dev`：构建前端并生成 `build/agent.zip`；先构建兄弟后端工程。

## 源码目录

- `src/main.ts`：插件安装、卸载与菜单、Action、面板、独立窗口注册。
- `src/actions/`：打开助手、添加模型节点到聊天的入口动作。
- `src/components/panels/aiAssistant/`：聊天面板、消息、会话侧栏、设置与专家过程展示；图标和 Markdown 渲染与界面就近维护。
- `src/components/modals/assistantWindow/`：独立窗口入口，连接原窗口会话后加载聊天面板。
- `src/ai-assistant/conversation/`：会话状态、历史、消息时间线、附件和当前上下文。
- `src/ai-assistant/runtime/`：普通 Agent、专家团、工具循环、上下文压缩和角色说明。
- `src/ai-assistant/changes/`：变更提案、计划、回滚与批次引用解析。
- `src/ai-assistant/provider/`：供应商配置、模型创建与列表、请求桥和 Node 代理调用。
- `src/ai-assistant/host.ts`、`types.ts`、`skills.ts`：现有宿主契约、共享类型与技能；`index.ts` 保留助手导出。
- `src/presentation/`：停靠/窗口偏好、会话镜像、跨窗口草稿与聊天引用队列。
- `src/host/`：M-Design 宿主适配、共享 Vue 运行时、初始化和卸载清理。

窗口呈现与会话执行分开：独立窗口只展示镜像并转发命令，原项目窗口负责 Agent 和模型写入。专家团复用普通 Agent 的执行路径；角色展示从 `runtime/expert-roles.ts` 读取，不导入团队调度实现。

目录迁移后仍保留开发与打包两种 Node 产物路径，详见上级插件说明。测试、模拟宿主预览和 Electron smoke 的入口路径需与源码同步维护。

## 自动记忆

在会话侧栏打开“记忆”，手动开启自动记忆，默认关闭。开启后，每轮主回复完成后使用该轮模型在后台整理长期偏好和项目约定，可能产生额外用量。只选择本轮用户正文中的原句，不从附件、引用资料、工具结果或助手回复学习。

数据保存在当前设备的浏览器或 Electron 用户数据分区内。真实账号按服务地址和用户 ID 隔离，没有可靠账号时显示“此设备配置”。用户偏好可用于该身份的新会话，项目约定只用于原项目。管理页支持查看来源、编辑、删除和按范围清空；人工编辑项不会被自动覆盖。关闭后停止提取和召回，保留已有内容。

先运行 `pnpm start`，或复用已在 8889 端口运行的插件 Vite。在本目录执行下列 PowerShell 命令，使用客户端已安装的 Electron 和全新的隔离目录验证确定性假供应商、真实 IndexedDB 与界面。不会请求真实模型或更改实际用户配置。

```powershell
$taskArtifacts = Join-Path $env:TEMP ("agent-memory-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $taskArtifacts | Out-Null
$env:AGENT_MEMORY_ARTIFACTS = $taskArtifacts
$env:AGENT_MEMORY_USER_DATA = Join-Path $taskArtifacts "user-data"
$taskElectron = "../../../m-design-client/node_modules/.pnpm/electron@22.3.27/node_modules/electron/dist/electron.exe"
$taskSmoke = Start-Process -FilePath $taskElectron -ArgumentList "tests/electron-memory-smoke.cjs" -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $taskArtifacts "stdout.log") -RedirectStandardError (Join-Path $taskArtifacts "stderr.log")
$taskSmoke.ExitCode
Get-Content (Join-Path $taskArtifacts "stdout.log")
```

成功时退出码为 0，目录内含结果 JSON 和宽、窄界面截图。保留同一个 `AGENT_MEMORY_USER_DATA`，设置 `$env:AGENT_MEMORY_VERIFY_RESTART = "1"` 后再次运行同一命令，可验证进程重开持久化；验证结束后移除这三个测试环境变量。此 smoke 使用模拟宿主，不代替真实生产宿主和供应商的端到端验收。
