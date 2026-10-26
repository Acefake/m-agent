export { default as AiAssistantPanel } from "../components/panels/aiAssistant/index.vue";
export { configureMDesignHost } from "../host/host-adapter";
export { configureAiAssistant, getAiAssistantHost, tryGetAiAssistantHost } from "./host";
export { describeAiError } from "./ai-error";
export type { AiAssistantHost, AiDiagramHost, AiModelHost, AiModelMention, AiContextHost } from "./host";
export type {
  AiAgentEvents,
  AiChangeOperation,
  AiChangePlan,
  AiChangeProposal,
  AiChatMessage,
  AiChoiceOption,
  AiChoicePrompt,
  AiContextSnapshot,
  AiConversation,
  AiPermissionMode,
  AiPlanStep,
  AiProviderProfile,
  AiProviderSettings,
  AiRollbackResult,
  AiToolCallView
} from "./types";
export {
  AI_EFFORT_OPTIONS,
  AI_PERMISSION_MODES,
  AI_PROVIDER_PRESETS,
  AI_SETTINGS_STORAGE_KEY,
  createProfileFromPreset,
  getActiveProfile,
  getPermissionMode,
  loadAiProviderSettings,
  saveAiProviderSettings
} from "./provider/providerConfig";
export { useAiAssistantStore } from "./conversation/store";
