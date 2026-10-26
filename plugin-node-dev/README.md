# Agent Node 插件

- `src/controllers/AgentController.ts`：注册插件接口；Controller 无请求级实例状态。
- `src/controllers/dto.ts`：运行时请求校验与装饰器元数据。
- `src/services/ai-proxy-service.ts`：供应商 SSE 代理、按用户隔离、长轮询、取消和过期回收。
- `src/services/model-tree-service.ts`：查询实际父节点与可创建类型，并通过同一 StepManager 的宿主创建方法写入。
- `src/preload`：宿主公开 API 的类型化桥接；不会另起 Nest 服务。
- `src/main.ts`：导出生命周期、Controller 和空 behavior 扩展配置。

`pnpm build` 生成 `dist` 并同步至 `../plugin-front/.temp/buildNode`。
`pnpm start` 监听 TypeScript，并直接输出到该同步目录。
`pnpm test` 使用真实 Nest/class-validator 装饰器和模拟宿主服务；SSE 使用本地 HTTP 服务，不调用真实供应商。
构建前后端顺序、安装和未验证范围见 [插件说明](../README.md)。
