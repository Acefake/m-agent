import { assistantHistory } from "./model-history";
import { detachedSession } from "../../presentation/window-session";
import { appendMessageText } from "./message-timeline";
import type { ImagePart, ModelMessage, TextPart } from "ai";
import { nanoid } from "nanoid";
import { createPinia, defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { emptyMemoryState } from "../memory";
import type { MemoryCommand } from "../memory";
import { MemoryService } from "../memory/service";
import type { MemoryTurn } from "../memory/service";
import { describeAiError } from "../ai-error";
import { runAiAgent } from "../runtime/agent";
import { runExpertTeam, reviewExpertTeam } from "../runtime/expert-team";
import { isExecutionStrategy, standaloneExpertTask } from "../runtime/expert-roles";
import {
  composeUserContent,
  hydrateMessageImages,
  imagePlaceholder,
  releaseMessageImages,
  selectRequestImageIds,
  serializeMessagesForPersist
} from "./attachments";
import { getAiAssistantHost, tryGetAiAssistantHost } from "../host";
import { getActiveProfile, getPermissionMode, loadAiProviderSettings, saveAiProviderSettings } from "../provider/providerConfig";
import { createTextProposalFallback, normalizeOperations } from "../changes/proposal";
import { resolveActiveSkills } from "../skills";
import type {
  AiAttachment,
  AiChangePlan,
  AiChangeProposal,
  AiChatMessage,
  AiChoicePrompt,
  AiConversation,
  AiExecutionStrategy,
  AiConversationOptions,
  AiConversationDraft,
  AiRollbackResult
} from "../types";
import { mergeConversationDigest } from "./history-digest";
import { rollbackOperations } from "../changes/rollback";

const MAX_CONVERSATIONS = 8;
const MAX_MESSAGES_PER_CONVERSATION = 40;
/** 一次执行失败后最多自动修正的轮数，避免模型反复失败时死循环 */
const MAX_AUTO_REPAIRS = 2;

/** 一轮对话的附加输入：附件，以及本轮用 /name 显式启用的技能 */
export interface SendMessageOptions {
  attachments?: AiAttachment[];
  skillNames?: string[];
}

/**
 * 组装发给模型的一条消息。
 *
 * 用户消息可能带附件：文本附件的正文内联进文本，图片作为多模态 part 发送
 * （只有本轮选中的图片，见 selectRequestImageIds，更早的图片用占位文本说明）。
 * 显式 @ 引用保留在用户正文中；历史界面快照不作为模型输入。
 */
function toModelMessage(message: AiChatMessage, requestImageIds: Set<string>): ModelMessage | undefined {
  if (message.role === "assistant") {
    return message.content ? { role: "assistant", content: message.content } : undefined;
  }

  const images = (message.attachments ?? []).filter(attachment => attachment.kind === "image" && attachment.dataUrl);
  const omitted = images.filter(attachment => !requestImageIds.has(attachment.id)).map(imagePlaceholder);
  const text = [composeUserContent(message.content, message.attachments), ...omitted].filter(Boolean).join("\n\n");

  const parts: Array<TextPart | ImagePart> = [];
  if (text) parts.push({ type: "text", text });
  images
    .filter(attachment => requestImageIds.has(attachment.id))
    .forEach(attachment => parts.push({ type: "image", image: attachment.dataUrl!, mediaType: attachment.mimeType ?? "image/jpeg" }));

  if (!parts.length) return undefined;
  // 只有文本时仍发字符串：与既有行为一致，也避免无谓的 part 包装
  if (parts.length === 1 && parts[0].type === "text") return { role: "user", content: parts[0].text };
  return { role: "user", content: parts };
}

function buildModelMessages(messages: AiChatMessage[], digest?: string): ModelMessage[] {
  const requestImageIds = selectRequestImageIds(messages);
  const history = messages
    .flatMap(message => (message.role === "assistant" ? assistantHistory(message) : [toModelMessage(message, requestImageIds)]))
    .filter((message): message is ModelMessage => !!message);
  // 被条数上限截断的旧消息以摘要形式继续对模型可见，摘要细节（属性旧值等）改动前必须重读。
  // AI SDK 不允许 messages 里出现 system 角色，摘要以带标识的 user 消息注入
  if (digest) {
    history.unshift({
      role: "user",
      content: `【较早会话摘要（本地保存上限外的历史，只保留目标、结论与真实 ID；属性旧值等细节在改动前必须重新读取）】\n${digest}`
    });
  }
  return history;
}

function getConversationTitle(messages: AiChatMessage[]): string {
  const first = messages.find(message => message.role === "user" && (message.content.trim() || message.attachments?.length));
  // 只发了附件没写文字时，用第一个附件的文件名当标题
  const question = first?.content.trim() || first?.attachments?.[0]?.name || "";
  if (!question) return "新对话";
  return question.length > 24 ? `${question.slice(0, 24)}…` : question;
}

/** 追加推理片段：并入上一条思考步骤，没有则新建 */
function appendReasoning(message: AiChatMessage, delta: string): void {
  const steps = [...(message.steps ?? [])];
  const last = steps[steps.length - 1];

  if (last?.kind === "reasoning") steps[steps.length - 1] = { kind: "reasoning", text: `${last.text}${delta}` };
  else steps.push({ kind: "reasoning", text: delta });

  message.steps = steps;
}

function getReadNamespaceId(message: AiChatMessage): string | undefined {
  let inspectedElementId: string | undefined;
  for (const call of message.toolCalls) {
    if (call.name !== "text_read_sysml" && call.name !== "model_read_sysml_text" && call.name !== "model_get_element") continue;
    if (!call.input || typeof call.input !== "object") continue;
    const elementId = (call.input as Record<string, unknown>).elementId;
    if (typeof elementId !== "string" || !elementId.trim()) continue;
    if (call.name === "text_read_sysml" || call.name === "model_read_sysml_text") return elementId.trim();
    inspectedElementId = elementId.trim();
  }
  return inspectedElementId;
}

const useOwnerStore = defineStore("aiAssistant", () => {
  const conversations = ref<AiConversation[]>([]);
  const activeConversationId = ref("");
  // 消息只保存在会话中，停靠或切换会话后不再依赖另一份可能过期的数组。
  const messages = computed(() => conversations.value.find(item => item.id === activeConversationId.value)?.messages ?? []);
  const runningConversationIds = ref<string[]>([]);
  const isRunning = computed(() => runningConversationIds.value.includes(activeConversationId.value));
  const runningConversationId = computed(() => (isRunning.value ? activeConversationId.value : ""));
  const errors = ref<Record<string, string>>({});
  const drafts = ref<Record<string, AiConversationDraft>>({});
  const errorMessage = computed({
    get: () => errors.value[activeConversationId.value] ?? "",
    set: (value: string) => {
      errors.value[activeConversationId.value] = value;
    }
  });
  const hasMessages = computed(() => messages.value.length > 0);

  let projectId = "";
  const memoryState = ref(emptyMemoryState());
  const memory = new MemoryService(
    () => ({ identity: tryGetAiAssistantHost()?.getMemoryIdentity?.() ?? { kind: "local-profile" }, projectId }),
    state => {
      memoryState.value = state;
    }
  );
  /** 管理界面和镜像显式刷新当前身份及项目的记忆。 */
  async function refreshMemory(): Promise<void> {
    await memory.refresh();
  }
  /** 所有管理写入完成事务后才更新界面。 */
  async function changeMemory(command: MemoryCommand, contextKey: string): Promise<void> {
    await memory.change(command, contextKey);
  }
  watch(
    () => JSON.stringify(tryGetAiAssistantHost()?.getMemoryIdentity?.()),
    () => {
      memory.cancel();
      void refreshMemory();
    },
    { flush: "sync" }
  );
  const controllers = new Map<string, AbortController>();
  const repairs = new Map<string, { attempts: number; execute: boolean }>();
  function beginRun(id: string): AbortController {
    const controller = new AbortController();
    controllers.set(id, controller);
    runningConversationIds.value = [...controllers.keys()];
    return controller;
  }
  function endRun(id: string, controller: AbortController): void {
    if (controllers.get(id) !== controller) return;
    controllers.delete(id);
    runningConversationIds.value = [...controllers.keys()];
  }
  function setDraft(id: string, draft: AiConversationDraft): void {
    if (id && !conversations.value.some(item => item.id === id)) return;
    drafts.value[id] = draft;
  }
  function setConversationOptions(options: Partial<AiConversationOptions>, id = activeConversationId.value): void {
    const conversation = conversations.value.find(item => item.id === id) ?? (!id ? createConversation(false) : undefined);
    if (!conversation) return;
    conversation.options = { ...conversation.options, ...options };
    if (options.model !== undefined) {
      conversation.options.contextLength = options.contextLength;
      conversation.options.effort = options.effort;
    }
    persistConversations(conversation.id);
  }
  function requestSettings(id: string) {
    const settings = loadAiProviderSettings();
    const options = conversations.value.find(item => item.id === id)?.options;
    if (options?.profileId) {
      settings.activeProfileId = options.profileId;
      if (!settings.profiles.some(profile => profile.id === options.profileId)) settings.profiles = [];
    }
    const profile = getActiveProfile(settings);
    if (profile && options)
      Object.assign(profile, { model: options.model ?? profile.model, effort: options.effort, contextLength: options.contextLength });
    if (options?.permissionMode) settings.permissionMode = options.permissionMode;
    return settings;
  }

  function persistConversations(keepConversationId = runningConversationId.value): void {
    if (!projectId) return;

    const active = conversations.value.find(item => item.id === (keepConversationId || activeConversationId.value));
    if (active) {
      if (active.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
        // 被上限截断的消息先折成摘要（保留目标、收据与真实 ID），再从存储里清掉其中的图片
        const dropped = active.messages.slice(0, -MAX_MESSAGES_PER_CONVERSATION);
        releaseMessageImages(dropped);
        active.digest = mergeConversationDigest(active.digest, dropped) || undefined;
        active.messages = active.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
      }
      active.title = getConversationTitle(active.messages);
      active.updatedAt = Date.now();
    }

    // 后台任务及当前会话不能被历史记录上限淘汰。
    const priority = (id: string) => (controllers.has(id) || id === keepConversationId ? 2 : id === activeConversationId.value ? 1 : 0);
    const kept = [...conversations.value]
      .sort((left, right) => priority(right.id) - priority(left.id) || right.updatedAt - left.updatedAt)
      .filter(
        (item, index) =>
          index < MAX_CONVERSATIONS || controllers.has(item.id) || item.id === activeConversationId.value || item.id === keepConversationId
      );
    const keptIds = new Set(kept.map(conversation => conversation.id));
    conversations.value
      .filter(conversation => !keptIds.has(conversation.id))
      .forEach(conversation => releaseMessageImages(conversation.messages));

    // 落盘用剥离副本：图片另存独立 key，会话 JSON 里只留附件 id（这份 JSON 每轮都会整体重写）
    const settings = loadAiProviderSettings();
    settings.conversationsByProject ??= {};
    settings.conversationsByProject[projectId] = kept.map(conversation => {
      const { messages: persisted, unsavedImages: unsaved } = serializeMessagesForPersist(conversation.messages);
      if (unsaved && !errors.value[conversation.id])
        errors.value[conversation.id] = `有 ${unsaved} 张图片没能写入本地存储，历史记录里将只保留文件名`;
      return { ...conversation, messages: persisted };
    });
    saveAiProviderSettings(settings);
  }

  /** 项目已切换时，已提交请求的最终收据仍保存到发起项目。 */
  function persistOriginConversation(conversation: AiConversation, originProjectId: string): void {
    if (originProjectId === projectId) {
      persistConversations(conversation.id);
      return;
    }
    const settings = loadAiProviderSettings();
    const saved = settings.conversationsByProject?.[originProjectId]?.find(item => item.id === conversation.id);
    if (!saved) return;
    saved.messages = serializeMessagesForPersist(conversation.messages).messages;
    saved.digest = conversation.digest;
    saved.updatedAt = Date.now();
    saveAiProviderSettings(settings);
  }

  /** 切换项目时加载其本地会话；会话不会跨项目混用。 */
  function loadProject(nextProjectId: string): void {
    if (projectId === nextProjectId) return;
    persistConversations();
    for (const id of controllers.keys()) stop(id);
    controllers.clear();
    runningConversationIds.value = [];
    errors.value = {};
    drafts.value = {};
    repairs.clear();
    projectId = nextProjectId;
    memory.cancel();
    void refreshMemory();
    const settings = loadAiProviderSettings();
    const profile = getActiveProfile(settings);
    conversations.value = nextProjectId ? (settings.conversationsByProject?.[nextProjectId] ?? []) : [];
    for (const conversation of conversations.value) {
      conversation.options ??= {
        profileId: profile?.id,
        model: profile?.model,
        effort: profile?.effort,
        contextLength: profile?.contextLength,
        permissionMode: getPermissionMode(settings)
      };
      for (const message of conversation.messages) {
        if (message.team?.status !== "running") continue;
        message.team.status = "interrupted";
        message.team.members
          .filter(member => ["running", "queued"].includes(member.status))
          .forEach(member => {
            member.status = "cancelled";
            member.error = "上次运行已中断，未自动恢复";
          });
      }
    }
    activeConversationId.value = "";
    errorMessage.value = "";
  }

  /** 新建空白会话并设为当前会话。 */
  function createConversation(shouldPersist = true): AiConversation {
    persistConversations();
    const settings = loadAiProviderSettings();
    const profile = getActiveProfile(settings);
    const conversation: AiConversation = {
      id: nanoid(),
      title: "新对话",
      messages: [],
      updatedAt: Date.now(),
      options: {
        profileId: profile?.id,
        model: profile?.model,
        effort: profile?.effort,
        contextLength: profile?.contextLength,
        permissionMode: getPermissionMode(settings)
      }
    };
    conversations.value = [conversation, ...conversations.value].filter(
      (item, index) => index < MAX_CONVERSATIONS || controllers.has(item.id)
    );
    if (!activeConversationId.value && drafts.value[""]) {
      drafts.value[conversation.id] = drafts.value[""];
      delete drafts.value[""];
    }
    activeConversationId.value = conversation.id;
    errorMessage.value = "";
    if (shouldPersist) persistConversations();
    return conversation;
  }

  /** 切换至指定会话。 */
  function selectConversation(id: string): void {
    const conversation = conversations.value.find(item => item.id === id);
    if (!conversation || conversation.id === activeConversationId.value) return;
    persistConversations();
    activeConversationId.value = conversation.id;
    // 图片附件不在会话 JSON 里，切过来时从附件存储回填
    hydrateMessageImages(messages.value);
  }

  function setExecutionStrategy(strategy: AiExecutionStrategy, conversationId = activeConversationId.value): void {
    if (!isExecutionStrategy(strategy)) return;
    if (controllers.has(conversationId)) return;
    const conversation =
      conversations.value.find(item => item.id === conversationId) ?? (!conversationId ? createConversation(false) : undefined);
    if (!conversation) return;
    conversation.strategy = strategy;
    persistConversations();
  }

  /** 删除指定会话；删除当前会话后返回会话列表。 */
  async function deleteConversation(id: string): Promise<void> {
    const deletingProjectId = projectId;
    const deletingConversation = conversations.value.find(item => item.id === id);
    stop(id);
    memory.cancel();
    try {
      await memory.forgetConversation(id);
    } catch (error) {
      errors.value[id] = describeAiError(error);
      return;
    }
    if (projectId !== deletingProjectId) {
      const settings = loadAiProviderSettings();
      const byProject = settings.conversationsByProject;
      if (byProject?.[deletingProjectId]) {
        byProject[deletingProjectId] = byProject[deletingProjectId].filter(item => item.id !== id);
        saveAiProviderSettings(settings);
      }
      if (deletingConversation) releaseMessageImages(deletingConversation.messages);
      return;
    }
    delete drafts.value[id];
    delete errors.value[id];
    repairs.delete(id);
    const target = conversations.value.find(item => item.id === id);
    if (target) releaseMessageImages(target.messages);

    const next = conversations.value.filter(item => item.id !== id);
    conversations.value = next;
    if (id === activeConversationId.value) {
      activeConversationId.value = "";
    }
    persistConversations();
  }

  /** 发送用户消息并运行 AI（含多步工具调用）。 */
  async function sendMessage(text: string, options: SendMessageOptions = {}, conversationId = activeConversationId.value): Promise<void> {
    if (controllers.has(conversationId)) return;
    if (!conversationId) conversationId = createConversation(false).id;
    repairs.set(conversationId, { attempts: 0, execute: false });
    await runTurn(text, options, conversationId);
  }

  /** 当前输入是否具备启动一轮 AI 对话的必要条件；只带附件（无文字）也算一次有效输入。 */
  function canStartTurn(text: string, hasAttachments = false, conversationId = activeConversationId.value): boolean {
    if ((!text.trim() && !hasAttachments) || controllers.has(conversationId)) return false;

    errors.value[conversationId] = "";
    const profile = getActiveProfile(requestSettings(conversationId));
    if (!profile) {
      errors.value[conversationId] = "尚未配置 AI 供应商，请先在设置中配置";
      return false;
    }

    if (!profile.model) {
      errors.value[conversationId] = "请先在输入区选择模型";
      return false;
    }

    return true;
  }

  /** 提案执行失败后自动让 AI 依据失败原因修正；修正版提案直接执行，用户已确认过同一诉求 */
  async function autoRepairAfterFailure(failures: string[], conversationId: string): Promise<void> {
    const repair = repairs.get(conversationId) ?? { attempts: 0, execute: false };
    repairs.set(conversationId, repair);
    if (repair.attempts >= MAX_AUTO_REPAIRS) {
      errors.value[conversationId] = `已自动修正 ${MAX_AUTO_REPAIRS} 次仍未成功，请调整需求描述或更换模型后重试`;
      return;
    }

    repair.attempts += 1;
    repair.execute = true;
    await runTurn(
      `（自动修正第 ${repair.attempts} 次）上一次执行未成功，请据此修正后重新生成提案：\n${failures.join("\n")}`,
      {},
      conversationId,
      false
    );
  }

  /** 运行一轮对话：用户消息与失败后的自动修正共用同一实现 */
  async function runTurn(
    text: string,
    options: SendMessageOptions = {},
    conversationId = activeConversationId.value,
    realUser = true
  ): Promise<void> {
    const content = text.trim();
    const attachments = options.attachments ?? [];
    const skillNames = options.skillNames ?? [];
    if (!canStartTurn(content, attachments.length > 0, conversationId)) return;

    const settings = requestSettings(conversationId);
    const selectedProfile = getActiveProfile(settings);
    if (!selectedProfile?.model) return;
    const profile = { ...selectedProfile };

    // 权限模式来自设置：聊天模式只读、提案模式出卡片、编辑模式直接落盘
    const permissionMode = getPermissionMode(settings);

    if (!conversationId) conversationId = createConversation(false).id;
    const runningConversation = conversations.value.find(item => item.id === conversationId);
    if (!runningConversation) return;

    const userMessage: AiChatMessage = {
      id: nanoid(),
      role: "user",
      content,
      toolCalls: [],
      createdAt: Date.now(),
      ...(attachments.length ? { attachments } : {}),
      ...(skillNames.length ? { skillNames } : {})
    };
    const assistantMessage: AiChatMessage = {
      id: nanoid(),
      role: "assistant",
      content: "",
      model: profile.model,
      toolCalls: [],
      createdAt: Date.now()
    };
    runningConversation.messages = [...runningConversation.messages, userMessage, assistantMessage];
    persistConversations(conversationId);

    const history = buildModelMessages(runningConversation.messages, runningConversation.digest);
    const assistantId = assistantMessage.id;
    const runningProjectId = projectId;
    const runningMessage = runningConversation.messages.find(message => message.id === assistantId)!;
    const patchAssistant = (patch: (message: AiChatMessage) => void) => {
      patch(runningMessage);
    };

    const abortController = beginRun(conversationId);

    const startedAt = Date.now();
    let latestProposal: AiChangeProposal | undefined;
    let latestChoicePrompt: AiChoicePrompt | undefined;
    let latestPlan: AiChangePlan | undefined;
    let memoryTurn: MemoryTurn | undefined;
    let hasFirstOutput = false;
    const markFirstOutput = () => {
      if (hasFirstOutput) return;
      hasFirstOutput = true;
      patchAssistant(message => {
        message.thinkingMs = Date.now() - startedAt;
      });
    };

    try {
      if (realUser && memoryState.value.enabled && memoryState.value.available) {
        memoryTurn = await memory.begin(
          { conversationId, messageId: userMessage.id, quote: "", createdAt: userMessage.createdAt },
          content
        );
      }
      if (abortController.signal.aborted) return;
      const runner = runningConversation.strategy === "sysml-team" ? runExpertTeam : runAiAgent;
      const activeSkills = resolveActiveSkills(settings.skills ?? [], skillNames);
      patchAssistant(message => {
        message.skillNames = activeSkills.map(skill => skill.name);
      });
      await runner({
        profile,
        expertTask: standaloneExpertTask(runningConversation.strategy),
        messages: history,
        memoryContext: memoryTurn?.context,
        signal: abortController.signal,
        permissionMode,
        // 技能：默认启用的 + 本轮 /name 调用的；附件：会话里出现过就给模型一句说明
        skills: activeSkills,
        hasAttachments: runningConversation.messages.some(message => message.attachments?.length),
        events: {
          onMetrics: metrics => patchAssistant(message => { message.metrics = metrics; }),
          onContextUsage: context => patchAssistant(message => { message.contextUsage = context; }),
          onTeam: team =>
            patchAssistant(message => {
              message.team = team;
            }),
          onReasoningDelta: delta => {
            markFirstOutput();
            patchAssistant(message => appendReasoning(message, delta));
          },
          onTextDelta: delta => {
            markFirstOutput();
            patchAssistant(message => {
              appendMessageText(message, delta);
            });
          },
          onToolCallStart: call => {
            markFirstOutput();
            patchAssistant(message => {
              message.steps = [...(message.steps ?? []), { kind: "tool", id: call.id }];
              message.toolCalls.push({ id: call.id, name: call.name, input: call.input, state: "running" });
            });
          },
          onModelContext: context =>
            patchAssistant(message => {
              message.modelContext = JSON.stringify(context);
            }),
          onRunState: state =>
            patchAssistant(message => {
              message.runState = state;
            }),
          onUsage: usage =>
            patchAssistant(message => {
              message.usage = usage;
            }),
          onToolCallEnd: call =>
            patchAssistant(message => {
              const toolCall = message.toolCalls.find(item => item.id === call.id);
              if (!toolCall) return;
              toolCall.state = call.error ? "error" : "done";
              toolCall.output = call.output;
              toolCall.error = call.error;
            }),
          // 提案先缓存，等本轮全部工具调用结束后再挂到消息上
          onProposal: proposal => {
            latestProposal = proposal;
          },
          // 选择卡片同样先缓存，等本轮结束后再挂出
          onChoicePrompt: prompt => {
            latestChoicePrompt = prompt;
          },
          // 分步计划：同样本轮结束后挂出，供用户勾选后转提案
          onPlan: plan => {
            latestPlan = plan;
          },
          onError: message => {
            if (runningProjectId === projectId) errors.value[conversationId] = message;
          },
          onFinish: () => undefined
        }
      });
    } catch (error) {
      if (runningProjectId === projectId) errors.value[conversationId] = describeAiError(error);
    } finally {
      patchAssistant(message => {
        message.durationMs = Date.now() - startedAt;
        for (const call of message.toolCalls) {
          if (call.state !== "running") continue;
          call.state = "error";
          call.error = message.runState?.message || "本轮已结束，该工具未返回执行结果";
        }
      });
      endRun(conversationId, abortController);
      runningConversation.messages = runningConversation.messages.filter(
        message => message.role === "user" || message.content || message.toolCalls.length || message.team
      );
      runningConversation.title = getConversationTitle(runningConversation.messages);
      runningConversation.updatedAt = Date.now();
      persistOriginConversation(runningConversation, runningProjectId);
    }

    // 删除会话或切换项目后，不在另一个会话上挂卡片或继续自动修正。
    if (runningProjectId !== projectId || !conversations.value.some(item => item.id === conversationId)) return;

    // 本轮结束后才挂出提案与选择卡片：提案优先用工具产出，其次用正文里的 SysML 文本兜底。
    // 卡片只在提案模式挂出：聊天模式承诺只读（该模式下不该出现可点击执行的卡片，而且卡片会随
    // 会话持久化，用户切回提案模式再点它就等于执行一条从没在提案模式确认过的改动）；
    // 编辑模式的改动已直接落盘，再出卡片会被重复执行。
    patchAssistant(message => {
      if (!message.choicePrompt && latestChoicePrompt) message.choicePrompt = latestChoicePrompt;
      // 计划只在提案模式出现（工具只挂在提案模式），与提案卡片互斥：同一轮先出计划就不再出提案
      if (permissionMode === "proposal" && !latestProposal && latestPlan && !message.proposal) {
        message.plan = latestPlan;
        return;
      }
      if (permissionMode !== "proposal" || message.proposal) return;
      // 文本建模兜底只在宿主支持 SysML 文本的宿主上启用；M-Design 的提案必须来自工具调用
      const textEnabled = tryGetAiAssistantHost()?.features?.sysmlText !== false;
      const proposal =
        latestProposal ?? (textEnabled ? createTextProposalFallback(message.content, content, getReadNamespaceId(message)) : undefined);
      if (proposal) message.proposal = proposal;
    });
    persistConversations(conversationId);

    if (memoryTurn && !abortController.signal.aborted) void memoryTurn.finish(profile);

    // 自动修正产生的提案直接执行，避免用户反复点确认
    const repair = repairs.get(conversationId);
    if (repair?.execute && !abortController.signal.aborted) {
      repair.execute = false;
      await executeProposal(assistantId, true, conversationId);
    }
  }

  /** 执行已由界面明确确认的提案；AI 工具本身没有此入口。 */
  async function executeProposal(messageId: string, confirmed: boolean, conversationId = activeConversationId.value): Promise<void> {
    // 运行中不执行，避免与本轮仍在进行的工具调用交错
    if (!confirmed || controllers.has(conversationId)) return;

    const conversation = conversations.value.find(item => item.id === conversationId);
    const executionProjectId = projectId;
    const message = conversation?.messages.find(item => item.id === messageId);
    const proposal = message?.proposal;
    if (!proposal || proposal.status !== "pending") return;

    // 兜底闸门：历史会话可能残留聊天模式下生成的提案卡片，执行前再确认一次当前模式允许落盘
    if (getPermissionMode(requestSettings(conversationId)) === "chat") {
      proposal.status = "rejected";
      proposal.operations.forEach(operation => {
        operation.status = "failed";
        operation.result = "当前为聊天模式（只读），请在输入区切换到提案或编辑模式后重试";
      });
      persistConversations();
      return;
    }

    const executor = getAiAssistantHost().proposalExecutor;
    if (!executor) {
      proposal.status = "rejected";
      proposal.operations.forEach(operation => {
        operation.status = "failed";
        operation.result = "当前宿主不支持执行模型变更";
      });
      persistConversations();
      return;
    }

    proposal.status = "executing";
    if (message.team) message.team.status = "running";
    const executionAbort = beginRun(conversationId);
    try {
      for (const [index, operation] of proposal.operations.entries()) {
        if (executionAbort.signal.aborted) {
          proposal.operations.slice(index).forEach(pending => {
            pending.status = "failed";
            pending.result = "执行已停止，未提交此项";
          });
          break;
        }
        operation.status = "running";
        try {
          operation.result = await executor.execute(operation, { proposalId: proposal.id });
          operation.status = "completed";
        } catch (error) {
          operation.status = "failed";
          operation.result = describeAiError(error);
          proposal.operations.slice(index + 1).forEach(nextOperation => {
            nextOperation.status = "failed";
            nextOperation.result = "前序操作失败，未继续执行";
          });
          break;
        }
      }
    } finally {
      // 整轮结束后才释放执行期状态：本轮内后续操作（如 arrange-shapes）依赖前面创建的结果
      executor.finish?.(proposal.id);
      endRun(conversationId, executionAbort);
    }

    proposal.status = proposal.operations.every(operation => operation.status === "completed") ? "completed" : "partial";
    if (message.team) {
      message.team.status = executionAbort.signal.aborted ? "cancelled" : proposal.status === "completed" ? "completed" : "error";
      if (executionAbort.signal.aborted) message.team.error = "已停止；已提交操作的真实收据已保留";
    }

    // 计划转来的提案：把执行结果同步回计划步骤，计划卡片据此显示每步成败
    if (message.plan) {
      message.plan.steps.forEach(step => {
        const operation = proposal.operations.find(item => item.id === step.id);
        if (!operation) return;
        step.status = operation.status;
        step.result = operation.result;
        step.reverted = operation.reverted;
      });
    }
    persistOriginConversation(conversation!, executionProjectId);

    const failures = proposal.operations
      .filter(operation => operation.status === "failed")
      .map(operation => `- ${operation.summary ?? operation.type}：${operation.result ?? "未完成"}`);
    if (
      message.team?.reviewPending &&
      !executionAbort.signal.aborted &&
      executionProjectId === projectId &&
      conversations.value.some(item => item.id === conversationId)
    ) {
      const settings = loadAiProviderSettings();
      const profile = settings.profiles.find(item => item.id === message.team!.profileId);
      if (!profile) {
        message.team.status = "error";
        message.team.error = "模型已提交，原供应商配置不存在，未完成专家回读检查";
        errors.value[conversationId] = message.team.error;
        persistConversations(conversationId);
      } else {
        const abortController = beginRun(conversationId);
        const reviewStartedAt = Date.now();
        try {
          await reviewExpertTeam(
            {
              profile: { ...profile, model: message.team.model },
              messages: buildModelMessages(conversation!.messages.slice(0, conversation!.messages.indexOf(message)), conversation!.digest),
              signal: abortController.signal,
              permissionMode: "chat",
              events: {
                onMetrics: metrics => { message.metrics = metrics; },
                onContextUsage: usage => { message.contextUsage = usage; },
                onReasoningDelta() {},
                onTextDelta() {},
                onToolCallStart() {},
                onToolCallEnd() {},
                onProposal() {},
                onPlan() {},
                onChoicePrompt() {},
                onFinish() {},
                onTeam: team => {
                  message.team = team;
                },
                onUsage: usage => {
                  message.usage = usage;
                },
                onError: error => {
                  if (projectId === executionProjectId) errors.value[conversationId] = error;
                }
              }
            },
            message.team,
            JSON.stringify(proposal.operations)
          );
        } finally {
          message.durationMs = (message.durationMs ?? 0) + Date.now() - reviewStartedAt;
          endRun(conversationId, abortController);
          persistOriginConversation(conversation!, executionProjectId);
        }
      }
    }
    if (failures.length && message.team && !executionAbort.signal.aborted) {
      message.team.status = "error";
      message.team.error ||= "部分操作未完成，请查看提案执行结果";
      persistOriginConversation(conversation!, executionProjectId);
    }
    if (
      failures.length &&
      !executionAbort.signal.aborted &&
      executionProjectId === projectId &&
      conversations.value.some(item => item.id === conversationId)
    ) {
      await autoRepairAfterFailure(failures, conversationId);
    }
  }

  /**
   * 用户在计划卡片上勾选若干步骤并确认：把勾选步骤转成一份提案卡片（状态 pending），
   * 挂到当前 assistant 消息上，由既有的「确认并执行」流程执行。
   *
   * 计划步骤可能与提案操作字段一致，但执行前仍走 normalizeOperations 同一套校验：
   * 模型给计划时允许字段不齐（先看步骤），落成提案时缺字段会被拦下并给出原因。
   *
   * @param messageId 计划所在的消息
   * @param stepIds 用户勾选的步骤 id 列表
   */
  function executePlan(messageId: string, stepIds: string[], conversationId = activeConversationId.value): void {
    const message = conversations.value.find(item => item.id === conversationId)?.messages.find(item => item.id === messageId);
    if (!message) return;
    const plan = message.plan;
    if (!plan || plan.status !== "pending") return;

    const chosen = plan.steps.filter(step => stepIds.includes(step.id));
    if (!chosen.length) return;

    const { operations, errors: validationErrors } = normalizeOperations(chosen);
    if (!operations.length) {
      errors.value[conversationId] = `所选步骤均缺少必需字段，无法执行：\n${validationErrors.join("\n")}`;
      return;
    }

    // 计划已兑现：卡片标记为已转提案（不再可重复转），未勾选步骤标记 skipped
    plan.status = "converted";
    plan.steps.forEach(step => {
      if (!stepIds.includes(step.id)) {
        step.status = "skipped";
        step.result = "未勾选，未执行";
      }
    });

    message.proposal = {
      id: nanoid(),
      title: plan.title,
      summary: validationErrors.length
        ? `${plan.summary}（${validationErrors.length} 步因参数不齐被拦下：${validationErrors.join("；")}）`
        : plan.summary,
      operations,
      status: "pending"
    };
    errors.value[conversationId] = "";
    persistConversations(conversationId);
  }

  /** 用户忽略整份计划：卡片标记为已忽略，步骤不再可勾选。 */
  function rejectPlan(messageId: string, conversationId = activeConversationId.value): void {
    const message = conversations.value.find(item => item.id === conversationId)?.messages.find(item => item.id === messageId);
    if (!message) return;
    const plan = message.plan;
    if (!plan || plan.status !== "pending") return;

    plan.status = "rejected";
    plan.steps.forEach(step => {
      if (step.status === "pending") {
        step.status = "skipped";
        step.result = "计划已忽略";
      }
    });
    persistConversations(conversationId);
  }

  /**
   * 回滚一条消息里已执行的提案/编辑改动：逐条执行操作自带的 revert 逆操作。
   *
   * 逆操作由宿主在执行成功时写入 operation.revert；没有逆操作的（如删除元素）计入
   * skipped 并在返回值里说明，用户可手动恢复。失败与成功都写回 result 供界面展示。
   *
   * @param messageId 提案所在的消息
   */
  async function rollbackProposal(messageId: string, conversationId = activeConversationId.value): Promise<AiRollbackResult> {
    const message = conversations.value.find(item => item.id === conversationId)?.messages.find(item => item.id === messageId);
    if (!message) return { reverted: 0, skipped: ["找不到要回滚的提案"] };
    const proposal = message.proposal;
    if (!proposal) return { reverted: 0, skipped: ["找不到要回滚的提案"] };
    if (controllers.has(conversationId)) return { reverted: 0, skipped: ["AI 正在运行，请稍后再回滚"] };

    const executor = tryGetAiAssistantHost()?.revertExecutor;
    const conversation = conversations.value.find(item => item.id === conversationId)!;
    const originProjectId = projectId;
    const controller = beginRun(conversationId);
    let result: AiRollbackResult;
    try {
      result = await rollbackOperations(proposal.operations, executor);
    } finally {
      endRun(conversationId, controller);
    }

    // 回滚结果记在消息上供界面展示；提案来自计划时把回滚状态同步回步骤
    message.rollback = result;
    message.plan?.steps.forEach(step => {
      const operation = proposal.operations.find(item => item.id === step.id);
      if (operation) step.reverted = operation.reverted;
    });
    persistOriginConversation(conversation, originProjectId);
    return result;
  }

  /** 提交选择并继续；answer 为 null 时跳过追问，不记录偏好答案。 */
  async function answerChoicePrompt(
    messageId: string,
    promptId: string,
    answer: string | null,
    conversationId = activeConversationId.value
  ): Promise<void> {
    const text = answer?.trim();
    if ((answer !== null && !text) || controllers.has(conversationId)) return;

    const message = conversations.value.find(item => item.id === conversationId)?.messages.find(item => item.id === messageId);
    const prompt = message?.choicePrompt;
    if (!prompt || prompt.id !== promptId || prompt.status !== "pending") return;

    const followUp =
      answer === null
        ? `跳过本次追问：${prompt.question}。请沿用已有信息继续原任务，必要时说明合理默认值；不要把跳过视为任何选项或新的偏好，不要重复询问本题。跳过不代表授权需要确认的操作。`
        : `我的选择是：${text}（针对问题：${prompt.question}）`;
    if (!canStartTurn(followUp, false, conversationId)) return;

    prompt.status = answer === null ? "skipped" : "answered";
    prompt.answer = text;
    persistConversations(conversationId);
    await runTurn(followUp, {}, conversationId, false);
  }

  /** 中止当前运行。 */
  function stop(id = activeConversationId.value): void {
    controllers.get(id)?.abort();
    const repair = repairs.get(id);
    if (repair) repair.execute = false;
  }

  return {
    messages,
    conversations,
    activeConversationId,
    isRunning,
    runningConversationId,
    runningConversationIds,
    drafts,
    setDraft,
    setConversationOptions,
    errorMessage,
    hasMessages,
    memoryState,
    refreshMemory,
    changeMemory,
    loadProject,
    createConversation,
    selectConversation,
    setExecutionStrategy,
    deleteConversation,
    persistConversations,
    sendMessage,
    executeProposal,
    executePlan,
    rejectPlan,
    rollbackProposal,
    answerChoicePrompt,
    stop
  };
});

export type AiAssistantStore = ReturnType<typeof useOwnerStore>;

// 宿主 Pinia 的同名 store 会跨插件重载保留；插件实例独立持有，避免新界面调用旧版本 action。
const ownerPinia = createPinia();

export function useAiAssistantStore(): AiAssistantStore {
  return detachedSession?.store ?? useOwnerStore(ownerPinia);
}
