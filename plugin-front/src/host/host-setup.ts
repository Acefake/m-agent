import { createPinia, setActivePinia } from "pinia";
import { configureMDesignHost } from "./host-adapter";
import { tryGetAiAssistantHost } from "../ai-assistant/host";

/**
 * 面板加载时注入 M-Design 宿主能力，并给插件自己的 pinia 设置活动实例。
 *
 * 做成独立的副作用模块：面板、工具与 store 都依赖 host 已注入，
 * 在这里调用一次即可保证「面板打开前宿主已就绪」，且重复导入是幂等的。
 * pinia 实例属于插件自己（宿主没有暴露 pinia），store 只保存会话级 UI 状态。
 */
if (!tryGetAiAssistantHost()) configureMDesignHost();
setActivePinia(createPinia());
