# m-agent

M-Design 的 AI 建模助手插件，基于 Vue 3、TypeScript 和 Vercel AI SDK。

## 功能

- 查询模型、属性、关系和图表，辅助创建元素、图形、连线与布局。
- 支持聊天（只读）、提案（确认后执行）、编辑（直接执行）三种模式。
- 支持多供应商配置、技能、附件、专家协作和本机记忆。
- 支持多步任务续跑、停止，以及可回滚操作的撤销。

## 使用

1. 在 M-Design 插件管理中安装并启用 `agent.zip`。
2. 从 **工具 → AI 建模助手** 打开面板。
3. 配置接口地址、模型和 API Key，选择模式后输入需求。

对话、相关模型数据和附件会发送到你配置的模型供应商。删除元素不支持回滚。

## 开发与打包

环境：Node.js 20.20.2、pnpm 10.19.0。需要配合 M-Design 宿主运行。

```powershell
# 构建后端
cd plugin-node-dev
pnpm install
pnpm build

# 构建前端并打包
cd ../plugin-front
pnpm install
pnpm build-dev
```

安装包：`plugin-front/build/agent.zip`。

开发时，在两个工程目录分别运行 `pnpm start`；前端地址为 `http://127.0.0.1:8889`，需在宿主开发者模式中配置。

在各自目录运行 `pnpm typecheck` 和 `pnpm test` 进行检查。

## 目录

- [plugin-front](plugin-front/README.md)：助手界面、Agent 运行逻辑和宿主适配。
- [plugin-node-dev](plugin-node-dev/README.md)：AI 请求代理和后端接口。
