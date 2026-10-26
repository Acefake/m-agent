import { Controller, Get, Post, Query, Body, Req } from "../preload/nestjs-common";
import { RequestDto, BeginDto, CreateNodeDto } from "./dto";
import { begin, poll, abort } from "../services/ai-proxy-service";
import type { RequestContext } from "../services/ai-proxy-service";
import { createNode } from "../services/model-tree-service";

@Controller("assistant")
export class AgentController {
  @Post("begin")
  begin(@Body() dto: BeginDto, @Req() request: RequestContext) {
    return begin(dto, request);
  }

  @Get("poll")
  poll(@Query() dto: RequestDto, @Req() request: RequestContext) {
    return poll(dto, request);
  }

  @Post("abort")
  abort(@Body() dto: RequestDto, @Req() request: RequestContext) {
    return abort(dto, request);
  }

  @Post("createNode")
  createNode(@Body() dto: CreateNodeDto) {
    return createNode(dto);
  }
}
