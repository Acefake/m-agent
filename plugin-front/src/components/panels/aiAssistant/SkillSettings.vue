<template>
  <!-- 设置面板的「技能」分区：页面外壳由 AiSettings 提供 -->
  <div class="ai-section">
    <header class="ai-section__head">
      <button
        v-if="view !== 'list'"
        class="ai-section__back"
        type="button"
        title="返回列表"
        aria-label="返回列表"
        @click="backToList"
      >
        <AiIcon :icon="ICONS['chevron-right']" />
      </button>
      <h3 class="ai-section__title">
        {{ view === "list" ? "建模技能" : view === "detail" ? "技能详情" : editingId ? "编辑技能" : "新建技能" }}
      </h3>
    </header>

    <div
      v-if="view === 'list'"
      class="ai-section__body"
    >
      <div class="skill-toolbar">
        <input
          v-model="search"
          class="ai-field__input"
          type="search"
          placeholder="搜索技能"
          aria-label="搜索技能"
        />
        <button
          class="ai-btn ai-btn--primary"
          type="button"
          @click="emit('create')"
        >
          新建技能
        </button>
      </div>
      <p class="ai-dialog__lead">把常用建模流程保存为技能，输入 /名称 即可在对话中调用。</p>
      <div
        class="skill-filters"
        aria-label="技能筛选"
      >
        <button
          v-for="item in filters"
          :key="item.value"
          type="button"
          :class="{ 'is-active': filter === item.value }"
          :aria-pressed="filter === item.value"
          @click="filter = item.value"
        >
          {{ item.label }}
        </button>
        <span>默认启用 {{ enabledCount }} 个</span>
      </div>
      <ul class="ai-skill-list">
        <li
          v-for="skill in filteredSkills"
          :key="skill.id"
          class="ai-skill"
        >
          <button
            class="ai-skill__main"
            type="button"
            @click="showDetail(skill.id)"
          >
            <span class="skill-card-heading">
              <BuiltinAvatar
                class="skill-avatar"
                :name="skill.name"
                :size="40"
              />
              <span class="ai-skill__name">{{ skill.name }}</span>
            </span>
            <span class="ai-skill__desc">{{ skill.description || "自定义建模工作流程" }}</span>
            <span class="skill-tags">
              <span class="ai-skill__badge">{{ skill.builtin ? "内置技能" : "自定义" }}</span>
              <span class="ai-skill__badge">{{ skill.enabled ? "默认启用" : "按需调用" }}</span>
            </span>
          </button>
          <div class="skill-card-footer">
            <span>/{{ skill.name }}</span>
            <button
              class="ai-skill__toggle"
              type="button"
              @click="toggleSkill(skill.id)"
            >
              {{ skill.enabled ? "停用" : "启用" }}
            </button>
          </div>
        </li>
      </ul>
      <p
        v-if="!filteredSkills.length"
        class="ai-dialog__empty"
      >
        {{ search ? "没有匹配的技能，试试其他关键词。" : "暂无技能，可以新建或添加下方预设。" }}
      </p>
      <div
        v-if="availablePresets.length && !search"
        class="ai-fieldset"
      >
        <h4 class="ai-fieldset__legend">可添加的技能</h4>
        <div class="skill-presets">
          <button
            v-for="preset in availablePresets"
            :key="preset.name"
            class="skill-preset"
            type="button"
            @click="addPreset(preset)"
          >
            <strong>{{ preset.name }}</strong>
            <span>{{ preset.description }}</span>
            <small>添加技能 ＋</small>
          </button>
        </div>
      </div>
      <p
        v-if="contentWarning"
        class="ai-dialog__note"
      >
        {{ contentWarning }}
      </p>
    </div>
    <div
      v-else-if="view === 'detail' && selectedSkill"
      class="ai-section__body skill-detail"
    >
      <div class="skill-detail__hero">
        <BuiltinAvatar
          class="skill-avatar"
          :name="selectedSkill.name"
          :size="48"
        />
        <div>
          <h2>{{ selectedSkill.name }}</h2>
          <span class="ai-skill__badge">{{ selectedSkill.builtin ? "内置技能" : "自定义技能" }}</span>
        </div>
      </div>
      <p class="skill-detail__description">{{ selectedSkill.description || "自定义建模工作流程" }}</p>
      <div class="skill-detail__actions">
        <button
          class="ai-btn ai-btn--primary"
          type="button"
          @click="toggleSkill(selectedSkill.id)"
        >
          {{ selectedSkill.enabled ? "取消默认启用" : "默认启用" }}
        </button>
        <button
          v-if="!selectedSkill.builtin"
          class="ai-btn"
          type="button"
          @click="editSkill(selectedSkill.id)"
        >
          编辑技能
        </button>
        <button
          v-if="!selectedSkill.builtin"
          class="ai-skill__danger"
          type="button"
          @click="deleteSelected"
        >
          {{ pendingDeleteId === selectedSkill.id ? "确认删除" : "删除技能" }}
        </button>
      </div>
      <div class="skill-detail__meta">
        <span>
          调用方式
          <strong>/{{ selectedSkill.name }}</strong>
        </span>
        <span>
          使用状态
          <strong>{{ selectedSkill.enabled ? "每轮默认启用" : "按需调用" }}</strong>
        </span>
      </div>
      <h4>技能帮你做</h4>
      <pre class="skill-detail__content">{{ selectedSkill.content }}</pre>
    </div>
    <div
      v-else
      class="ai-section__body"
    >
      <label class="ai-field">
        <span class="ai-field__label">名称（调用名）</span>
        <input
          v-model="draft.name"
          class="ai-field__input"
          type="text"
          placeholder="如 write-sysml"
          @blur="draft.name = normalizeSkillName(draft.name)"
        />
        <span class="ai-field__hint">2–32 位小写字母、数字或连字符；输入框里用 /名称 调用</span>
      </label>

      <label class="ai-field">
        <span class="ai-field__label">说明</span>
        <input
          v-model="draft.description"
          class="ai-field__input"
          type="text"
          placeholder="一句话说明这个技能做什么"
        />
      </label>

      <label class="ai-field">
        <span class="ai-field__label">指令正文</span>
        <textarea
          v-model="draft.content"
          class="ai-field__textarea"
          rows="8"
          placeholder="写给模型的指令，例如：写 SysML 文本时，先读取目标命名空间原文，只追加声明，不要重排已有内容…"
        ></textarea>
      </label>

      <label class="ai-switch">
        <input
          v-model="draft.enabled"
          type="checkbox"
        />
        <span>默认启用（每轮对话都带上；不勾选则只在输入 /名称 时生效）</span>
      </label>

      <p
        v-if="message"
        class="ai-dialog__error"
      >
        {{ message }}
      </p>

      <div class="ai-dialog__actions">
        <button
          class="ai-btn"
          type="button"
          @click="backToList"
        >
          取消
        </button>
        <button
          class="ai-btn ai-btn--primary"
          type="button"
          @click="save"
        >
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { ICONS } from "./icons";
import { AI_SKILL_PRESETS, loadAiProviderSettings, updateAiProviderSettings } from "../../../ai-assistant/provider/providerConfig";
import {
  SKILL_CONTENT_WARN_LENGTH,
  createSkill,
  normalizeSkillName,
  totalSkillContentLength,
  validateSkillName
} from "../../../ai-assistant/skills";
import type { AiSkill } from "../../../ai-assistant/types";
import AiIcon from "./AiIcon.vue";
import BuiltinAvatar from "./BuiltinAvatar.vue";

const emit = defineEmits<{
  (event: "saved"): void;
  (event: "create"): void;
  /** 列表视图里按 Esc：请求设置面板关闭 */
  (event: "dismiss"): void;
}>();

const view = ref<"list" | "form" | "detail">("list");
const skills = ref<AiSkill[]>([]);
const search = ref("");
const filter = ref("all");
const filters = [
  { value: "all", label: "全部" },
  { value: "builtin", label: "内置技能" },
  { value: "custom", label: "我的技能" }
];
const selectedId = ref("");
const selectedSkill = computed(() => skills.value.find(skill => skill.id === selectedId.value));
const filteredSkills = computed(() =>
  skills.value.filter(skill => {
    const matchesType = filter.value === "all" || (filter.value === "builtin" ? skill.builtin : !skill.builtin);
    return matchesType && `${skill.name} ${skill.description}`.toLowerCase().includes(search.value.trim().toLowerCase());
  })
);
function showDetail(id: string): void {
  selectedId.value = id;
  pendingDeleteId.value = "";
  view.value = "detail";
}
function deleteSelected(): void {
  if (!selectedSkill.value) return;
  const id = selectedSkill.value.id;
  if (pendingDeleteId.value !== id) {
    pendingDeleteId.value = id;
    return;
  }
  removeSkill(id);
  backToList();
}
const editingId = ref("");
const pendingDeleteId = ref("");
const message = ref("");
const draft = ref<AiSkill>(createSkill());

const enabledCount = computed(() => skills.value.filter(skill => skill.enabled).length);
/** 还没添加过的内置技能：加进来后沿用预设的启用状态（多数预设不启用，靠 /名称 单轮生效） */
const availablePresets = computed(() => {
  const configured = new Set(skills.value.map(skill => skill.name));
  return AI_SKILL_PRESETS.filter(preset => !configured.has(preset.name));
});
/** 默认启用的正文会随每轮请求发送，超量时提示（不阻断保存） */
const contentWarning = computed(() => {
  const total = totalSkillContentLength(skills.value);
  return total > SKILL_CONTENT_WARN_LENGTH ? `默认启用的技能正文共 ${total} 字符，会随每轮请求一起发送，建议精简或减少默认启用的数量` : "";
});

// 分区由设置面板按需挂载：进入即按最新设置初始化
reload();
window.addEventListener("keydown", handleKeydown);
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));

function reload(): void {
  skills.value = [...(loadAiProviderSettings().skills ?? [])];
  view.value = "list";
  pendingDeleteId.value = "";
  message.value = "";
}

/** Esc：表单里退回列表，列表里请求设置面板关闭 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;

  if (view.value !== "list") backToList();
  else emit("dismiss");
}

/** 写回设置：技能与供应商配置同层，走同一条持久化路径 */
function persist(): void {
  const next = [...skills.value];
  updateAiProviderSettings(settings => {
    settings.skills = next.length ? next : undefined;
  });
  emit("saved");
}

/** 添加内置技能：正文可继续在表单里改；启用状态沿用预设（多数预设不启用，避免每轮都带上） */
function addPreset(preset: Omit<AiSkill, "id">): void {
  skills.value = [...skills.value, createSkill({ ...preset })];
  persist();
}

function editSkill(id: string): void {
  const skill = skills.value.find(item => item.id === id);
  // 内置技能随产品分发，不允许编辑（内容以最新版本为准）
  if (!skill || skill.builtin) return;

  editingId.value = id;
  draft.value = { ...skill };
  message.value = "";
  view.value = "form";
}

function save(): void {
  const name = normalizeSkillName(draft.value.name);
  const invalid = validateSkillName(name, skills.value, editingId.value || undefined);
  if (invalid) {
    message.value = invalid;
    return;
  }

  if (!draft.value.content.trim()) {
    message.value = "请填写指令正文";
    return;
  }

  const next: AiSkill = {
    ...draft.value,
    name,
    description: draft.value.description.trim(),
    content: draft.value.content.trim()
  };
  const exists = skills.value.some(skill => skill.id === next.id);
  skills.value = exists ? skills.value.map(skill => (skill.id === next.id ? next : skill)) : [...skills.value, next];
  persist();
  backToList();
}

function toggleSkill(id: string): void {
  skills.value = skills.value.map(skill => (skill.id === id ? { ...skill, enabled: !skill.enabled } : skill));
  persist();
}

function removeSkill(id: string): void {
  const skill = skills.value.find(item => item.id === id);
  // 内置技能不可删除（即使绕过按钮触发也直接拒绝）
  if (!skill || skill.builtin) return;

  skills.value = skills.value.filter(item => item.id !== id);
  pendingDeleteId.value = "";
  persist();
}

/** 返回列表并丢弃表单里未保存的改动 */
function backToList(): void {
  view.value = "list";
  message.value = "";
  pendingDeleteId.value = "";
  draft.value = createSkill();
  editingId.value = "";
}
</script>

<style lang="scss" scoped>
/* 页面外壳由 AiSettings 提供，这里只保留分区自己的排版 */
.ai-dialog__lead {
  margin: 0;
  color: var(--md-text-secondary, #8f959e);
  font-size: 13px;
  line-height: 1.7;

  code {
    padding: 0 4px;
    border-radius: 3px;
    background: var(--md-neutral-100, #f2f3f5);
    color: var(--md-text-regular, #4b5058);
    font-family: Consolas, "Courier New", monospace;
  }
}

.ai-dialog__empty {
  margin: 0;
  padding: 14px;
  border: 1px dashed var(--md-neutral-300, #dcdfe6);
  border-radius: 8px;
  color: var(--md-text-secondary, #8f959e);
  font-size: 13px;
  line-height: 1.7;
  text-align: center;
}

.ai-dialog__note {
  margin: 0;
  color: var(--el-color-warning, #e6a23c);
  font-size: 12px;
  line-height: 1.6;
}

.ai-dialog__error {
  margin: 0;
  color: var(--el-color-danger, #dc2828);
  font-size: 12px;
}

.ai-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.ai-fieldset {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ai-fieldset__legend {
  color: var(--md-text-regular, #4b5058);
  font-size: 13px;
}

.ai-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-preset {
  padding: 5px 10px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: 8px;
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--ai-accent);
    color: var(--ai-accent);
  }
}

.ai-skill-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-skill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: 8px;
  background: #fff;
}

.ai-skill__main {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
  border: none;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }
}

.ai-skill__name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--md-text-primary, #1f2329);
  font-family: Consolas, "Courier New", monospace;
  font-size: 13px;
  font-weight: 500;
}

.ai-skill__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: #f4eeff;
  color: #6b3fd4;
  font-family: inherit;
  font-size: 12px;
  font-weight: 400;
  line-height: 15px;
}

.ai-skill__badge--builtin {
  background: var(--md-neutral-100, #f2f3f5);
  color: var(--md-text-secondary, #8f959e);
}

.ai-skill__desc {
  overflow: hidden;
  color: var(--md-text-secondary, #8f959e);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-skill__toggle,
.ai-skill__danger {
  flex-shrink: 0;
  padding: 3px 8px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: var(--md-radius-md, 4px);
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:hover {
    border-color: var(--ai-accent);
    color: var(--ai-accent);
  }
}

.ai-skill__danger:hover {
  border-color: var(--el-color-danger, #dc2828);
  color: var(--el-color-danger, #dc2828);
}

.ai-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ai-field__label {
  color: var(--md-text-regular, #4b5058);
  font-size: 13px;
}

.ai-field__input,
.ai-field__textarea {
  width: 100%;
  padding: 6px 9px;
  box-sizing: border-box;
  border: 1px solid var(--md-border-color, #dcdfe6);
  border-radius: var(--md-radius-md, 4px);
  background: #fff;
  color: var(--md-text-primary, #1f2329);
  font: inherit;
  font-size: 13px;
  outline: none;

  &:focus {
    border-color: var(--ai-accent);
  }

  &::placeholder {
    color: var(--md-text-placeholder, #a8abb2);
  }
}

.ai-field__textarea {
  resize: vertical;
  line-height: 1.6;
  font-family: Consolas, "Courier New", monospace;
}

.ai-field__hint {
  color: var(--md-text-placeholder, #a8abb2);
  font-size: 12px;
}

.ai-switch {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  color: var(--md-text-regular, #4b5058);
  font-size: 12px;
  line-height: 1.6;
  cursor: pointer;
}

.ai-btn {
  padding: 6px 12px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: var(--md-radius-md, 4px);
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    border-color: var(--ai-accent);
    color: var(--ai-accent);
  }
}

.ai-btn--primary {
  border-color: var(--ai-accent);
  background: var(--ai-accent);
  color: #fff;

  &:hover {
    color: #fff;
    opacity: 0.92;
  }
}

.skill-toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  .ai-field__input {
    max-width: 280px;
  }
  .ai-btn {
    flex-shrink: 0;
    margin-left: auto;
  }
}
.skill-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  button {
    padding: 7px 12px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--md-text-regular);
    cursor: pointer;
  }
  .is-active {
    background: #efefef;
    color: #181818;
    font-weight: 600;
  }
  > span {
    margin-left: auto;
    color: var(--md-text-secondary);
    font-size: 11px;
  }
}
.ai-skill-list,
.skill-presets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.ai-skill {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 20px;
  border-radius: 16px;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.025);
}
.ai-skill__main {
  gap: 14px;
  padding: 0;
}
.skill-card-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}
.skill-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  background: var(--md-neutral-100);
  color: var(--md-text-regular);
  border-radius: 12px;
  svg {
    width: 18px;
    height: 18px;
  }
}
.ai-skill__name {
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
}
.ai-skill__desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  white-space: normal;
  line-height: 1.7;
  font-size: 13px;
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-skill__badge {
  padding: 3px 7px;
  border-radius: 4px;
  background: #f3f3f3;
  color: var(--md-text-secondary);
}
.skill-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--md-text-secondary);
  font-size: 11px;
  > span {
    overflow-wrap: anywhere;
  }
}
.skill-preset {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  background: #fafafa;
  text-align: left;
  font: inherit;
  cursor: pointer;
  span {
    color: var(--md-text-secondary);
    line-height: 1.6;
  }
  small {
    color: #454545;
  }
}
.skill-detail__hero {
  display: flex;
  align-items: center;
  gap: 12px;
  h2 {
    margin: 0 0 6px;
    font-size: 18px;
    overflow-wrap: anywhere;
  }
}
.skill-detail__description {
  margin: 0;
  line-height: 1.8;
}
.skill-detail__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.skill-detail__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  padding: 14px 0;
  border-block: 1px solid #ededed;
  color: var(--md-text-secondary);
  span {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  strong {
    color: #454545;
    overflow-wrap: anywhere;
  }
}
.skill-detail h4 {
  margin: 8px 0 0;
  font-size: 15px;
}
.skill-detail__content {
  margin: 0;
  padding: 14px;
  border-radius: 10px;
  background: #f7f7f7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.7;
}
.ai-btn--primary {
  border-color: #181818;
  background: #181818;
}
button:focus-visible {
  outline: 2px solid #606060;
  outline-offset: 3px;
}
@container assistant (max-width: 760px) {
  .ai-skill-list,
  .skill-presets {
    grid-template-columns: minmax(0, 1fr);
  }
  .skill-toolbar {
    flex-wrap: wrap;
    .ai-field__input {
      max-width: none;
    }
  }
}
</style>
