<script setup lang="ts">
/** 记忆管理界面，读取 owner 状态并等待管理事务完成后更新反馈。 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAiAssistantStore } from "../../../ai-assistant/conversation/store";
import type { MemoryCommand, MemoryEntry } from "../../../ai-assistant/memory";
import AiIcon from "./AiIcon.vue";
import { ICONS } from "./icons";

const emit = defineEmits<{
  /** 请求关闭设置面板。 */
  (event: "dismiss"): void;
}>();

type MemoryScope = "all" | "user" | "project";
interface MemoryDraft {
  id: string;
  revision: number;
  contextKey: string;
  text: string;
}

const store = useAiAssistantStore();
const state = computed(() => store.memoryState);
const scope = ref<MemoryScope>("all");
const search = ref("");
const editing = ref<MemoryDraft | null>(null);
const pending = ref<"" | "refresh" | "change">("");
const pendingDeleteId = ref("");
const confirmClear = ref(false);
const error = ref("");
const scopes: { value: MemoryScope; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "user", label: "用户" },
  { value: "project", label: "当前项目" }
];
const scopeLabel = computed(() => scopes.find(item => item.value === scope.value)?.label ?? "全部");
const clearLabel = computed(() => (scope.value === "all" ? "清空所有范围记忆" : `清空${scopeLabel.value}记忆`));
const scopedEntries = computed(() =>
  state.value.entries.filter(
    entry => scope.value === "all" || (scope.value === "user" ? entry.projectId === null : entry.projectId === state.value.projectId)
  )
);
const filteredEntries = computed(() => {
  const query = search.value.trim().toLowerCase();
  return scopedEntries.value.filter(entry => `${entry.text} ${entry.source.quote}`.toLowerCase().includes(query));
});
const statusText = computed(() => {
  if (pending.value === "refresh") return "正在读取记忆…";
  if (pending.value === "change") return "正在保存更改…";
  if (!state.value.available) return "记忆存储不可用";
  if (state.value.status === "extracting") return "记忆中…";
  if (state.value.status === "saved") return "记忆已保存";
  if (state.value.status === "error") return "记忆处理失败";
  return state.value.enabled ? "已开启，完成对话后自动整理" : "已关闭，已有记忆仍然保留";
});
const displayedError = computed(() => error.value || state.value.error);
const isRemembering = computed(() => !pending.value && state.value.available && state.value.status === "extracting");
const canChange = computed(() => state.value.available && !!state.value.contextKey && !pending.value);
const draftLength = computed(() => editing.value?.text.trim().length ?? 0);

watch([() => state.value.contextKey, scope], resetDraft, { flush: "sync" });
onMounted(() => {
  void refresh();
  window.addEventListener("keydown", handleKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));

function resetDraft(): void {
  editing.value = null;
  pendingDeleteId.value = "";
  confirmClear.value = false;
  error.value = "";
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (editing.value || pendingDeleteId.value || confirmClear.value) resetDraft();
  else emit("dismiss");
}

async function refresh(): Promise<void> {
  if (pending.value) return;
  pending.value = "refresh";
  error.value = "";
  const contextKey = state.value.contextKey;
  try {
    await store.refreshMemory();
  } catch (cause) {
    if (contextKey === state.value.contextKey) error.value = cause instanceof Error ? cause.message : "无法读取记忆，请重试。";
  } finally {
    pending.value = "";
  }
}

/** 上下文令牌随命令提交，过期页面的操作由 owner 拒绝。 */
async function change(command: MemoryCommand, contextKey = state.value.contextKey): Promise<boolean> {
  if (!canChange.value) return false;
  pending.value = "change";
  error.value = "";
  try {
    await store.changeMemory(command, contextKey);
    return contextKey === state.value.contextKey;
  } catch (cause) {
    if (contextKey === state.value.contextKey) error.value = cause instanceof Error ? cause.message : "更改未保存，请重试。";
    return false;
  } finally {
    pending.value = "";
  }
}

function startEdit(entry: MemoryEntry): void {
  resetDraft();
  editing.value = { id: entry.id, revision: entry.revision, contextKey: state.value.contextKey, text: entry.text };
}

async function saveEdit(): Promise<void> {
  const draft = editing.value;
  if (!draft) return;
  if (!draft.text.trim() || draftLength.value > 160) {
    error.value = "请填写 1–160 字的记忆。";
    return;
  }
  const saved = await change({ kind: "edit", id: draft.id, expectedRevision: draft.revision, text: draft.text.trim() }, draft.contextKey);
  if (saved && editing.value === draft) editing.value = null;
}

async function deleteEntry(id: string): Promise<void> {
  if (await change({ kind: "delete", id })) pendingDeleteId.value = "";
}

async function clearEntries(): Promise<void> {
  const projectId = scope.value === "all" ? "all" : scope.value === "user" ? null : state.value.projectId;
  if (await change({ kind: "clear", projectId })) resetDraft();
}

function sourceConversation(entry: MemoryEntry): string {
  return store.conversations.find(conversation => conversation.id === entry.source.conversationId)?.title ?? "原会话已不在当前列表";
}

function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="ai-section memory-settings">
    <header class="ai-section__head">
      <h3 class="ai-section__title">记忆</h3>
    </header>
    <div class="ai-section__body">
      <section
        class="memory-card"
        aria-label="记忆设置"
      >
        <div class="memory-control">
          <div class="memory-control__copy">
            <h4>自动记忆</h4>
            <p class="memory-description">记住长期偏好和项目约定，让后续回答更贴合你。</p>
          </div>
          <label class="memory-toggle">
            <input
              type="checkbox"
              role="switch"
              aria-label="自动记忆"
              :checked="state.enabled"
              :disabled="!canChange"
              @change="change({ kind: 'enabled', enabled: !state.enabled })"
            />
            <span
              class="memory-toggle__track"
              aria-hidden="true"
            ></span>
          </label>
        </div>
        <p class="memory-description memory-note">
          记忆保存在此设备。使用当前模型在对话后整理，可能产生额外用量；关闭后停止记忆和召回，已有内容保留。
        </p>
        <div class="memory-state">
          <p class="memory-description">{{ state.identityLabel || "正在读取身份…" }}</p>
          <p
            class="memory-status"
            :class="{ 'is-remembering': isRemembering }"
            role="status"
            aria-live="polite"
          >
            <AiIcon
              v-if="isRemembering"
              class="memory-status__brain"
              :icon="ICONS.brain"
            />
            {{ statusText }}
          </p>
        </div>
        <p
          v-if="displayedError"
          class="memory-error"
          role="alert"
        >
          {{ displayedError }}
        </p>
        <p
          v-if="!state.available && !displayedError"
          class="memory-error"
        >
          无法访问记忆存储，请刷新重试。
        </p>
      </section>

      <section
        class="memory-card memory-management"
        aria-labelledby="memory-management-title"
      >
        <div class="memory-management__head">
          <div>
            <h4 id="memory-management-title">管理记忆</h4>
            <p class="memory-description">查看、编辑对话中保存的记忆。</p>
          </div>
          <button
            class="memory-button memory-refresh"
            type="button"
            :disabled="!!pending"
            @click="refresh"
          >
            {{ pending === "refresh" ? "读取中…" : "刷新" }}
          </button>
        </div>

        <div class="memory-toolbar">
          <div
            class="memory-filters"
            role="group"
            aria-label="记忆范围"
          >
            <button
              v-for="item in scopes"
              :key="item.value"
              class="memory-button"
              :class="{ 'is-active': scope === item.value }"
              type="button"
              :aria-pressed="scope === item.value"
              :disabled="item.value === 'project' && !state.projectId"
              @click="scope = item.value"
            >
              {{ item.label }}
            </button>
          </div>
          <span class="memory-count">{{ filteredEntries.length }} 条记忆</span>
        </div>
        <div class="memory-toolbar">
          <input
            v-model="search"
            class="memory-input memory-search"
            type="search"
            aria-label="搜索记忆"
            placeholder="搜索记忆或来源原句"
          />
          <button
            class="memory-button memory-danger"
            type="button"
            :disabled="!canChange || (scope !== 'all' && !scopedEntries.length)"
            @click="
              confirmClear = true;
              pendingDeleteId = '';
            "
          >
            {{ clearLabel }}
          </button>
        </div>
        <div
          v-if="confirmClear"
          class="memory-confirm"
          role="group"
          aria-label="确认清空记忆"
        >
          <p v-if="scope === 'all'">清空此身份的用户记忆和所有项目记忆，包括其他项目？此操作无法撤销。</p>
          <p v-else>清空{{ scopeLabel }}范围的 {{ scopedEntries.length }} 条记忆？此操作无法撤销。</p>
          <div class="memory-actions">
            <button
              class="memory-button"
              type="button"
              :disabled="!!pending"
              @click="confirmClear = false"
            >
              取消
            </button>
            <button
              class="memory-button memory-danger"
              type="button"
              :disabled="!canChange"
              @click="clearEntries"
            >
              确认清空
            </button>
          </div>
        </div>
        <p
          v-if="!filteredEntries.length"
          class="memory-empty"
        >
          {{ search.trim() ? "没有匹配的记忆，试试其他关键词。" : "此范围暂无记忆。开启后，对话中的长期偏好和项目约定会显示在这里。" }}
        </p>
        <ul
          v-else
          class="memory-list"
        >
          <li
            v-for="entry in filteredEntries"
            :key="entry.id"
            class="memory-entry"
          >
            <form
              v-if="editing?.id === entry.id"
              class="memory-editor"
              @submit.prevent="saveEdit"
            >
              <label :for="`memory-edit-${entry.id}`">编辑记忆</label>
              <textarea
                :id="`memory-edit-${entry.id}`"
                v-model="editing.text"
                class="memory-input"
                rows="3"
                :disabled="!!pending"
              ></textarea>
              <div class="memory-actions">
                <span class="memory-description">{{ draftLength }} / 160 字，保存后标记为人工编辑</span>
                <button
                  class="memory-button"
                  type="button"
                  :disabled="!!pending"
                  @click="editing = null"
                >
                  取消
                </button>
                <button
                  class="memory-button memory-button--primary"
                  type="submit"
                  :disabled="!canChange || !draftLength || draftLength > 160"
                >
                  {{ pending === "change" ? "保存中…" : "保存" }}
                </button>
              </div>
            </form>
            <p
              v-else
              class="memory-text"
            >
              {{ entry.text }}
            </p>
            <div class="memory-meta">
              <span>
                {{ entry.projectId === null ? "用户" : entry.projectId === state.projectId ? "当前项目" : `项目 ${entry.projectId}` }}
              </span>
              <span
                v-if="entry.mode === 'manual'"
                title="不会被自动覆盖"
              >
                人工编辑
              </span>
              <span v-else>自动整理</span>
              <time :datetime="new Date(entry.updatedAt).toISOString()">{{ formatTime(entry.updatedAt) }}</time>
            </div>
            <details class="memory-source">
              <summary>查看来源</summary>
              <blockquote>{{ entry.source.quote }}</blockquote>
              <p>{{ sourceConversation(entry) }}</p>
              <p>来源时间 {{ formatTime(entry.source.createdAt) }}</p>
            </details>
            <div
              v-if="editing?.id !== entry.id"
              class="memory-actions"
            >
              <template v-if="pendingDeleteId === entry.id">
                <span class="memory-description">删除这条记忆？</span>
                <button
                  class="memory-button"
                  type="button"
                  :disabled="!!pending"
                  @click="pendingDeleteId = ''"
                >
                  取消
                </button>
                <button
                  class="memory-button memory-danger"
                  type="button"
                  :disabled="!canChange"
                  @click="deleteEntry(entry.id)"
                >
                  确认删除
                </button>
              </template>
              <template v-else>
                <button
                  class="memory-button"
                  type="button"
                  :disabled="!canChange"
                  @click="startEdit(entry)"
                >
                  编辑
                </button>
                <button
                  class="memory-button memory-danger"
                  type="button"
                  :disabled="!canChange"
                  @click="
                    pendingDeleteId = entry.id;
                    confirmClear = false;
                  "
                >
                  删除
                </button>
              </template>
            </div>
          </li>
        </ul>
        <p class="memory-description memory-capacity">每个身份最多保存 200 条记忆，达到上限后需清理才能自动新增。</p>
      </section>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.memory-settings {
  min-width: 0;
  color: var(--md-text-primary);
  font-size: 13px;
}
.memory-settings .ai-section__body {
  padding: 14px;
  gap: 14px;
  background: var(--md-neutral-50);
}
.memory-card {
  flex-shrink: 0;
  min-width: 0;
  padding: 16px;
  border-radius: 14px;
  background: #fff;
  h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.6;
  }
}
.memory-management {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.memory-management__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--md-border-color);
}
.memory-control__copy {
  flex: 1;
  min-width: 0;
}
.memory-control + .memory-note {
  margin-top: 12px;
  font-size: 12px;
}
.memory-state {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--md-neutral-100);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.memory-capacity {
  padding-top: 12px;
  border-top: 1px solid var(--md-neutral-100);
  font-size: 12px;
}
.memory-control,
.memory-toolbar,
.memory-actions,
.memory-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.memory-control {
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 12px;
  strong {
    font-size: 14px;
  }
}
.memory-description,
.memory-status {
  margin: 0;
  color: var(--md-text-regular, #4b5058);
  line-height: 1.7;
}
.memory-control .memory-description {
  margin-top: 4px;
}
.memory-toggle {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    &:checked + .memory-toggle__track {
      background: var(--ai-ok);
      &::after {
        transform: translateX(16px);
      }
    }
    &:focus-visible + .memory-toggle__track {
      outline: 2px solid var(--md-text-secondary);
      outline-offset: 3px;
    }
    &:disabled {
      cursor: default;
      + .memory-toggle__track {
        opacity: 0.5;
      }
    }
  }
}
.memory-toggle__track {
  width: 36px;
  height: 20px;
  border-radius: 10px;
  background: var(--md-neutral-300);
  pointer-events: none;
  &::after {
    content: "";
    display: block;
    width: 16px;
    height: 16px;
    margin: 2px;
    border-radius: 50%;
    background: #fff;
  }
}
.memory-status {
  min-height: 22px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  &.is-remembering {
    color: #2563eb;
  }
}
.memory-status__brain {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  animation: memory-pulse 1.6s ease-in-out infinite;
}
@keyframes memory-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.12);
  }
}
@media (prefers-reduced-motion: reduce) {
  .memory-status__brain {
    animation: none;
  }
}
.memory-error {
  margin: 0;
  color: var(--el-color-danger, #b42318);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.memory-button {
  padding: 6px 10px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: var(--md-radius-md, 4px);
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font: inherit;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--md-neutral-100, #f2f3f5);
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
}
.memory-button--primary {
  border-color: var(--md-text-primary);
  background: var(--md-text-primary);
  color: #fff;
  &:hover:not(:disabled) {
    background: var(--md-text-regular);
  }
}
.memory-danger {
  color: var(--el-color-danger, #b42318);
}
.memory-refresh,
.memory-count {
  margin-left: auto;
}
.memory-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  border-radius: var(--md-radius-md);
  background: var(--md-neutral-50);
}
.memory-filters .memory-button {
  border-color: transparent;
  background: transparent;
  &.is-active {
    background: #fff;
    color: var(--md-text-primary);
    font-weight: 600;
  }
}
.memory-count {
  color: var(--md-text-regular, #4b5058);
  font-size: 12px;
}
.memory-input {
  width: 100%;
  min-width: 0;
  padding: 7px 9px;
  box-sizing: border-box;
  border: 1px solid var(--md-border-color, #dcdfe6);
  border-radius: var(--md-radius-md, 4px);
  background: #fff;
  color: var(--md-text-primary);
  font: inherit;
  line-height: 1.7;
  caret-color: var(--md-text-primary);
  &::placeholder {
    color: var(--md-text-regular, #4b5058);
  }
}
.memory-search {
  flex: 1 1 180px;
}
.memory-confirm {
  padding: 12px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: var(--md-radius-md, 4px);
  background: var(--md-neutral-50, #fafafa);
  p {
    margin: 0 0 8px;
    line-height: 1.7;
  }
}
.memory-empty {
  margin: 0;
  padding: 20px 0;
  color: var(--md-text-regular, #4b5058);
  line-height: 1.7;
}
.memory-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.memory-entry {
  padding: 16px 0;
  border-top: 1px solid var(--md-neutral-200, #e4e7ed);
  overflow-wrap: anywhere;
}
.memory-meta {
  color: var(--md-text-regular, #4b5058);
  font-size: 12px;
  line-height: 1.7;
}
.memory-text {
  margin: 0 0 8px;
  white-space: pre-wrap;
  line-height: 1.8;
}
.memory-source {
  margin: 8px 0 12px;
  color: var(--md-text-regular, #4b5058);
  font-size: 12px;
  line-height: 1.7;
  summary {
    width: fit-content;
    cursor: pointer;
  }
  blockquote {
    margin: 8px 0;
    padding: 8px 12px;
    background: var(--md-neutral-50, #fafafa);
    white-space: pre-wrap;
  }
  p {
    margin: 4px 0;
  }
}
.memory-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0;
  textarea {
    resize: vertical;
  }
}
.memory-actions {
  justify-content: flex-end;
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--md-text-regular, #4b5058);
  outline-offset: 3px;
}
.memory-settings ::selection {
  background: var(--md-neutral-200, #e4e7ed);
  color: var(--md-text-primary);
}
</style>
