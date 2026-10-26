import { hostApi } from "./host-api";
import type {} from "reflect-metadata";

export const { Controller, Get, Post, Query, Body } = hostApi.NestjsCommon;

/** 宿主未公开 Req，按其解析的 Nest REQUEST 参数元数据注册。 */
export function Req(): ParameterDecorator {
  return (target, name, index) => {
    const args = Reflect.getMetadata("__routeArguments__", target.constructor, name!) || {};
    args["0:" + index] = { index, data: undefined, pipes: [] };
    Reflect.defineMetadata("__routeArguments__", args, target.constructor, name!);
  };
}
