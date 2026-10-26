import type { Component } from "vue";

/** 宿主 HTTP 客户端（modelHttp）：返回宿主统一的 ResData 包装，res.data 为接口载荷 */
export interface HostHttp {
  axios: { defaults: { baseURL: string } };
  get<T>(url: string, params?: unknown, config?: { tipError?: boolean }): Promise<{ data: T; code?: number; message?: string }>;
  post<T>(url: string, body: unknown, config?: { tipError?: boolean }): Promise<{ data: T; code?: number; message?: string }>;
}

interface Runtime {
  IpcWindow: new <T, R>(name: string) => { popup(query: T): Promise<R>; done(): void };
  PlatformModal: Component;
  usePlatformModalUtil(emit: (event: any, data?: any) => void): {
    visible: import("vue").Ref<boolean>;
    handleOk(data?: unknown): void;
    handleCancel(data?: unknown): void;
  };
  /** 宿主 Action 基类：插件的菜单动作都从这里继承 */
  Action: new () => { keyName: string };
  /** 宿主头部菜单枚举（父菜单用 Tool 表示“工具”） */
  HeaderMenuType: { Tool: string };
  /** 宿主 MModal 组件（面板内如需宿主弹窗可复用） */
  MModal: Component;
  /** 宿主模型服务 HTTP 客户端 */
  modelHttp: HostHttp;
  /** 宿主 axios 实例（绕过宿主拦截器发原始请求） */
  axios: {
    post<T>(url: string, body: unknown, config: { baseURL: string; headers: Record<string, string> }): Promise<{ data: T }>;
    get<T>(
      url: string,
      config: { baseURL: string; headers: Record<string, string>; params?: Record<string, string> }
    ): Promise<{ data: T }>;
  };
  /** 是否运行在 Electron 桌面端 */
  isElectron: boolean;
  /** 宿主通知 */
  notify(options: { title: string; message: string; type: "error" | "warning" | "success"; forbidTranslate?: boolean }): void;
}

declare global {
  interface Window {
    api: Runtime & { vue: typeof import("vue") };
  }
}

const runtime = window.api;
export const { Action, HeaderMenuType, modelHttp, axios, isElectron, notify } = runtime;

export interface PluginRegister {
  registerWindow(config: object): void;
  unregisterWindow(name: string): void;
  registerMenu(modifier: object): void;
  unregisterMenu(id: string): void;
  registerActions(actions: Array<{ key: string; loader: () => Promise<unknown> }>): void;
  unregisterAction(keys: string[]): void;
  registerPanelComponent(config: object): void;
  unregisterPanelComponent(key: string): void;
}
