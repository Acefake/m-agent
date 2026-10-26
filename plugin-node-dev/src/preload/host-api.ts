import type * as NestjsCommon from "@nestjs/common";
import type * as ClassValidator from "class-validator";

export interface ModelNode {
  id: string;
  name?: string;
  metaclass?: string;
  from?: number;
  isEncrypted?: boolean;
  hiddenStatus?: boolean;
}

export interface CreationType {
  metaclass: string;
  appliedStereotypes?: string[];
  sts?: string[];
  disabled?: boolean;
  operation?: string;
  children?: CreationType[];
}

interface StepContext {
  nodeService: {
    getNode(id: string): Promise<ModelNode | undefined>;
    getNodeChildren(id: string): Promise<ModelNode[]>;
    getCanCreateChildTypes(dto: { projectId: string; instanceId: string; hasSysMLPermission: string }): Promise<CreationType[]>;
  };
  modelService: {
    createModel(dto: {
      projectId: string;
      parentId: string;
      type: 0;
      metaclass: string;
      applyStereotypes: string[];
      customName: string;
      operation?: string;
      isAutoOpenDiagram: false;
    }): Promise<{ createdInstance?: ModelNode }>;
  };
  step: { autoOpenDiagram: boolean };
}

interface HostApi {
  NestjsCommon: typeof NestjsCommon;
  ClassValidator: typeof ClassValidator;
  DesignNodeApi: {
    transaction<T>(options: { projectId: string }, run: (st: StepContext) => Promise<T>): Promise<T>;
    ResData: new <T>(data: T) => { code: number; data: T };
  };
}

declare global {
  var __M_DESIGN_NODE_API__: HostApi;
}
export const hostApi = global.__M_DESIGN_NODE_API__;
if (!hostApi) throw new Error("agent 需要由 M-Design Node 插件加载器加载");
export const { transaction, ResData } = hostApi.DesignNodeApi;
