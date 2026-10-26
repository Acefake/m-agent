<template>
  <AssistantFrame v-slot="{ floating, toggle, busy }">
    <section
      class="ai-panel"
      :class="{ 'is-floating': floating }"
    >
      <div
        v-if="!floating"
        class="ai-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        @pointerdown="startPanelResize"
      />
      <ConversationSidebar
        v-if="!sidebarCollapsed"
        :floating="floating"
        :conversations="store.conversations"
        :active-id="store.activeConversationId"
        :running-ids="store.runningConversationIds"
        :active-section="settingsVisible ? settingsSection : undefined"
        @select="selectConversation"
        @delete="deleteConversation"
        @create="createConversation"
        @settings="openSettings"
      />
      <div
        v-show="!settingsVisible"
        class="ai-panel__chat"
        :class="{ 'is-empty': !store.hasMessages }"
      >
        <header
          class="ai-panel__bar"
          :class="{ 'is-quiet': floating && !store.hasMessages }"
        >
          <button
            class="ai-icon-btn ai-panel__sidebar-toggle"
            :class="{ 'is-collapsed': sidebarCollapsed }"
            type="button"
            :title="sidebarCollapsed ? '展开会话列表' : '收起会话列表'"
            :aria-label="sidebarCollapsed ? '展开会话列表' : '收起会话列表'"
            :aria-expanded="!sidebarCollapsed"
            @click="toggleSidebar"
          >
            <AiIcon :icon="ICONS['chevron-right']" />
          </button>
          <span
            class="ai-panel__topic"
            v-if="!floating || store.hasMessages"
            :title="topicTitle"
          >
            {{ conversationTopic }}
          </span>
          <div class="ai-panel__actions">
            <button
              class="ai-icon-btn ai-panel__presentation"
              type="button"
              :disabled="busy"
              :title="floating ? '停靠右侧' : '独立窗口'"
              :aria-label="floating ? '停靠右侧' : '独立窗口'"
              @click="toggle"
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                aria-hidden="true"
              >
                <rect
                  x="3"
                  y="3"
                  width="18"
                  height="18"
                  rx="2"
                />
                <path :d="floating ? 'M15 3v18' : 'M8 16 16 8M9 8h7v7'" />
              </svg>
            </button>
          </div>
        </header>

        <div
          ref="messagesRef"
          class="ai-panel__scroll"
          @scroll.passive="handleScroll"
        >
          <div
            v-if="!store.messages.length"
            class="ai-welcome"
          >
            <h1 class="ai-welcome__title">M-Design，帮你建模</h1>
            <div
              class="ai-welcome__modes"
              role="group"
              aria-label="建模场景"
            >
              <button
                v-for="mode in welcomeModes"
                :key="mode.label"
                type="button"
                :class="{ 'is-active': welcomeMode === mode.label }"
                :aria-pressed="welcomeMode === mode.label"
                @click="welcomeMode = mode.label"
              >
                <AiIcon :icon="mode.icon" />
                {{ mode.label }}
              </button>
            </div>
          </div>

          <MessageItem
            v-for="(message, index) in store.messages"
            :key="message.id"
            :message="message"
            :streaming="
              store.isRunning && store.runningConversationId === store.activeConversationId && index === store.messages.length - 1
            "
            @execute-proposal="handleExecuteProposal"
            @execute-plan="handleExecutePlan"
            @reject-plan="handleRejectPlan"
            @rollback-proposal="handleRollbackProposal"
            @answer-choice="handleAnswerChoice"
          />

          <p
            v-if="store.errorMessage"
            class="ai-panel__error"
          >
            {{ store.errorMessage }}
          </p>
        </div>

        <div
          v-if="chatMemoryStatus"
          class="ai-chat-memory"
          :class="{ 'is-remembering': store.memoryState.status === 'extracting', 'is-error': !!store.memoryState.error }"
          role="status"
          aria-live="polite"
        >
          <button
            type="button"
            class="ai-chat-memory__action"
            @click="openSettings('memory')"
          >
            <AiIcon
              class="ai-chat-memory__icon"
              :icon="ICONS.brain"
            />
            <span>{{ chatMemoryStatus }}</span>
          </button>
          <span class="ai-chat-memory__label">后台记忆</span>
        </div>

        <footer
          class="ai-composer"
          :class="{ 'has-scroll-action': store.messages.length }"
        >
          <div
            v-if="!store.hasMessages"
            class="ai-composer__quick"
            aria-label="快捷建模"
          >
            <button
              v-for="prompt in quickPrompts"
              :key="prompt.label"
              type="button"
              @click="fillStarterPrompt(prompt.text)"
            >
              {{ prompt.label }}
            </button>
          </div>
          <button
            v-if="store.messages.length"
            class="ai-panel__scroll-bottom"
            type="button"
            title="滚动到底部"
            aria-label="滚动到底部"
            @click="jumpToBottom"
          >
            <AiIcon :icon="ICONS['chevron-down']" />
          </button>
          <div
            class="ai-composer__box"
            @dragover.prevent
            @drop.prevent="handleDrop"
          >
            <div
              v-if="attachments.length || attachmentNotice"
              class="ai-composer__files"
            >
              <div
                v-for="attachment in attachments"
                :key="attachment.id"
                class="ai-composer__file"
                :class="{ 'is-image': attachment.kind === 'image' }"
                :title="attachment.name"
              >
                <img
                  v-if="attachment.kind === 'image' && attachment.dataUrl"
                  class="ai-composer__file-thumb"
                  :src="attachment.dataUrl"
                  :alt="attachment.name"
                />
                <AiIcon
                  v-else
                  class="ai-composer__file-icon"
                  :icon="ICONS['file-text']"
                />
                <span class="ai-composer__file-name">{{ attachment.name }}</span>
                <span class="ai-composer__file-size">{{ formatAttachmentSize(attachment.size) }}</span>
                <button
                  class="ai-composer__file-remove"
                  type="button"
                  title="移除附件"
                  aria-label="移除附件"
                  @click="removeAttachment(attachment.id)"
                >
                  <AiIcon :icon="ICONS.x" />
                </button>
              </div>
              <p
                v-if="attachmentNotice"
                class="ai-composer__notice"
              >
                {{ attachmentNotice }}
              </p>
              <p
                v-if="visionHint"
                class="ai-composer__notice ai-composer__notice--hint"
              >
                {{ visionHint }}
              </p>
            </div>

            <div
              ref="inputRef"
              class="ai-composer__input"
              contenteditable="true"
              role="textbox"
              aria-multiline="true"
              data-placeholder="今天想构建什么？ @ 引用模型，/ 调用技能"
              @input="handleInput"
              @click="handleSkillTokenClick"
              @keydown="handleComposerKeydown"
              @paste="handlePaste"
            ></div>
            <div
              v-if="mentionVisible"
              class="ai-mention"
            >
              <template v-if="mentionMode === 'actions'">
                <p class="ai-mention__heading">添加</p>
                <button
                  class="ai-mention__item ai-mention__action"
                  type="button"
                  @mousedown.prevent="openMentionNodePicker"
                >
                  <span class="ai-mention__title">选择节点</span>
                </button>
              </template>
            </div>
            <div
              v-if="skillMenuVisible"
              class="ai-mention"
            >
              <p class="ai-mention__heading">技能</p>
              <button
                v-for="skill in skillCandidates"
                :key="skill.id"
                class="ai-mention__item ai-mention__action"
                type="button"
                @mousedown.prevent="insertSkill(skill)"
              >
                <span class="ai-mention__title">/{{ skill.name }}</span>
                <span class="ai-mention__hint">{{ skill.description || (skill.enabled ? "默认启用" : "单轮启用") }}</span>
              </button>
              <template v-if="skillPresets.length">
                <p class="ai-mention__heading">内置技能（点选后本轮生效）</p>
                <button
                  v-for="preset in skillPresets"
                  :key="preset.name"
                  class="ai-mention__item ai-mention__action"
                  type="button"
                  @mousedown.prevent="insertPresetSkill(preset)"
                >
                  <span class="ai-mention__title">/{{ preset.name }}</span>
                  <span class="ai-mention__hint">{{ preset.description }}</span>
                </button>
              </template>
              <p
                v-if="!skillCandidates.length && !skillPresets.length"
                class="ai-mention__empty"
              >
                {{ skills.length ? "没有匹配的技能" : "还没有配置技能" }}
              </p>
              <button
                class="ai-mention__item ai-mention__action"
                type="button"
                @mousedown.prevent="openSkillSettings"
              >
                <span class="ai-mention__title">管理技能</span>
                <span class="ai-mention__hint">默认启用 / 单轮启用</span>
              </button>
            </div>
            <input
              ref="fileInputRef"
              class="ai-composer__file-input"
              type="file"
              multiple
              :accept="ATTACHMENT_ACCEPT"
              @change="handleFileInput"
            />
            <div class="ai-composer__actions">
              <ComposerAddMenu
                :skills="menuSkills"
                :strategy="executionStrategy"
                :disabled="store.isRunning"
                @open="prepareAddMenu"
                @file="openFilePicker"
                @skill="addMenuSkill"
                @expert="store.setExecutionStrategy"
                @manage="openSettings"
              />
              <button
                class="ai-composer__chip ai-composer__model"
                :class="{ 'is-open': modelMenuOpen }"
                type="button"
                :title="activeProfile?.model ?? '选择模型'"
                @click="toggleModelMenu"
              >
                <BrandLogo
                  v-if="activeProfile"
                  class="ai-composer__logo"
                  :name="brandSourceOf(activeProfile.model)"
                  brand-color
                />
                <span class="ai-composer__chip-value">{{ activeProfile?.model ?? "选择模型" }}</span>
                <AiIcon
                  class="ai-composer__chip-caret"
                  :icon="ICONS['chevron-down']"
                />
              </button>
              <button
                v-if="store.isRunning"
                class="ai-composer__submit"
                type="button"
                title="停止"
                aria-label="停止"
                @click="store.stop()"
              >
                <AiIcon :icon="ICONS.square" />
              </button>
              <button
                v-else
                class="ai-composer__submit"
                type="button"
                :disabled="!canSend"
                title="发送"
                aria-label="发送"
                @click="handleSend"
              >
                <AiIcon :icon="ICONS['arrow-up']" />
              </button>
            </div>
          </div>

          <div class="ai-composer__meta">
            <div class="ai-composer__mode-options">
            <button
              class="ai-composer__chip ai-composer__chip--mode"
              :class="{ 'is-open': permissionMenuOpen }"
              type="button"
              :title="permissionHint"
              @click="togglePermissionMenu"
            >
              <AiIcon
                class="ai-composer__chip-icon"
                :icon="permissionChipIcon"
              />
              <span class="ai-composer__chip-value">{{ permissionLabel }}模式</span>
              <AiIcon
                class="ai-composer__chip-caret"
                :icon="ICONS['chevron-down']"
              />
            </button>

            <ExpertTeamSelector
              :strategy="executionStrategy"
              :disabled="store.isRunning && store.runningConversationId === store.activeConversationId"
              @select="store.setExecutionStrategy"
            />
            </div>
            <SessionStatistics
              v-if="store.hasMessages"
              class="ai-panel__statistics"
              compact
              :running="store.isRunning"
              :messages="store.messages"
              :context-length="contextLimit"
              :model="activeProfile?.model"
              :conversation-id="store.activeConversationId"
            />
            <span v-else class="ai-composer__spacer" />

            <button
              class="ai-composer__chip ai-composer__effort"
              :class="{ 'is-open': effortMenuOpen }"
              type="button"
              title="推理强度"
              @click="toggleEffortMenu"
            >
              <span class="ai-composer__chip-label">Effort</span>
              <span class="ai-composer__chip-value">{{ effortLabel }}</span>
            </button>



            <div
              v-if="modelMenuOpen || effortMenuOpen || permissionMenuOpen"
              class="ai-popover-mask"
              @click="closeMenus"
            />

            <div
              v-if="modelMenuOpen"
              class="ai-popover ai-popover--model"
            >
              <!-- 左侧机架：收藏 + 每个服务一个标识；点选即筛选右侧模型册 -->
              <div class="ai-model-rail">
                <button
                  v-for="rail in modelRail"
                  :key="rail.id"
                  class="ai-model-rail__item"
                  :class="{ 'is-active': rail.id === modelRailId }"
                  type="button"
                  :title="rail.label"
                  :aria-label="rail.label"
                  @click="selectModelRail(rail.id)"
                >
                  <AiIcon
                    v-if="!rail.profile"
                    :icon="ICONS.star"
                  />
                  <!-- 机架标识代表"服务"：官方 logo 用原生品牌色；未收录的服务只显示首字母文字 -->
                  <BrandLogo
                    v-else
                    :name="rail.label"
                    brand-color
                  />
                </button>
              </div>

              <div class="ai-model-main">
                <label class="ai-popover__search">
                  <AiIcon :icon="ICONS.search" />
                  <input
                    v-model="modelQuery"
                    type="text"
                    placeholder="搜索模型"
                  />
                </label>

                <div class="ai-popover__list">
                  <p
                    v-if="modelLoading && !modelRows.length"
                    class="ai-popover__empty"
                  >
                    正在获取模型列表…
                  </p>

                  <template v-else-if="modelRows.length">
                    <div
                      v-for="row in modelRows"
                      :key="row.key"
                      class="ai-model-row"
                      :class="{ 'is-active': isCurrentModel(row) }"
                      role="button"
                      tabindex="0"
                      :title="row.info.id"
                      @click="selectModel(row.profile, row.info)"
                      @keydown.enter.prevent="selectModel(row.profile, row.info)"
                      @keydown.space.prevent="selectModel(row.profile, row.info)"
                    >
                      <span class="ai-model-row__text">
                        <span class="ai-model-row__name">{{ row.info.name || row.info.id }}</span>
                        <span class="ai-model-row__provider">
                          <!-- 行内图标标识"模型厂商"（原生品牌色），文字是所属服务 -->
                          <BrandLogo
                            class="ai-model-row__logo"
                            :name="brandSourceOf(row.info.id)"
                            brand-color
                          />
                          <span class="ai-model-row__provider-name">{{ providerLabelOf(row.profile) }}</span>
                        </span>
                      </span>

                      <span
                        v-if="formatContextLength(row.info.contextLength)"
                        class="ai-model-row__meta"
                      >
                        {{ formatContextLength(row.info.contextLength) }}
                      </span>

                      <span
                        v-if="favoriteSlotOf(row)"
                        class="ai-kbd ai-model-row__slot"
                        :title="`Ctrl+${favoriteSlotOf(row)} 快速切换`"
                      >
                        Ctrl+{{ favoriteSlotOf(row) }}
                      </span>

                      <button
                        class="ai-model-row__star"
                        :class="{ 'is-on': isRowFavorite(row) }"
                        type="button"
                        :title="isRowFavorite(row) ? '取消收藏' : '收藏'"
                        :aria-label="isRowFavorite(row) ? '取消收藏' : '收藏'"
                        @click.stop="toggleRowFavorite(row)"
                      >
                        <AiIcon :icon="ICONS.star" />
                      </button>
                    </div>
                  </template>

                  <div
                    v-else
                    class="ai-model-empty"
                  >
                    <p class="ai-model-empty__title">{{ modelEmptyTitle }}</p>
                    <p
                      v-if="modelEmptyHint"
                      class="ai-model-empty__hint"
                    >
                      {{ modelEmptyHint }}
                    </p>
                    <button
                      v-if="modelEmptyAction"
                      class="ai-model-btn"
                      type="button"
                      @click="modelEmptyAction.onClick()"
                    >
                      {{ modelEmptyAction.label }}
                    </button>
                  </div>

                  <p
                    v-if="modelRailError && modelRows.length"
                    class="ai-model-error"
                  >
                    {{ modelRailError }}
                  </p>
                </div>
              </div>
            </div>

            <div
              v-if="permissionMenuOpen"
              class="ai-popover ai-popover--mode"
            >
              <button
                v-for="option in AI_PERMISSION_MODES"
                :key="option.value"
                class="ai-popover__item ai-popover__item--mode"
                :class="{ 'is-active': option.value === permissionMode }"
                type="button"
                @click="selectPermissionMode(option.value)"
              >
                <AiIcon
                  class="ai-popover__icon"
                  :icon="PERMISSION_MODE_ICONS[option.value]"
                />
                <span class="ai-popover__content">
                  <span class="ai-popover__name">{{ option.label }}模式</span>
                  <span class="ai-popover__hint">{{ option.description }}</span>
                </span>
                <AiIcon
                  v-if="option.value === permissionMode"
                  class="ai-popover__check"
                  :icon="ICONS.check"
                />
              </button>
            </div>

            <div
              v-if="effortMenuOpen"
              class="ai-popover ai-popover--effort"
            >
              <button
                v-for="option in AI_EFFORT_OPTIONS"
                :key="option.value"
                class="ai-popover__item"
                :class="{ 'is-active': option.value === (activeProfile?.effort ?? '') }"
                type="button"
                @click="selectEffort(option.value)"
              >
                <span class="ai-popover__name">{{ option.label }}</span>
              </button>
            </div>

          </div>
        </footer>
        <div
          v-if="!store.hasMessages"
          class="ai-starters"
          aria-label="建模任务建议"
        >
          <button
            v-for="prompt in starterPrompts"
            :key="prompt"
            type="button"
            @click="fillStarterPrompt(prompt)"
          >
            <span>{{ prompt }}</span>
            <AiIcon :icon="ICONS['arrow-up']" />
          </button>
        </div>
        <p
          v-if="!store.hasMessages"
          class="ai-panel__footnote"
        >
          AI 辅助建模，请核对模型语义与执行结果
        </p>
      </div>

      <AiSettings
        @section-change="settingsSection = $event"
        @select-expert="selectExpert"
        v-model="settingsVisible"
        :initial-section="settingsSection"
        @saved="handleSettingsSaved"
        @create-skill="startSkillCreation"
        @create-expert="startExpertCreation"
      />
    </section>
  </AssistantFrame>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import "../../../host/host-setup";
import { describeAiError } from "../../../ai-assistant/ai-error";
import { tryGetAiAssistantHost, type AiModelMention } from "../../../ai-assistant/host";
import { brandSourceOf } from "./brands";
import { ICONS, type IconData } from "./icons";
import type { AiModelInfo } from "../../../ai-assistant/provider/models";
import { fetchProviderModels } from "../../../ai-assistant/provider/models";
import {
  AI_EFFORT_OPTIONS,
  AI_PERMISSION_MODES,
  AI_SKILL_PRESETS,
  FAVORITE_SLOTS,
  favoriteModelKey,
  getActiveProfile,
  getPermissionMode,
  isFavoriteModel,
  loadAiProviderSettings,
  parseFavoriteModelKey,
  toggleFavoriteModel,
  updateAiProviderSettings
} from "../../../ai-assistant/provider/providerConfig";
import { useAiAssistantStore } from "../../../ai-assistant/conversation/store";
import {
  ATTACHMENT_ACCEPT,
  MAX_FILES_PER_MESSAGE,
  collectAttachments,
  formatAttachmentSize
} from "../../../ai-assistant/conversation/attachments";
import { createSkill, extractSkills } from "../../../ai-assistant/skills";
import type {
  AiAttachment,
  AiPermissionMode,
  AiProviderProfile,
  AiProviderSettings,
  AiSettingsSection,
  AiExecutionStrategy,
  AiSkill
} from "../../../ai-assistant/types";
import { likelyVisionModel } from "../../../ai-assistant/provider/vendor";
import AiIcon from "./AiIcon.vue";
import SessionStatistics from "./SessionStatistics.vue";
import AiSettings from "./AiSettings.vue";
import ExpertTeamSelector from "./ExpertTeamSelector.vue";
import ComposerAddMenu from "./ComposerAddMenu.vue";
import BrandLogo from "./BrandLogo.vue";
import MessageItem from "./MessageItem.vue";
import ConversationSidebar from "./ConversationSidebar.vue";
import AssistantFrame from "./AssistantFrame.vue";
import { chatMentionQueue, drainChatMentions } from "../../../presentation/chat-context";
import { detachedSession, publishDraft, registerDraftAccess, SETTINGS_CHANGED } from "../../../presentation/window-session";

const store = useAiAssistantStore();
const showMemorySaved = ref(false);
watch(
  [() => store.memoryState.status, () => store.activeConversationId],
  ([status], [previousStatus], onCleanup) => {
    showMemorySaved.value = status === "saved" && previousStatus !== "saved";
    if (!showMemorySaved.value) return;
    const timer = setTimeout(() => {
      showMemorySaved.value = false;
    }, 3000);
    onCleanup(() => clearTimeout(timer));
  },
  { flush: "sync" }
);
const chatMemoryStatus = computed(() => {
  const memory = store.memoryState;
  if (memory.error) return memory.error;
  if (!memory.enabled) return "";
  if (memory.status === "extracting") return "记忆中…";
  if (memory.status === "saved" && showMemorySaved.value) return "记忆已保存";
  return "";
});
const welcomeModes = [
  { label: "结构建模", icon: ICONS.layers },
  { label: "需求分析", icon: ICONS["file-text"] },
  { label: "模型检查", icon: ICONS["file-check"] }
];
const welcomeMode = ref("结构建模");
const starterPrompts = computed(() => {
  if (welcomeMode.value === "需求分析")
    return ["梳理当前项目中的需求层次与依赖关系", "分析哪些需求还没有对应的设计元素", "为一个智能家居系统整理功能需求"];
  if (welcomeMode.value === "模型检查")
    return ["检查当前模型的结构与关系，指出需要完善的地方", "解释当前画布上的元素与连接关系", "整理当前图表布局，让关系更容易阅读"];
  return [
    "创建一个电脑系统模型，包含处理器、内存和存储",
    "为当前模型生成模块定义图，并连接对应关系",
    "分析当前模型的组成结构，给出建模建议"
  ];
});
const quickPrompts = [
  { label: "模块定义图", text: "为当前系统创建模块定义图，展示模块及其关系" },
  { label: "部件与关系", text: "分析当前系统的部件组成，并建立对应关系" },
  { label: "模型上图", text: "把当前项目已有的系统模块摆放到图表中，并整理布局" }
];
const input = ref("");
const settingsVisible = ref(false);
/** 停靠时左侧会话栏是否收起，选择随会话保存 */
const SIDEBAR_KEY = "agent.assistant.sidebarCollapsed";
/** 停靠时的面板宽度，选择随会话保存 */
const PANEL_WIDTH_KEY = "agent.assistant.panelWidth";
const PANEL_WIDTH_MIN = 420;
const PANEL_WIDTH_MAX = 1120;
function readStoredFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function clampPanelWidth(value: number): number {
  // 上限还要给画布留出空间，避免在小屏上把主区域挤没
  const max = Math.max(PANEL_WIDTH_MIN, Math.min(PANEL_WIDTH_MAX, window.innerWidth - 560));
  return Math.min(max, Math.max(PANEL_WIDTH_MIN, Math.round(value)));
}
function readStoredWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampPanelWidth(value) : 580;
  } catch {
    return 580;
  }
}
const sidebarCollapsed = ref(readStoredFlag(SIDEBAR_KEY));
const panelWidth = ref(readStoredWidth());
function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  try {
    window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed.value ? "1" : "0");
  } catch {
    /* 存储不可用时仅当前会话生效 */
  }
}
/** 拖拽面板左边缘改宽：宽度定在挂载节点上，宿主栅格列跟随 */
function startPanelResize(event: PointerEvent): void {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startWidth = panelWidth.value;
  const move = (moveEvent: PointerEvent) => {
    panelWidth.value = clampPanelWidth(startWidth - (moveEvent.clientX - startX));
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    try {
      window.localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth.value));
    } catch {
      /* 忽略 */
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
}
watch(panelWidth, value => document.documentElement.style.setProperty("--ai-panel-width", `${value}px`), { immediate: true });
const executionStrategy = computed(
  () => store.conversations.find(conversation => conversation.id === store.activeConversationId)?.strategy ?? "assistant"
);
async function selectExpert(strategy: AiExecutionStrategy): Promise<void> {
  if (store.isRunning) await store.createConversation();
  store.setExecutionStrategy(strategy);
  settingsVisible.value = false;
}
/** 设置面板打开时定位到哪个分区 */
const settingsSection = ref<AiSettingsSection>("providers");
/** 待发送的附件（文件内容 + 降采样后的图片） */
const attachments = ref<AiAttachment[]>([]);
/** 附件相关提示：超出数量、不支持的类型、读取失败 */
const attachmentNotice = ref("");
const fileInputRef = ref<HTMLInputElement>();
/** 输入框里 /xxx 的技能前缀（undefined 表示当前不在选技能） */
const skillQuery = ref<string | undefined>(undefined);
/** 光标前的 /技能名 前缀：弹菜单、插 token、清前缀三处共用同一形态 */
const SKILL_QUERY_TAIL = /(?<![\w/])\/([a-z0-9-]*)$/;
/** 模型选择器左侧机架的收藏页标识（与供应商 id 区分） */
const FAVORITES_RAIL = "__favorites__";

const messagesRef = ref<HTMLDivElement>();
let restoringDraft = false;
const emptyDraft = () => ({ html: "", attachments: [] as AiAttachment[], notice: "", scrollTop: 0 });
const draftAccess = {
  read: () => ({
    conversationId: store.activeConversationId,
    projectId: projectId.value,
    html: inputRef.value?.innerHTML ?? "",
    attachments: attachments.value,
    notice: attachmentNotice.value,
    scrollTop: messagesRef.value?.scrollTop ?? 0
  }),
  write: (draft: ReturnType<typeof emptyDraft>) => {
    restoringDraft = true;
    if (inputRef.value && inputRef.value.innerHTML !== draft.html) inputRef.value.innerHTML = draft.html;
    input.value = serializeInput();
    attachments.value = draft.attachments;
    attachmentNotice.value = draft.notice;
    if (messagesRef.value) messagesRef.value.scrollTop = draft.scrollTop;
    restoringDraft = false;
  }
};
const removeDraftAccess = registerDraftAccess(draftAccess);
watch(
  () => [input.value, attachments.value, attachmentNotice.value],
  () => {
    if (restoringDraft) return;
    const draft = draftAccess.read();
    if (!detachedSession) store.setDraft(store.activeConversationId, draft);
    else store.drafts[store.activeConversationId] = draft;
    publishDraft();
  },
  { deep: true, flush: "sync" }
);
watch(
  () => store.activeConversationId,
  id => {
    draftAccess.write(store.drafts[id] ?? emptyDraft());
    skillQuery.value = undefined;
    mentionMode.value = undefined;
    mentionRange = undefined;
    addMenuRange = undefined;
    closeMenus();
    void nextTick(resizeInput);
  },
  { flush: "sync" }
);
const inputRef = ref<HTMLDivElement>();
const stickToBottom = ref(true);
const providerSettings = ref<AiProviderSettings>(loadAiProviderSettings());
const modelOptions = ref<Record<string, AiModelInfo[]>>({});
const modelErrors = ref<Record<string, string>>({});
const modelLoading = ref(false);
const modelMenuOpen = ref(false);
const effortMenuOpen = ref(false);
const permissionMenuOpen = ref(false);
const modelQuery = ref("");
/** 模型选择器当前机架页：收藏或某个供应商 id */
const modelRailId = ref<string>(FAVORITES_RAIL);
const mentionMode = ref<"actions">();
let mentionRange: Range | undefined;

/** 权限模式图标：聊天气泡 / 待确认清单 / 编辑（Lucide，见同目录 icons.ts） */
const PERMISSION_MODE_ICONS: Record<AiPermissionMode, IconData> = {
  chat: ICONS["message-square-text"],
  proposal: ICONS["file-check"],
  edit: ICONS["square-pen"]
};

const conversationOptions = computed(() => store.conversations.find(item => item.id === store.activeConversationId)?.options);
const activeProfile = computed(() => {
  const options = conversationOptions.value;
  const profile = options?.profileId
    ? providerSettings.value.profiles.find(item => item.id === options.profileId)
    : getActiveProfile(providerSettings.value);
  return profile && options
    ? { ...profile, model: options.model ?? profile.model, effort: options.effort, contextLength: options.contextLength }
    : profile;
});
/** 对话主题取第一条用户消息，便于在头部识别当前会话 */
const firstUserMessage = computed(() => store.messages.find(message => message.role === "user" && message.content)?.content ?? "");
const conversationTopic = computed(() => (firstUserMessage.value ? toTopic(firstUserMessage.value) : "新对话"));
const topicTitle = computed(() => firstUserMessage.value || "新对话");
const projectName = computed(() => tryGetAiAssistantHost()?.getActiveProjectName?.() ?? "");
const projectId = computed(() => tryGetAiAssistantHost()?.getActiveProjectId?.() ?? "");
const effortLabel = computed(() => AI_EFFORT_OPTIONS.find(option => option.value === (activeProfile.value?.effort ?? ""))?.label ?? "默认");
/** 当前权限模式；缺省提案模式（审批模式） */
const permissionMode = computed<AiPermissionMode>(
  () => conversationOptions.value?.permissionMode ?? getPermissionMode(providerSettings.value)
);
const permissionLabel = computed(() => AI_PERMISSION_MODES.find(option => option.value === permissionMode.value)?.label ?? "提案");
const permissionHint = computed(() => AI_PERMISSION_MODES.find(option => option.value === permissionMode.value)?.description ?? "");
/**
 * chip 图标跟随当前模式。
 *
 * 聊天模式是只读态，用盾牌代替气泡：一眼能看出"现在改不了模型"，
 * 其余模式直接复用下拉里的同款图标，避免 chip 与菜单图标不一致。
 */
const permissionChipIcon = computed(() => (permissionMode.value === "chat" ? ICONS.shield : PERMISSION_MODE_ICONS[permissionMode.value]));
/** 只带附件（不写文字）也能发送 */
const canSend = computed(() => (Boolean(input.value.trim()) || attachments.value.length > 0) && !store.isRunning);
const mentionVisible = computed(() => Boolean(mentionMode.value));

/** 已配置的技能；默认启用的常驻注入，其余用 /名称 单轮启用 */
const skills = computed<AiSkill[]>(() => providerSettings.value.skills ?? []);
const menuSkills = computed(() => {
  const configured = new Set(skills.value.map(skill => skill.name));
  return [...skills.value, ...AI_SKILL_PRESETS.filter(skill => !configured.has(skill.name))];
});
let addMenuRange: Range | undefined;

function prepareAddMenu(): void {
  closeMenus();
  skillQuery.value = undefined;
  mentionMode.value = undefined;
  const selection = inputRef.value?.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  addMenuRange = range && inputRef.value?.contains(range.commonAncestorContainer) ? range.cloneRange() : undefined;
}

/** 菜单搜索不会替换用户正文，技能插入打开菜单前的光标位置。 */
function addMenuSkill(name: string): void {
  const element = inputRef.value;
  if (!element) return;
  let skill = skills.value.find(item => item.name === name);
  if (!skill) {
    const preset = AI_SKILL_PRESETS.find(item => item.name === name);
    if (!preset) return;
    skill = createSkill({ ...preset, enabled: false });
    const added = skill;
    providerSettings.value = updateAiProviderSettings(settings => {
      settings.skills = [...(settings.skills ?? []), added];
    });
  }
  const range = addMenuRange && element.contains(addMenuRange.commonAncestorContainer) ? addMenuRange : element.ownerDocument.createRange();
  if (range !== addMenuRange) {
    range.selectNodeContents(element);
    range.collapse(false);
  }
  range.deleteContents();
  const fragment = element.ownerDocument.createDocumentFragment();
  const spacer = element.ownerDocument.createTextNode(" ");
  fragment.append(element.ownerDocument.createTextNode(" "), createSkillToken(skill), spacer);
  range.insertNode(fragment);
  range.setStartAfter(spacer);
  range.collapse(true);
  element.focus();
  const selection = element.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  addMenuRange = undefined;
  input.value = serializeInput();
  resizeInput();
}

/** 输入 / 前缀后展示的技能候选（限制 5 条，避免菜单过长） */
const skillCandidates = computed(() => {
  const query = skillQuery.value;
  if (query === undefined) return [];
  return skills.value.filter(skill => skill.name.startsWith(query)).slice(0, 5);
});
/** 敲了 / 就弹：没有候选时也给"还没有技能/去设置"的快捷提示，不能毫无反馈 */
const skillMenuVisible = computed(() => skillQuery.value !== undefined);
/**
 * 菜单里的内置技能建议：还没配置过、且匹配当前前缀的预设。
 *
 * 开箱可用——不用先去设置里建技能；点选后按"加入并用于本轮"处理（见 insertPresetSkill）。
 */
const skillPresets = computed(() => {
  if (skillQuery.value === undefined) return [];
  const configured = new Set(skills.value.map(skill => skill.name));
  return AI_SKILL_PRESETS.filter(preset => !configured.has(preset.name) && preset.name.startsWith(skillQuery.value!)).slice(0, 5);
});
/** 附加了图片但模型名不像视觉模型时提示一句（不阻断发送） */
const visionHint = computed(() => {
  if (!attachments.value.some(attachment => attachment.kind === "image")) return "";
  const model = activeProfile.value?.model ?? "";
  return model && !likelyVisionModel(model) ? `${model} 可能不支持图片输入，图片会被忽略或导致请求失败` : "";
});
/** 手动配置优先；已有配置缺失窗口大小时从当前模型规格自动补齐。 */
const contextLimit = computed(() => {
  const profile = activeProfile.value;
  return (
    profile?.contextLength ??
    (profile ? modelOptions.value[profile.id]?.find(model => model.id === profile.model)?.contextLength : undefined)
  );
});
/** 服务标签：名称优先；未命名时退回模型 id */
function providerLabelOf(profile: AiProviderProfile): string {
  return profile.name || profile.model || "未命名";
}

/** 某供应商当前可选的模型；指定模型模式只暴露选中的那一个 */
function modelsOf(profile: AiProviderProfile): AiModelInfo[] {
  const available = modelOptions.value[profile.id] ?? [];
  if (profile.modelMode !== "single" || !profile.model) return available;

  return available.some(info => info.id === profile.model) ? available.filter(info => info.id === profile.model) : [{ id: profile.model }];
}

/** 按 id 取模型信息；列表里查不到时回退成只有 id 的占位 */
function modelInfoOf(profile: AiProviderProfile, modelId: string): AiModelInfo {
  return modelsOf(profile).find(info => info.id === modelId) ?? { id: modelId };
}

/** 收藏项解析：只保留仍存在的供应商，被删掉的条目直接丢弃 */
const favoriteEntries = computed(() =>
  (providerSettings.value.favoriteModels ?? []).flatMap(key => {
    const parsed = parseFavoriteModelKey(key);
    const profile = parsed && providerSettings.value.profiles.find(item => item.id === parsed.profileId);
    return parsed && profile ? [{ key, profile, modelId: parsed.modelId }] : [];
  })
);

/** 左侧机架：收藏页 + 每个服务一个标识 */
const modelRail = computed(() => [
  { id: FAVORITES_RAIL, label: "收藏", profile: undefined as AiProviderProfile | undefined },
  ...providerSettings.value.profiles.map(profile => ({
    id: profile.id,
    label: providerLabelOf(profile),
    profile: profile as AiProviderProfile | undefined
  }))
]);

/** 当前机架页下的模型行：平铺列表，每行自带服务归属 */
const modelRows = computed(() => {
  const query = modelQuery.value.trim().toLowerCase();
  const match = (info: AiModelInfo) => !query || info.id.toLowerCase().includes(query) || (info.name ?? "").toLowerCase().includes(query);

  if (modelRailId.value === FAVORITES_RAIL) {
    return favoriteEntries.value
      .map(entry => ({ key: entry.key, profile: entry.profile, info: modelInfoOf(entry.profile, entry.modelId) }))
      .filter(row => match(row.info));
  }

  const profile = providerSettings.value.profiles.find(item => item.id === modelRailId.value);
  if (!profile) return [];

  return modelsOf(profile)
    .filter(match)
    .map(info => ({ key: favoriteModelKey(profile.id, info.id), profile, info }));
});

/** 当前机架页的加载错误：只有供应商页才有 */
const modelRailError = computed(() => (modelRailId.value === FAVORITES_RAIL ? "" : (modelErrors.value[modelRailId.value] ?? "")));

/** 收藏槽位号（Ctrl+N 的 N）：未收藏或超出槽位上限时为 0 */
function favoriteSlotOf(row: { profile: AiProviderProfile; info: AiModelInfo }): number {
  const index = favoriteEntries.value.findIndex(entry => entry.key === favoriteModelKey(row.profile.id, row.info.id));
  return index >= 0 && index < FAVORITE_SLOTS ? index + 1 : 0;
}

function isRowFavorite(row: { profile: AiProviderProfile; info: AiModelInfo }): boolean {
  return isFavoriteModel(providerSettings.value, row.profile.id, row.info.id);
}

function isCurrentModel(row: { profile: AiProviderProfile; info: AiModelInfo }): boolean {
  return row.profile.id === activeProfile.value?.id && activeProfile.value.model === row.info.id;
}

/** 空状态文案：区分"没配置服务 / 没收藏 / 没匹配 / 该服务没可用模型" */
const modelEmptyTitle = computed(() => {
  if (!providerSettings.value.profiles.length) return "还没有配置供应商";
  if (modelQuery.value.trim()) return "没有匹配的模型";
  if (modelRailId.value === FAVORITES_RAIL) return "还没有收藏的模型";
  return modelRailError.value ? "模型列表获取失败" : "这个服务还没有可用模型";
});

const modelEmptyHint = computed(() => {
  if (!providerSettings.value.profiles.length) return "添加供应商后才能选择模型。";
  if (modelQuery.value.trim()) return "";
  if (modelRailId.value === FAVORITES_RAIL) return "点模型行右侧的星标即可收藏；打开选择器时用 Ctrl+1–9 直接切换。";
  return modelRailError.value;
});

const modelEmptyAction = computed<{ label: string; onClick: () => void } | undefined>(() => {
  if (!providerSettings.value.profiles.length) return { label: "配置供应商", onClick: () => openSettings("providers") };
  if (modelRailError.value || modelRailId.value !== FAVORITES_RAIL) {
    return { label: "重新获取模型列表", onClick: () => void loadModels(true) };
  }

  return undefined;
});

/** 切机架页：重置搜索，并顺手拉一次还没加载过的服务 */
function selectModelRail(id: string): void {
  modelRailId.value = id;
  modelQuery.value = "";
  if (id !== FAVORITES_RAIL && !modelOptions.value[id]) void loadModels(false);
}

/** 收藏 / 取消收藏：写回设置，槽位号即收藏数组的序号 */
function toggleRowFavorite(row: { profile: AiProviderProfile; info: AiModelInfo }): void {
  providerSettings.value = toggleFavoriteModel(row.profile.id, row.info.id);
}

onMounted(() => {
  store.loadProject(projectId.value);
  void loadModels(false);
  // 面板可能尚未挂载（用户点“添加到聊天”时才首次打开）：挂载时把队列里的节点补进输入区
  drainPendingChatMentions();
  draftAccess.write(store.drafts[store.activeConversationId] ?? detachedSession?.draft ?? emptyDraft());
  window.addEventListener(SETTINGS_CHANGED, reloadWindowSettings);
});

onBeforeUnmount(() => {
  removeDraftAccess();
  window.removeEventListener(SETTINGS_CHANGED, reloadWindowSettings);
  store.persistConversations();
  window.removeEventListener("keydown", handleMenuKeydown);
});

function reloadWindowSettings(): void {
  providerSettings.value = loadAiProviderSettings();
  void loadModels(false);
}

// “AI 建模助手 → 添加到聊天”入队后立即落地（面板已挂载时）
watch(chatMentionQueue, () => drainPendingChatMentions());

watch(projectId, id => {
  store.loadProject(id);
  draftAccess.write(store.drafts[store.activeConversationId] ?? emptyDraft());
});

watch([modelMenuOpen, effortMenuOpen, permissionMenuOpen], ([modelOpen, effortOpen, permissionOpen]) => {
  if (modelOpen || effortOpen || permissionOpen) window.addEventListener("keydown", handleMenuKeydown);
  else window.removeEventListener("keydown", handleMenuKeydown);
});

/**
 * 弹层按键：Esc 关闭；模型选择器打开期间 Ctrl+1–9 直接切到第 N 个收藏。
 *
 * 只在弹层打开期间监听，避免与宿主的全局快捷键抢键。
 */
function handleMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeMenus();
    return;
  }

  if (!modelMenuOpen.value || !(event.ctrlKey || event.metaKey) || !/^[1-9]$/.test(event.key)) return;

  const entry = favoriteEntries.value[Number(event.key) - 1];
  if (!entry) return;

  event.preventDefault();
  selectModel(entry.profile, modelInfoOf(entry.profile, entry.modelId));
}

/** 拉取所有已配置供应商的模型列表（命中缓存时几乎无开销） */
async function loadModels(refresh: boolean): Promise<void> {
  const profiles = providerSettings.value.profiles;
  if (!profiles.length) return;

  modelLoading.value = true;

  await Promise.all(
    profiles.map(async profile => {
      try {
        modelOptions.value[profile.id] = await fetchProviderModels(profile, { refresh });
        delete modelErrors.value[profile.id];
      } catch (error) {
        modelOptions.value[profile.id] = [];
        modelErrors.value[profile.id] = describeAiError(error) || "获取模型列表失败";
      }
    })
  );

  modelLoading.value = false;
}

function toggleModelMenu(): void {
  modelMenuOpen.value = !modelMenuOpen.value;
  effortMenuOpen.value = false;
  permissionMenuOpen.value = false;
  modelQuery.value = "";

  if (!modelMenuOpen.value) return;

  // 默认落在收藏页（有收藏时），否则落在当前服务；键盘用户开面板即可 Ctrl+1 试
  modelRailId.value = favoriteEntries.value.length ? FAVORITES_RAIL : activeProfile.value?.id || FAVORITES_RAIL;
  if (!modelOptions.value.length) void loadModels(true);
}

function toggleEffortMenu(): void {
  effortMenuOpen.value = !effortMenuOpen.value;
  modelMenuOpen.value = false;
  permissionMenuOpen.value = false;
}

function togglePermissionMenu(): void {
  permissionMenuOpen.value = !permissionMenuOpen.value;
  modelMenuOpen.value = false;
  effortMenuOpen.value = false;
}

function closeMenus(): void {
  modelMenuOpen.value = false;
  effortMenuOpen.value = false;
  permissionMenuOpen.value = false;
}

/** 切换权限模式：写入设置，下一轮对话生效 */
function selectPermissionMode(mode: AiPermissionMode): void {
  store.setConversationOptions({ permissionMode: mode });
  closeMenus();
}

function selectModel(profile: AiProviderProfile, info: AiModelInfo): void {
  store.setConversationOptions({ profileId: profile.id, model: info.id, contextLength: info.contextLength, effort: profile.effort });
  closeMenus();
}

function selectEffort(value: string): void {
  store.setConversationOptions({ effort: value });
  closeMenus();
}

function formatContextLength(value?: number): string {
  if (!value) return "";
  if (value >= 1000000) return `${Math.round(value / 100000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return `${value}`;
}

function toTopic(text: string, max = 14): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 打开系统文件选择框（桌面端与浏览器都弹原生对话框） */
function openFilePicker(): void {
  fileInputRef.value?.click();
}

/** 文件选择框回调：取完文件立刻清空 value，保证同一个文件可以再次选择 */
function handleFileInput(event: Event): void {
  const inputElement = event.target as HTMLInputElement;
  const files = Array.from(inputElement.files ?? []);
  inputElement.value = "";
  if (files.length) void addFiles(files);
}

/** 拖入输入区的文件走与选择文件相同的入口 */
function handleDrop(event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) void addFiles(files);
}

/** 粘贴：剪贴板里有图片就转成附件并阻止默认粘贴；纯文本保持浏览器原行为 */
function handlePaste(event: ClipboardEvent): void {
  const images = Array.from(event.clipboardData?.items ?? [])
    .filter(item => item.kind === "file" && item.type.startsWith("image/"))
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file);
  if (!images.length) return;

  event.preventDefault();
  void addFiles(images);
}

/** 收下文件：按类型分发到文本读取或图片降采样，超限与不支持的类型给出提示 */
async function addFiles(files: File[]): Promise<void> {
  if (!store.activeConversationId) await store.createConversation();
  const originId = store.activeConversationId;
  const originProject = projectId.value;
  attachmentNotice.value = "";

  const remaining = MAX_FILES_PER_MESSAGE - attachments.value.length;
  if (remaining <= 0) {
    attachmentNotice.value = `单条消息最多 ${MAX_FILES_PER_MESSAGE} 个附件`;
    return;
  }

  const { attachments: added, rejected } = await collectAttachments(files, remaining);
  if (projectId.value !== originProject) return;
  const draft = store.drafts[originId] ?? emptyDraft();
  const updated = {
    ...draft,
    conversationId: originId,
    projectId: originProject,
    attachments: [...draft.attachments, ...added].slice(0, MAX_FILES_PER_MESSAGE),
    notice: rejected.map(item => `${item.name}：${item.reason}`).join("；")
  };
  store.setDraft(originId, updated);
  if (store.activeConversationId === originId) {
    draftAccess.write(updated);
    publishDraft();
  }
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter(attachment => attachment.id !== id);
  attachmentNotice.value = "";
}

/**
 * 光标前是不是 /xxx 形式的技能调用；undefined 表示当前不在选技能。
 *
 * 只排除紧跟在单词字符或斜杠后面的情况（路径 src/renderer、URL http://、分数 3/4 都不弹），
 * 中文句子里的「帮我/」要能弹出来，所以不能用"必须前面是空格"的判定。
 */
function getSkillQuery(): string | undefined {
  const cursor = currentTextCaret();
  if (!cursor) return undefined;

  return SKILL_QUERY_TAIL.exec(cursor.text.slice(0, cursor.offset))?.[1];
}

/** 光标所在的文本节点与偏移；不在文本节点上时返回 undefined */
function currentTextCaret(): { text: string; offset: number; node: Text } | undefined {
  const selection = inputRef.value?.ownerDocument.getSelection();
  if (!selection?.rangeCount) return undefined;

  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return undefined;

  return { text: node.textContent ?? "", offset: range.startOffset, node: node as Text };
}

/** 删掉光标前刚敲的 /xxx 前缀（采纳建议、跳去设置时用）；返回是否删掉了内容 */
function removeSkillQuery(): boolean {
  const selection = inputRef.value?.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  const cursor = currentTextCaret();
  if (!range || !cursor) return false;

  const match = SKILL_QUERY_TAIL.exec(cursor.text.slice(0, cursor.offset));
  if (!match) return false;

  range.setStart(cursor.node, cursor.offset - match[0].length);
  range.setEnd(cursor.node, cursor.offset);
  range.deleteContents();
  input.value = serializeInput();
  return true;
}

/**
 * 采纳内置技能建议：写入设置并插入 token。
 *
 * 有意设为"默认不启用"——常驻会把这段指令带进每一轮请求，先让它本轮生效更克制；
 * 想让它每轮都带上，到技能设置里打开开关即可。
 */
function insertPresetSkill(preset: Omit<AiSkill, "id">): void {
  const skill = createSkill({ ...preset, enabled: false });
  providerSettings.value = updateAiProviderSettings(settings => {
    settings.skills = [...(settings.skills ?? []), skill];
  });
  insertSkill(skill);
}

/** 打开设置面板并定位到指定分区 */
function openSettings(section: AiSettingsSection): void {
  settingsSection.value = section;
  settingsVisible.value = true;
}

/** 从技能菜单直接去技能设置：把输入框里刚敲的 / 也一并收掉 */
function openSkillSettings(): void {
  removeSkillQuery();
  skillQuery.value = undefined;
  openSettings("skills");
}

/** 把 /xxx 前缀替换成技能 token；序列化后就是 /name 文本，发送时再解析回技能名 */
function insertSkill(skill: AiSkill): void {
  const selection = inputRef.value?.ownerDocument.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  const cursor = currentTextCaret();
  if (!range || !cursor) return;

  const match = SKILL_QUERY_TAIL.exec(cursor.text.slice(0, cursor.offset));
  if (!match) return;

  range.setStart(cursor.node, cursor.offset - match[0].length);
  range.setEnd(cursor.node, cursor.offset);
  range.deleteContents();

  const fragment = (inputRef.value?.ownerDocument ?? document).createDocumentFragment();
  fragment.append(createSkillToken(skill));
  const spacer = (inputRef.value?.ownerDocument ?? document).createTextNode(" ");
  fragment.append(spacer);
  range.insertNode(fragment);
  range.setStart(spacer, spacer.length);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);

  input.value = serializeInput();
  skillQuery.value = undefined;
  void nextTick(() => {
    inputRef.value?.focus();
    resizeInput();
  });
}

/** 技能 token：不可编辑的整体块，删除键一次删掉 */
function createSkillToken(skill: AiSkill): HTMLSpanElement {
  const token = (inputRef.value?.ownerDocument ?? document).createElement("span");
  token.className = "ai-mention-token ai-mention-token--skill";
  token.contentEditable = "false";
  token.dataset.skillName = skill.name;
  const remove = token.ownerDocument.createElement("button");
  remove.type = "button";
  remove.className = "ai-mention-token__remove";
  remove.setAttribute("aria-label", `移除技能 ${skill.name}`);
  remove.title = `移除技能 ${skill.name}`;
  remove.append(createTokenIcon(ICONS.brain, "ai-skill-token__icon"), createTokenIcon(ICONS.x, "ai-skill-token__close"));
  const title = token.ownerDocument.createElement("span");
  title.textContent = skill.name;
  token.append(remove, title);
  return token;
}

/** 使用现有 Lucide 图标数据构造 SVG，随草稿 HTML 一起跨窗口同步。 */
function createTokenIcon(icon: IconData, className: string): SVGSVGElement {
  const owner = inputRef.value?.ownerDocument ?? document;
  const namespace = "http://www.w3.org/2000/svg";
  const svg = owner.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${icon.size} ${icon.size}`);
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(icon.strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const element of icon.elements) {
    const child = owner.createElementNS(namespace, element.tag);
    for (const [key, value] of Object.entries(element.attrs)) child.setAttribute(key, String(value));
    svg.append(child);
  }
  return svg;
}

/** 使用事件委托，草稿跨窗口同步为 HTML 后仍能移除技能。 */
function handleSkillTokenClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const remove = target?.closest(".ai-mention-token--skill .ai-mention-token__remove");
  const token = remove?.closest<HTMLSpanElement>(".ai-mention-token--skill");
  if (!token || !inputRef.value?.contains(token)) return;
  event.preventDefault();
  removeMentionToken(token);
}

async function handleSend(): Promise<void> {
  const text = input.value.trim();
  const pending = attachments.value;
  if ((!text && !pending.length) || store.isRunning) return;

  const profile = activeProfile.value;
  if (!profile) return;

  const confirmedProfiles = providerSettings.value.dataSharingConfirmedProfileIds ?? [];
  if (!confirmedProfiles.includes(profile.id)) {
    const project = projectName.value || "当前项目";
    const accepted = (inputRef.value?.ownerDocument.defaultView ?? window).confirm(
      `发送后，${project} 的模型结构、元素关系、当前打开的图表信息，以及你上传的文件内容与图片，可能会发送给 ${
        profile.name || profile.baseURL
      }，用于生成回答。是否继续？`
    );
    if (!accepted) return;

    providerSettings.value = updateAiProviderSettings(settings => {
      const confirmed = settings.dataSharingConfirmedProfileIds ?? [];
      if (!confirmed.includes(profile.id)) settings.dataSharingConfirmedProfileIds = [...confirmed, profile.id];
    });
  }

  // /技能名 从正文里摘出来，本轮生效；正文为空（只发了技能名或附件）时保留原文，避免发送空消息
  const extracted = extractSkills(text, skills.value);
  const outgoing = extracted.text || (pending.length ? "" : text);

  const conversationId = store.activeConversationId;
  inputRef.value?.replaceChildren();
  input.value = "";
  closeMention();
  skillQuery.value = undefined;
  attachments.value = [];
  attachmentNotice.value = "";
  stickToBottom.value = true;
  await nextTick();
  resizeInput();
  await store.sendMessage(outgoing, { attachments: pending, skillNames: extracted.skillNames }, conversationId);
}

/**
 * 输入区按键不外冒：回车发送、Esc 关菜单在元素上处理，其余按键不进宿主全局快捷键。
 *
 * 宿主键盘处理只把 INPUT/TEXTAREA 视作“正在输入”并跳过，本面板是 contenteditable 的 DIV，
 * 不拦住的话回车会命中模型树区域的“打开属性设置”（Enter 绑定=节点双击）、Delete/F2 也会误触宿主动作。
 * 输入法组合期间（如中文选词回车）一律不拦截；Ctrl+I 与宿主输入框行为保持一致，放行给宿主。
 */
function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    event.stopPropagation();
    return;
  }

  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    handleInputEnter();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMention();
    return;
  }

  if (event.key === "i" && (event.ctrlKey || event.metaKey)) return;
  event.stopPropagation();
}

function handleInput(): void {
  resizeInput();
  input.value = serializeInput();

  // @ 提及与 / 技能共用同一个菜单位；光标前是 @ 时优先提及
  if (getMentionQuery() !== undefined) {
    mentionMode.value = "actions";
    skillQuery.value = undefined;
    return;
  }

  const query = getSkillQuery();
  if (query !== undefined) {
    skillQuery.value = query;
    closeMentionMenu();
    return;
  }

  closeMention();
}

function getMentionQuery(): string | undefined {
  const selection = inputRef.value?.ownerDocument.getSelection();
  if (!selection?.rangeCount) return undefined;

  const range = selection.getRangeAt(0);
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return undefined;

  const text = range.startContainer.textContent ?? "";
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, range.startOffset));
  return match?.[1];
}

async function openMentionNodePicker(): Promise<void> {
  const selection = inputRef.value?.ownerDocument.getSelection();
  mentionRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
  const host = tryGetAiAssistantHost();
  if (!host) return;

  const origin = store.activeConversationId;
  const originProject = projectId.value;
  const mentions = await host.model.pickMentions();
  if (origin !== store.activeConversationId || originProject !== projectId.value) return;
  if (mentions.length) insertMentions(mentions);
  else closeMention();
}

function insertMentions(mentions: AiModelMention[]): void {
  const range = mentionRange;
  if (!range) return;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return;

  const textNode = range.startContainer;
  const cursor = range.startOffset;
  const text = textNode.textContent ?? "";
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor));
  if (!match) return;

  range.setStart(textNode, cursor - match[0].length + (match[0].startsWith(" ") ? 1 : 0));
  range.setEnd(textNode, cursor);
  range.deleteContents();

  const fragment = (inputRef.value?.ownerDocument ?? document).createDocumentFragment();
  let spacer: Text | undefined;
  mentions.forEach(mention => {
    fragment.append(createMentionToken(mention));
    spacer = (inputRef.value?.ownerDocument ?? document).createTextNode(" ");
    fragment.append(spacer);
  });
  range.insertNode(fragment);
  if (!spacer) return;
  range.setStart(spacer, spacer.length);
  range.collapse(true);
  const selection = inputRef.value?.ownerDocument.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
  input.value = serializeInput();
  closeMention();
  void nextTick(() => {
    inputRef.value?.focus();
    resizeInput();
  });
}

function createMentionToken(mention: AiModelMention): HTMLSpanElement {
  const token = (inputRef.value?.ownerDocument ?? document).createElement("span");
  token.className = "ai-mention-token";
  token.contentEditable = "false";
  token.dataset.mentionId = mention.id;
  token.dataset.mentionTitle = mention.title;

  const title = (inputRef.value?.ownerDocument ?? document).createElement("span");
  title.textContent = mention.title;
  const removeButton = (inputRef.value?.ownerDocument ?? document).createElement("button");
  removeButton.className = "ai-mention-token__remove";
  removeButton.type = "button";
  removeButton.tabIndex = -1;
  removeButton.setAttribute("aria-label", `移除${mention.title}`);
  removeButton.textContent = "×";
  removeButton.addEventListener("click", event => {
    event.preventDefault();
    removeMentionToken(token);
  });
  token.append(title, removeButton);
  return token;
}

function removeMentionToken(token: HTMLSpanElement): void {
  const next = token.nextSibling;
  token.remove();
  if (next?.nodeType === Node.TEXT_NODE && next.textContent?.startsWith(" ")) {
    next.textContent = next.textContent.slice(1);
    if (!next.textContent) next.remove();
  }
  input.value = serializeInput();
  inputRef.value?.focus();
  resizeInput();
}

/**
 * 消费“添加到聊天”入队的节点（模型树右键子菜单，见 assistant/add-to-chat.ts）。
 *
 * 面板未挂载时节点先留在队列里，挂载或队列变化时在这里统一落地：
 * 切到聊天视图并把引用芯片追加到输入区；已在输入区的节点不重复插入。
 */
function drainPendingChatMentions(): void {
  const mentions = drainChatMentions();
  if (!mentions.length) return;

  closeMention();
  appendMentionTokens(mentions);
}

/** 把节点引用追加到输入区末尾（外部入口用；@ 菜单的插入走 insertMentions） */
function appendMentionTokens(mentions: AiModelMention[]): void {
  const root = inputRef.value;
  if (!root) return;

  const existingIds = new Set(
    Array.from(root.querySelectorAll<HTMLElement>("[data-mention-id]")).map(element => element.dataset.mentionId ?? "")
  );
  const fresh = mentions.filter(mention => !existingIds.has(mention.id));

  if (fresh.length) {
    const fragment = (inputRef.value?.ownerDocument ?? document).createDocumentFragment();
    // 末尾已有不是以空格结尾的内容时先补一个空格，避免引用芯片与正文贴在一起
    const last = root.lastChild;
    if (last && !(last.nodeType === Node.TEXT_NODE && (last.textContent ?? "").endsWith(" ")))
      fragment.append((inputRef.value?.ownerDocument ?? document).createTextNode(" "));
    fresh.forEach(mention => {
      fragment.append(createMentionToken(mention));
      fragment.append((inputRef.value?.ownerDocument ?? document).createTextNode(" "));
    });
    root.append(fragment);
    input.value = serializeInput();
    resizeInput();
  }

  void nextTick(() => inputRef.value?.focus());
}

function handleInputEnter(): void {
  // 菜单开着时 Enter 不发送：技能菜单采纳首个候选（没有候选就采纳首个内置建议），@ 提及先选节点再发
  if (skillMenuVisible.value) {
    const [firstSkill] = skillCandidates.value;
    if (firstSkill) {
      insertSkill(firstSkill);
      return;
    }

    const [firstPreset] = skillPresets.value;
    if (firstPreset) {
      insertPresetSkill(firstPreset);
      return;
    }
  }

  if (mentionVisible.value) return;

  void handleSend();
}

/** 只收 @ 提及菜单：技能分支要用它，不能顺带清掉技能前缀 */
function closeMentionMenu(): void {
  mentionMode.value = undefined;
  mentionRange = undefined;
}

/** 收起输入区的两个菜单（Esc、发送、选完节点后调用） */
function closeMention(): void {
  closeMentionMenu();
  skillQuery.value = undefined;
}

function serializeInput(): string {
  const root = inputRef.value;
  if (!root) return "";
  return Array.from(root.childNodes).map(serializeInputNode).join("");
}

function serializeInputNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : undefined;
  if (element?.dataset.skillName) return `/${element.dataset.skillName}`;
  if (element?.dataset.mentionId && element.dataset.mentionTitle) {
    return `@[${element.dataset.mentionTitle}](${element.dataset.mentionId})`;
  }
  if (node.nodeName === "BR") return "\n";
  return Array.from(node.childNodes).map(serializeInputNode).join("");
}

async function createConversation(): Promise<void> {
  settingsVisible.value = false;
  await store.createConversation();
}

function startSkillCreation(): Promise<void> {
  return startCreationChat("skill-creator", "请帮我创建一个可以实现「……」的技能");
}

function startExpertCreation(): Promise<void> {
  return startCreationChat("expert-manager", "帮我创建一个 XXX 专家，擅长 XXXXX。我的经验是：[请补充你的行业背景、相关经验]");
}

async function startCreationChat(skillName: string, prompt: string): Promise<void> {
  providerSettings.value = loadAiProviderSettings();
  const creator = skills.value.find(skill => skill.name === skillName);
  if (!creator) return;
  await createConversation();
  await nextTick();
  const element = inputRef.value;
  if (!element) return;
  element.replaceChildren(createSkillToken(creator), element.ownerDocument.createTextNode(` ${prompt}`));
  handleInput();
  element.focus();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = element.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function fillStarterPrompt(text: string): void {
  if (!inputRef.value) return;
  inputRef.value.textContent = text;
  handleInput();
  inputRef.value.focus();
}

function selectConversation(id: string): void {
  settingsVisible.value = false;
  store.selectConversation(id);
  jumpToBottom();
}

function deleteConversation(id: string): void {
  store.deleteConversation(id);
}

async function handleExecuteProposal(messageId: string): Promise<void> {
  const proposal = store.messages.find(message => message.id === messageId)?.proposal;
  if (!proposal || proposal.status !== "pending") return;

  await store.executeProposal(messageId, true);
}

/** 计划卡片：勾选步骤转成待确认提案（用户在提案卡片上再确认一次才落盘） */
function handleExecutePlan(messageId: string, stepIds: string[]): void {
  store.executePlan(messageId, stepIds);
}

/** 忽略整份计划：卡片标记为已忽略，不再可勾选 */
function handleRejectPlan(messageId: string): void {
  store.rejectPlan(messageId);
}

/** 回滚本轮已执行的改动；结果写回消息，由卡片下方展示 */
async function handleRollbackProposal(messageId: string): Promise<void> {
  await store.rollbackProposal(messageId);
}

/** 选择卡片作答：转给 store 记下答案并自动继续下一轮 */
async function handleAnswerChoice(messageId: string, promptId: string, answer: string | null): Promise<void> {
  await store.answerChoicePrompt(messageId, promptId, answer);
}

/** 设置保存后重新读回配置；只有供应商变化才需要重新拉模型列表 */
function handleSettingsSaved(section: AiSettingsSection): void {
  providerSettings.value = loadAiProviderSettings();
  if (section === "providers") void loadModels(true);
}

/** 用户停留在底部附近时才跟随新内容滚动 */
function handleScroll(): void {
  const element = messagesRef.value;
  if (!element) return;

  stickToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  publishDraft();
}

function resizeInput(): void {
  const element = inputRef.value;
  if (!element) return;

  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  void scrollToBottom();
}

function jumpToBottom(): void {
  stickToBottom.value = true;
  void scrollToBottom();
}

async function scrollToBottom(): Promise<void> {
  if (!stickToBottom.value) return;

  await nextTick();
  const element = messagesRef.value;
  if (element) element.scrollTop = element.scrollHeight;
}

watch(
  () => {
    const lastMessage = store.messages[store.messages.length - 1];
    return [store.messages.length, lastMessage?.content.length ?? 0, lastMessage?.toolCalls.length ?? 0] as const;
  },
  () => void scrollToBottom()
);
</script>

<style lang="scss" scoped>
@use "./panel-tokens" as tok;

/*
 * 面板骨架：180px 会话菜单 + 400px 聊天区，锁定总宽度避免长行撑宽。
 * 宿主把右侧面板放在内容自适应的栅格列里，面板一旦不定宽，
 * 流式回复里的长行会持续把面板撑宽——宽度必须由面板自己锁死。
 */
.ai-panel {
  @include tok.ai-tokens;

  position: relative;
  display: flex;
  flex-direction: row;
  width: var(--ai-panel-width, 580px);
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
  container: assistant / inline-size;
  border-left: 1px solid var(--md-border-color);
  background: #fff;
  color: var(--md-text-primary);
  font-size: 13px;
  font-family: var(--ai-font);
  letter-spacing: 0;
}

.ai-panel.is-floating {
  flex: 1;
  width: 100%;
  height: auto;
  border-left: none;
}

.ai-panel__chat {
  display: flex;
  flex: 1;
  flex-direction: column;
  width: 408px;
  min-width: 0;
  min-height: 0;
}

/** 面板内滚动条一律隐藏，滚动交互不变 */
.ai-panel__scroll,
.ai-composer__input,
.ai-popover__list {
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

/* ---------------- 头部 ---------------- */

.ai-panel__bar.is-quiet .ai-panel__topic {
  visibility: hidden;
}

.ai-panel__bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 12px;
}

.ai-panel__topic,
.ai-panel__heading {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--md-text-secondary);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-panel__back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: -4px;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-md);
  background: transparent;
  color: var(--md-text-secondary);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;

  svg {
    @include tok.ai-icon(15px, 1.9);

    transform: rotate(180deg);
  }

  &:hover {
    background: var(--md-neutral-100);
    color: var(--md-text-primary);
  }
}

.ai-panel__actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
  margin-left: auto;
}

/* 左边缘宽度拖拽：命中区比视觉线宽，悬停才显出主色细线 */
.ai-panel__resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  z-index: 5;
  width: 6px;
  cursor: col-resize;
  touch-action: none;

  &::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 1px;
    background: transparent;
    transition: background-color 0.15s;
  }

  &:hover::after {
    background: var(--ai-accent-line);
  }
}

/* 会话栏收起/展开：图标指向收纳方向 */
.ai-panel__sidebar-toggle svg {
  transform: rotate(180deg);
  transition: transform 0.15s;
}

.ai-panel__sidebar-toggle.is-collapsed svg {
  transform: none;
}

.ai-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-md);
  background: transparent;
  color: var(--md-text-secondary);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s,
    transform 0.1s ease-out;

  svg {
    @include tok.ai-icon(15px, 1.85);
  }

  &:hover {
    background: var(--md-neutral-100);
    color: var(--md-text-primary);
  }
}

/* ---------------- 消息区 ---------------- */

.ai-panel__scroll {
  flex: 1;
  min-height: 0;
  /* 与输入框同一栏宽：窄面板留 20px 边距，宽面板收敛到 800px 阅读宽度 */
  padding: 12px max(16px, calc((100% - 740px) / 2)) 4px;
  overflow-y: auto;
  overflow-x: hidden;
}

.ai-welcome {
  text-align: center;
}

.ai-welcome__title {
  margin: 0;
  color: var(--md-text-primary);
  font-family: var(--ai-font);
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.5px;
  line-height: 1.4;
}

.ai-welcome__modes {
  display: inline-flex;
  gap: 2px;
  margin-top: 16px;
  padding: 3px;
  border: none;
  border-radius: 24px;
  background: var(--md-neutral-50);

  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 0;
    border-radius: 20px;
    background: transparent;
    color: var(--md-text-regular);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    svg {
      @include tok.ai-icon(14px);
    }
    &:hover {
      color: var(--md-text-primary);
    }
    &.is-active {
      background: #fff;
      color: var(--md-text-primary);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
      font-weight: 600;
    }
  }
}

.ai-panel__chat.is-empty {
  overflow-y: auto;
  .ai-panel__scroll {
    flex: 0 0 auto;
    padding: clamp(24px, 7vh, 64px) 16px 0;
    overflow: visible;
  }
  .ai-composer {
    margin-top: 24px;
    padding-top: 0;
  }
}

.ai-starters {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  align-items: flex-start;
  align-self: center;
  gap: 8px;
  width: min(calc(100% - 32px), 740px);
  margin: 20px 0;

  button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    padding: 8px 14px;
    border: 1px solid var(--md-border-color);
    border-radius: 22px;
    background: #fff;
    box-shadow: 0 2px 3px rgba(0, 0, 0, 0.03);
    color: var(--md-text-regular);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    svg {
      @include tok.ai-icon(13px);
      transform: rotate(45deg);
    }
    &:hover {
      border-color: var(--md-neutral-300);
      background: var(--md-neutral-50);
      color: var(--md-text-primary);
    }
  }
}

.ai-panel__footnote {
  margin: auto 16px 14px;
  padding-top: 14px;
  color: var(--md-text-placeholder);
  font-size: 11px;
  text-align: center;
}

@container assistant (min-width: 760px) {
  .ai-welcome__title {
    font-size: 30px;
  }
  .ai-panel__chat.is-empty .ai-composer {
    margin-top: 52px;
  }
  .ai-panel__chat.is-empty .ai-composer__input {
    min-height: 96px;
  }
  .ai-starters {
    margin-top: 36px;
  }
}

/* 键帽：等宽字体 + 下沉底边，一眼认出是可敲的键 */
.ai-kbd {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--md-neutral-300);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: #fff;
  color: var(--md-text-secondary);
  font-family: var(--ai-mono);
  font-size: 12px;
  line-height: 1;
}

.ai-panel__error {
  margin: 4px 0 10px;
  padding: 8px 10px;
  border: 1px solid rgba(207, 74, 66, 0.28);
  border-radius: var(--md-radius-md);
  background: #fdf4f3;
  color: var(--ai-danger);
  font-size: 12px;
  line-height: 1.6;
}

/* ---------------- 输入区 ---------------- */

.ai-chat-memory {
  display: flex;
  flex-shrink: 0;
  align-self: center;
  align-items: center;
  gap: 10px;
  width: min(calc(100% - 32px), 740px);
  padding-top: 8px;
  color: var(--md-text-secondary);
  font-size: 12px;
  line-height: 1.6;

  &.is-remembering {
    color: #2563eb;
  }
  &.is-error {
    color: var(--ai-danger);
  }
}
.ai-chat-memory__action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
  &:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
  }
}
.ai-chat-memory__label {
  flex-shrink: 0;
  color: var(--md-text-secondary);
}
.ai-chat-memory__icon {
  @include tok.ai-icon(16px);
}
.ai-chat-memory.is-remembering .ai-chat-memory__icon {
  animation: chat-memory-pulse 1.6s ease-in-out infinite;
}
@keyframes chat-memory-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.12);
  }
}
@media (prefers-reduced-motion: reduce) {
  .ai-chat-memory.is-remembering .ai-chat-memory__icon {
    animation: none;
  }
}

.ai-composer {
  position: relative;
  flex-shrink: 0;
  align-self: center;
  width: min(calc(100% - 32px), 740px);
  padding: 6px 0 10px;

  &.has-scroll-action {
    padding-top: 40px;
  }
}

.ai-panel__statistics {
  grid-column: 2;
  justify-self: end;
  justify-content: flex-end;
  min-width: 0;
  padding: 0;
}

.ai-panel__scroll-bottom {
  position: absolute;
  top: 4px;
  left: 50%;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  transform: translateX(-50%);
  border: 1px solid var(--md-border-color);
  border-radius: 50%;
  background: #fff;
  color: var(--md-text-secondary);
  cursor: pointer;

  svg {
    @include tok.ai-icon(16px);
  }

  &:hover {
    border-color: var(--ai-accent-line);
    background: var(--ai-accent-soft);
    color: var(--ai-accent);
  }

  &:focus-visible {
    outline: 2px solid var(--ai-accent);
    outline-offset: 2px;
  }
}

.ai-composer__box {
  position: relative;
  z-index: 1;
  border: 1px solid var(--md-border-color);
  border-radius: 24px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;

  &:focus-within {
    border-color: #a8a8a8;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
}

.ai-composer__input {
  display: block;
  width: 100%;
  min-height: 60px;
  max-height: 180px;
  padding: 12px 14px 6px;
  box-sizing: border-box;
  border: none;
  outline: none;
  background: transparent;
  color: var(--md-text-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  overflow-y: auto;
  overflow-wrap: anywhere;
  white-space: pre-wrap;

  &:empty::before {
    content: attr(data-placeholder);
    color: var(--md-text-placeholder);
    pointer-events: none;
  }

  &:focus,
  &:focus-visible {
    outline: none;
  }
}

:deep(.ai-mention-token) {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 2px;
  padding: 1px 4px 1px 5px;
  border: 1px solid var(--ai-accent-line);
  border-radius: var(--md-radius-sm);
  background: var(--ai-accent-soft);
  color: var(--ai-accent-strong);
  font-size: 12px;
  line-height: 1.5;
  vertical-align: baseline;
}

/* 技能使用统一的中性胶囊样式，鼠标经过或键盘聚焦时显示移除按钮。 */
:deep(.ai-mention-token--skill) {
  gap: 4px;
  padding: 2px 9px 2px 5px;
  border: 0;
  border-radius: 999px;
  background: var(--md-neutral-100);
  color: var(--md-text-primary);
  font-family: inherit;

  .ai-mention-token__remove {
    display: inline-grid;
    flex: 0 0 18px;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    line-height: normal;
    vertical-align: middle;
    color: var(--md-text-regular);
    svg {
      grid-area: 1 / 1;
      width: 13px;
      height: 13px;
      pointer-events: none;
    }
    .ai-skill-token__close {
      visibility: hidden;
    }
    &:hover {
      background: var(--md-neutral-200);
    }
    &:focus-visible {
      outline: 1px solid currentColor;
      outline-offset: 1px;
    }
  }
  &:hover .ai-skill-token__icon,
  &:focus-within .ai-skill-token__icon {
    visibility: hidden;
  }
  &:hover .ai-skill-token__close,
  &:focus-within .ai-skill-token__close {
    visibility: visible;
  }
}

:deep(.ai-mention-token__remove) {
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 15px;
  line-height: 12px;
  cursor: pointer;

  &:hover {
    background: rgba(53, 97, 168, 0.14);
  }
}

.ai-composer__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 8px;
}

.ai-composer__submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: #242424;
  color: #fff;
  cursor: pointer;
  transition:
    background-color 0.15s,
    opacity 0.15s,
    transform 0.15s;

  svg {
    @include tok.ai-icon(15px, 2);
  }

  &:hover:not(:disabled) {
    background: #444;
  }

  &:disabled {
    background: #d2d2d2;
    color: #fff;
    cursor: not-allowed;
  }
}

/* 附件条：图片给缩略图，其余给图标 + 名称 + 体积 */
.ai-composer__files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px 0;
}

.ai-composer__file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 4px 3px 6px;
  border: 1px solid var(--md-neutral-200);
  border-radius: var(--md-radius-md);
  background: var(--md-neutral-50);
  color: var(--md-text-regular);
  font-size: 12px;
}

.ai-composer__file-thumb {
  width: 20px;
  height: 20px;
  border-radius: var(--md-radius-sm);
  object-fit: cover;
}

.ai-composer__file-icon {
  width: 14px;
  height: 14px;
  color: var(--md-text-placeholder);
}

.ai-composer__file-name {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-composer__file-size {
  @include tok.ai-tabular;

  color: var(--md-text-placeholder);
}

.ai-composer__file-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-sm);
  background: transparent;
  color: var(--md-text-placeholder);
  cursor: pointer;

  svg {
    @include tok.ai-icon(11px, 2);
  }

  &:hover {
    background: var(--md-neutral-200);
    color: var(--md-text-primary);
  }
}

.ai-composer__notice {
  flex: 1 1 100%;
  margin: 0;
  color: var(--ai-danger);
  font-size: 12px;
  line-height: 1.5;
}

.ai-composer__notice--hint {
  color: var(--ai-warn);
}

/* 隐藏的文件选择框：由回形针按钮触发 */
.ai-composer__file-input {
  display: none;
}

/* ---------------- 输入区下方的状态条 ---------------- */

.ai-composer__meta {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  margin: -24px 0 0;
  padding: 30px 12px 6px;
  border-radius: 0 0 24px 24px;
  background: var(--md-neutral-50);
}

.ai-composer__mode-options {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 4px;
}

.ai-composer__chip.ai-composer__effort {
  grid-column: 3;
  justify-self: end;
  max-width: 100%;
}

@container assistant (max-width: 620px) {
  .ai-composer__meta { grid-template-columns: minmax(0, 1fr) auto; }
  .ai-composer__effort { grid-column: 2; grid-row: 1; }
  .ai-panel__statistics { grid-column: 1 / -1; grid-row: 2; }
}

.ai-composer__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-bottom: 8px;
  button {
    padding: 4px 10px;
    border: 1px solid var(--md-border-color);
    border-radius: 18px;
    background: var(--md-neutral-50);
    color: var(--md-text-regular);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    &:hover {
      border-color: var(--md-neutral-300);
      background: var(--md-neutral-100);
    }
  }
}
.ai-composer__actions .ai-composer__model {
  max-width: 65%;
  color: var(--md-text-primary);
  font-size: 12px;
}

.ai-composer__spacer {
  flex: 1;
}

.ai-composer__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 46%;
  height: 26px;
  padding: 0 7px;
  border: none;
  border-radius: var(--md-radius-md);
  background: transparent;
  color: var(--md-text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s;

  &-label {
    color: var(--md-text-placeholder);
  }

  &-value {
    overflow: hidden;
    color: var(--md-text-regular);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &:hover,
  &.is-open {
    background: var(--md-neutral-100);

    .ai-composer__chip-value {
      color: var(--md-text-primary);
    }
  }
}

/* 权限模式 chip：结构同其它 chip，图标随模式变化 */
.ai-composer__chip--mode .ai-composer__chip-icon {
  @include tok.ai-icon(14px, 1.8);

  color: var(--md-text-secondary);
}

.ai-composer__chip--mode:hover .ai-composer__chip-icon,
.ai-composer__chip--mode.is-open .ai-composer__chip-icon {
  color: var(--md-text-primary);
}

.ai-composer__chip--mode .ai-composer__chip-value {
  color: var(--md-text-regular);
  font-weight: 500;
}

.ai-composer__chip-caret {
  @include tok.ai-icon(11px, 2);

  color: var(--md-text-placeholder);
  transition: transform 0.15s;
}

.ai-composer__chip--mode.is-open .ai-composer__chip-caret {
  transform: rotate(180deg);
}

/* 品牌 logo 尺寸：BrandLogo 自身宽高为 1em，用 font-size 控制 */
.ai-composer__logo {
  color: var(--md-text-primary);
  font-size: 14px;
}

/* ---------------- 浮层弹窗 ---------------- */

.ai-popover-mask {
  position: fixed;
  inset: 0;
  z-index: 10;
}

.ai-popover {
  position: absolute;
  right: 0;
  bottom: calc(100% + 8px);
  z-index: 11;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-height: 336px;
  overflow: hidden;
  border: 1px solid var(--md-neutral-200);
  border-radius: 16px;
  background: #fff;
  box-shadow:
    0 8px 28px rgba(0, 0, 0, 0.09),
    0 2px 6px rgba(0, 0, 0, 0.04);
  transform-origin: bottom right;
  animation: ai-popover-in 0.16s cubic-bezier(0.32, 0.72, 0, 1);

  &--effort {
    padding: 8px;
    width: 148px;
    max-height: 264px;
  }

  /* 权限模式下拉：左对齐在权限 chip 上方 */
  &--mode {
    right: auto;
    left: 0;
    width: 288px;
    max-height: 300px;
    padding: 8px;
    transform-origin: bottom left;
  }

}

.ai-popover__search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  margin: 8px 8px 4px;
  border: 0;
  border-radius: 10px;
  background: var(--md-neutral-50);

  svg {
    @include tok.ai-icon(13px, 2);

    color: var(--md-text-placeholder);
  }

  input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--md-text-primary);
    font-family: inherit;
    font-size: 13px;

    &::placeholder {
      color: var(--md-text-placeholder);
    }
  }
}

.ai-popover__list {
  flex: 1;
  min-height: 0;
  padding: 4px;
  overflow-y: auto;
}

/*
 * 模型选择器：左侧服务机架 + 右侧模型册。
 *
 * 机架只做一件事——按服务筛选；列表平铺、每行自带服务归属，
 * 收藏则把常用模型收进"首页"，并用 Ctrl+1–9 给固定槽位。
 */
.ai-popover--model {
  flex-direction: row;
  width: 336px;
  padding: 0;
}

.ai-model-rail {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  gap: 2px;
  width: 44px;
  padding: 6px;
  box-sizing: border-box;
  border-right: 1px solid var(--md-neutral-200);
  background: var(--md-neutral-50);
}

.ai-model-rail__item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-md);
  background: transparent;
  /* 未收录品牌的首字母文字用重墨；官方 logo 走原生品牌色（组件内联） */
  color: var(--md-text-primary);
  font-size: 16px;
  cursor: pointer;
  transition: background-color 0.15s;

  svg {
    @include tok.ai-icon(16px, 1.9);
  }

  &:hover {
    background: var(--md-neutral-100);
  }

  /* 选中项：白底浮起 + 机架左缘一段主色条，一眼看出当前在看哪个服务 */
  &.is-active {
    background: #fff;
    box-shadow: 0 0 0 1px var(--md-neutral-200);

    &::before {
      content: "";
      position: absolute;
      left: -6px;
      top: 7px;
      bottom: 7px;
      width: 2px;
      border-radius: 0 2px 2px 0;
      background: var(--ai-accent);
    }
  }
}

.ai-model-main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
}

/* 模型行：两段式，上排模型名、下排服务标识与名称，右侧是元数据与收藏 */
.ai-model-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px 6px 10px;
  border-radius: var(--md-radius-md);
  color: var(--md-text-primary);
  cursor: pointer;
  outline: none;
  transition: background-color 0.12s;

  &:hover {
    background: var(--md-neutral-100);
  }

  &:focus-visible {
    box-shadow: inset 0 0 0 1px var(--ai-accent);
  }

  &.is-active {
    background: var(--ai-accent-soft);
  }
}

.ai-model-row__text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.ai-model-row__name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-row.is-active .ai-model-row__name {
  color: var(--ai-accent-strong);
}

.ai-model-row__provider {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--md-text-placeholder);
  font-size: 11px;
}

.ai-model-row__logo {
  color: var(--md-text-primary);
  font-size: 12px;
}

.ai-model-row__provider-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-row__meta {
  @include tok.ai-tabular;

  flex-shrink: 0;
  color: var(--md-text-placeholder);
  font-size: 11px;
}

/* 收藏槽位就是 Ctrl+N 的键帽，沿用面板的键帽样式 */
.ai-model-row__slot {
  flex-shrink: 0;
  height: 18px;
  min-width: 18px;
  color: var(--md-text-secondary);
}

.ai-model-row__star {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-sm);
  background: transparent;
  color: #e5ad00;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s;

  svg {
    @include tok.ai-icon(14px, 1.9);
  }

  &:hover,
  &.is-on {
    svg :deep(path) {
      fill: currentColor;
    }
  }

  &.is-on {
    opacity: 1;
  }
}

.ai-model-row:hover .ai-model-row__star,
.ai-model-row__star:focus-visible {
  opacity: 1;
}

.ai-model-empty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 12px;
}

.ai-model-empty__title {
  margin: 0;
  color: var(--md-text-regular);
  font-size: 12px;
}

.ai-model-empty__hint {
  margin: 0;
  color: var(--md-text-placeholder);
  font-size: 12px;
  line-height: 1.6;
}

.ai-model-error {
  margin: 0;
  padding: 6px 10px 10px;
  color: var(--ai-danger);
  font-size: 12px;
  line-height: 1.6;
}

.ai-model-btn {
  align-self: flex-start;
  margin-top: 2px;
  padding: 5px 10px;
  border: 1px solid var(--md-border-color);
  border-radius: var(--md-radius-md);
  background: #fff;
  color: var(--md-text-regular);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;

  &:hover {
    border-color: var(--ai-accent);
    color: var(--ai-accent);
  }
}

.ai-popover__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--md-text-regular);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s;

  &:hover {
    background: var(--md-neutral-100);
  }

  &.is-active {
    background: #f2f2f2;
    color: var(--md-text-primary);
  }
}

.ai-popover__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-popover__empty {
  margin: 0;
  padding: 12px 10px;
  color: var(--md-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

/* 权限模式条目：等高单行「图标 + 标题 + 说明 + 选中勾」 */
.ai-popover__item--mode {
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 4px 10px;
}

.ai-popover__item--mode + .ai-popover__item--mode {
  margin-top: 2px;
}

.ai-popover__icon {
  @include tok.ai-icon(15px, 1.8);

  color: var(--md-text-secondary);
}

.ai-popover__item--mode.is-active .ai-popover__icon {
  color: inherit;
}

.ai-popover__content {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: baseline;
  gap: 8px;
}

.ai-popover__item--mode .ai-popover__name {
  flex-shrink: 0;
  white-space: nowrap;
}

.ai-popover__hint {
  overflow: hidden;
  color: var(--md-text-secondary);
  font-size: 11px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-popover__item--mode.is-active .ai-popover__hint {
  color: inherit;
  opacity: 0.82;
}

.ai-popover__check {
  @include tok.ai-icon(14px, 2.1);
}

/* 技能菜单 */
.ai-mention {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 2;
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--md-neutral-200);
  border-radius: 16px;
  background: #fff;
  box-shadow:
    0 8px 28px rgba(0, 0, 0, 0.09),
    0 2px 6px rgba(0, 0, 0, 0.04);
}

.ai-mention__item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--md-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: var(--md-neutral-100);
  }
}

.ai-mention__heading {
  margin: 4px 8px 6px;
  color: var(--md-text-secondary);
  font-size: 12px;
}

.ai-mention__action {
  justify-content: flex-start;
  gap: 8px;
  background: var(--md-neutral-50);
}

.ai-mention__title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-mention__hint {
  flex-shrink: 0;
  max-width: 62%;
  overflow: hidden;
  color: var(--md-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 技能菜单空状态：说清"为什么没有、去哪加" */
.ai-mention__empty {
  margin: 2px 8px 6px;
  color: var(--md-text-placeholder);
  font-size: 12px;
}

/* ---------------- 交互细节 ---------------- */

button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 1px;
}

@keyframes ai-popover-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-icon-btn,
  .ai-panel__back,
  .ai-composer__box,
  .ai-composer__submit,
  .ai-composer__chip,
  .ai-popover__item,
  .ai-model-row,
  .ai-model-row__star,
  .ai-model-rail__item,
  .ai-model-btn {
    transition: none;
  }

  .ai-popover {
    animation: none;
  }
}
</style>
