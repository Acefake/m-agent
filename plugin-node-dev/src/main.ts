import { AgentController } from "./controllers/AgentController";
import { startCleanup, stopAll } from "./services/ai-proxy-service";

export async function onInstall(): Promise<void> {
  startCleanup();
}
export async function onUninstall(): Promise<void> {
  stopAll();
}
export const controllers = [AgentController];
export const behaviors = {
  treeDropBehaviorConfigs: [],
  siderbarDropBehaviorConfigs: [],
  shapeDropBehaviors: [],
  connectBehaviors: [],
  modelCreateBehavior: [],
  propertyEditor: []
};
