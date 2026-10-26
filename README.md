# Agent：AI 建模助手

插件目录与 UAF-TO-SYSML 同级，前后端分别维护：

- `plugin-front`：右侧 AI 助手面板（会话、供应商/技能设置、附件、提案与回滚）、宿主适配层和插件描述。
- `plugin-node-dev`：Controller、DTO 和 AI 请求代理（含模型列表）。

前端源码按会话、运行、变更和供应商分组；窗口呈现与宿主适配分别维护。目录职责见 [前端源码说明](plugin-front/README.md#源码目录)。

入口为 **工具 → AI 建模助手**，模型树右键菜单 **AI 建模助手** 同样打开；面板常驻右侧页签，再点一次即收起。
面板移植自 `jinhang/agent` 的 ai-assistant 包：保留会话历史、供应商设置（多配置与模型列表）、技能、附件（文本/图片）、
工具过程展示、聊天/提案/编辑三种权限模式、选择卡片、分步计划、提案确认与一键回滚。

## 功能与宿主对接

- **只读能力**：模型树（懒加载并按需展开路径）、元素搜索、元素/子元素/关系/属性读取、元素提及（弹模型树多选）、
  图表列表、图形树读取、组件区清单读取。
- **图表创建**：同时查询普通元素菜单与图表菜单，使用 `create-element` 创建 BDD 等宿主允许的图表，并请求宿主自动打开。
- **写能力**：在用户确认提案（或编辑模式直接执行）后调用宿主真实接口：
  创建元素（`modelService.addModel`，类型逐字取自 `modelService.getCanCreateChildTypes`）、
  改属性（`modelService.getModelProperties` 取 key 与旧值 → `updateModelProperty`，提交后回读校验）、
  删除元素（`removeModel`）、画布创建图形（`siderBarItemDrop`）、连线（`isValidConnectSource/Target` + `connectShape`）、
  摆放已有元素（`treeDropShape`）、整理位置（`moveShape`）。
- **回滚**：创建元素/图形/连线写入 `delete-element` / `delete-shape` 逆操作，属性修改写回旧值，整理位置记录原坐标；
  没有逆操作的操作（删除元素）在界面上明确标注不可回滚。
- **SysML 文本**：M-Design 没有文本模型与文本语言服务，文本类工具不下发（`host.features.sysmlText=false`），
  `replace-sysml-text` 会返回明确不可用说明，不做空实现。
- **对话数据**：会话与设置按项目隔离，存在宿主 `storage`（桌面端落用户数据目录、Web 端落 localStorage）。
  对话内容、模型结构与附件会发送到所配置的供应商；首次向某供应商发送前有确认提示。

## 开发与打包

使用 Node 20.20.2、pnpm 10.19.0。在各自工程目录执行：

```powershell
cd plugin-node-dev
pnpm install
pnpm typecheck
pnpm test
pnpm build

cd ../plugin-front
pnpm install
pnpm typecheck
pnpm test
pnpm build-dev
```

后端构建到 `plugin-node-dev/dist`，并同步至前端 `.temp/buildNode`。
前端打包读取后端 `dist`；应先构建后端，再打包前端。
安装包位于 `plugin-front/build/agent.zip`，包含 `plugin.json`、`resource/main.mjs`、`resource/main.css` 和 `node/main.js` 及其模块。
在 M-Design 插件管理中安装该 ZIP，启用后从“工具”打开。

前端开发：

```powershell
cd plugin-front
pnpm start
```

开发地址为 `http://127.0.0.1:8889`；在宿主开发者模式中为插件 ID `agent` 配置此地址后，改前端代码保存即生效
（Vite HMR；组件/样式随模块自动加载）。

后端开发：

```powershell
cd plugin-node-dev
pnpm start        # tsc 监听 + 编译完成自动重载
pnpm start-tsc    # 只监听编译，不自动重载
```

`pnpm start` 输出到前端 `.temp/buildNode`，每次编译完成后自动调用宿主
`POST /plugin/reloadPluginNodeModule`（`AGENT_NODE_RELOAD=off` 可关闭，`AGENT_NODE_RELOAD_URL` 可改地址）。
宿主侧只需在插件管理里把 agent 的 NodeDevFilePath 配成：

```text
<repo>/plugin/agent/plugin-front/.temp/buildNode/main.js
```

之后改 Node 代码保存即自动重载；不配该字段时，重载会回退到已安装 ZIP 里的 Node 模块。

VSCode 工作区任务（`m-design-client.code-workspace`）已按插件分类，按需启动：

| 任务 | 作用 |
| --- | --- |
| 启动插件 · agent 前端 (8889) | 只起 agent 前端 dev server |
| 启动插件 · agent Node | 只起 agent Node 监听（自动重载） |
| 启动插件 · agent（前端 + Node） | 单插件整套 |
| 启动插件 · UAF 前端 (8888) / UAF Node / UAF 模板（前端 + Node） | UAF 模板按需启动 |
| 启动插件 · 全部前端 / 全部 Node | 按前后端起全部插件 |
| 启动插件 · 全部 | 一次起全部插件 |
| 启动全部开发服务 | Client + Node 服务 + Java 模型服务 + 全部插件 |
| 打包插件 · agent zip | 顺序执行下面两个构建，产出 `plugin-front/build/agent.zip` |
| 构建插件 · agent Node / 构建插件 · agent 前端 | 单独构建 |

## 使用

1. 打开项目，从“工具 → AI 建模助手”打开右侧面板。
2. 首次使用先在设置里配置供应商：接口地址、模型、API Key（本地无鉴权端点可不填）；
   部分网关还要求附加请求头（如 OpenCode Go 的 `x-opencode-session`），在设置里的「额外请求头」按行填写，
   新建 OpenCode Go 配置时会自动生成一份会话 ID。供应商报错会连同原始错误信息一起显示，便于定位。
3. 选择权限模式：聊天（只读）/ 提案（确认后执行，默认）/ 编辑（直接执行）。
4. 切换模型：输入区上方的模型 chip 打开选择器——左侧机架按服务分栏（收藏 / 每个供应商），
   右侧平铺模型列表（每行标明所属服务与上下文长度）。行右侧星标可收藏；收藏进机架首项「收藏」，
   打开选择器时 `Ctrl+1–9` 直接切到第 N 个收藏。模型切换同时切换供应商。
5. 输入问题或需求；输入 `@` 可插入模型元素引用，输入 `/技能名` 单轮启用技能。
6. 提案卡片上有「确认并执行」与回滚入口；执行失败会带失败原因自动让模型修正一次。

API Key 随插件设置保存在本机；请求由插件 Node 服务代理发送，Key 只在请求头传输。
Node 宿主现有日志会打印插件请求体，因此不要在对话中输入密钥。
写操作前会校验项目/元素可写性，且所有创建参数仍由后端再次校验。

## 多步执行与停止

- 每 8 轮模型请求自动分段续跑，完整保留工具调用、结果和真实元素 ID；会话历史也保留这些上下文。
- 上下文管理分两层：旧只读结果先缩减（去重、属性目录化）；整个会话超出模型窗口 70% 的请求预算时，较早轮次折叠成摘要（保留目标、结论、真实 ID 与执行收据），近期消息保持原文。压缩只作用于发给模型的请求，不写回会话历史。
- 会话消息超过本地上限（40 条）被截断时，旧消息折成持久化摘要并注入后续请求，早期目标与真实 ID 不因截断丢失；摘要里的属性旧值等细节在改动前必须重新读取。
- 选择追问、提案和计划正常等待用户；网络异常、输出截断、主动停止及执行预算耗尽会明确显示状态，不再当作完成。
- 连续三轮相同调用且结果不变时暂停，防止空转。
- 编辑模式的写操作串行执行；重复提交同一批改动（包括 A、B、A 交替）命中成功收据时不再写入。
- 停止后等待在途宿主操作返回收据，再结束本轮；批次后续操作不会启动。已成功的改动不会因为停止而回退。
- 属性更新以宿主的 `propertyKey` 定位，`propertyName` 只作展示；空字符串 `oldValue` 合法。

## 验证范围

- 前端测试（`node --test tests/*.test.cjs`）：
  - `agent-loop`：真实 AI SDK + 模拟 SSE 供应商，验证超过 8 轮续跑、工具结果保留、确认暂停、重复写入防护、预算与取消收据，以及超预算时早期轮次折叠为摘要。
  - `session-compaction`：预算内原样返回、超预算折叠摘要、任意预算切点下工具调用与结果配对、收据与失败优先保留、图片估算不随 base64 增长。
  - `history-digest`：截断摘要提取用户原文、收据与提案状态，合并超长时保留最近内容。
  - `fetch-bridge`：流式分片、GET 模型列表、中止语义、分片错误。
  - `host-adapter`：类型编码与读取渲染、创建元素与回滚、类型校验拒绝、属性读写与回滚、只读属性拒绝、
    摆放图形与“只移除图形”的回滚、文本能力明确不可用。
  - `plugin-install`：面板注册（comps/value/compsName）、菜单与 Action 注册、入口动作开关、停用清理。
- 前端模拟宿主页面：`tests/ui/preview.html` 用假宿主与假供应商渲染面板，启动前端后访问
  `http://127.0.0.1:8889/tests/ui/preview.html` 可查看页面与交互（不请求真实供应商、不改真实模型）。
- 消息状态页面：`tests/ui/message-states.html` 单独挂载 `MessageItem`，覆盖过程轨道（完成/流式）、
  变更提案、分步计划与用户选择卡片等状态，用于 UI 调整后的快速目检。
- 后端测试：真实 Nest 装饰器与 DTO 元数据、宿主事务调用、创建主模型选择、类型校验、重复节点、
  Java 错误传播、SSE、GET 模型列表、用户隔离、取消与卸载。
- 已通过类型检查、前后端构建与自动化测试。
- `node tests/live-canvas-smoke.cjs <projectId> <ownerId>`：手动运行真实后端回归，创建隔离测试包，验证 BDD 创建、
  组件创建、已有模型上图、组合连线、普通/关系布局和移除图形回滚，最后清理本脚本创建的测试包。
  该脚本不属于默认单元测试，不应在不知情的项目上自动运行。
- 已在运行中的 Node + Java 服务上完成上述真实接口回归；脚本模拟前端宿主对象，
  Electron 图表自动打开的可见效果与真实供应商完整对话不属于该脚本的验证范围。

仅新增/修改本插件目录，未修改主程序或 UAF-TO-SYSML。
