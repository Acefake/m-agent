<template>
  <!-- 设置面板的「供应商」分区：弹层外壳与左侧导航由 AiSettings 提供 -->
  <div class="ai-section">
    <header class="ai-section__head">
      <button
        v-if="view === 'form'"
        class="ai-section__back"
        type="button"
        title="返回列表"
        aria-label="返回列表"
        @click="backToList"
      >
        <AiIcon :icon="ICONS['chevron-right']" />
      </button>
      <h3 class="ai-section__title">{{ view === "list" ? "供应商" : editing ? "编辑供应商" : "添加供应商" }}</h3>
    </header>

    <div
      v-if="view === 'list'"
      class="ai-section__body"
    >
      <p class="ai-dialog__lead">为不同供应商分别配置密钥与模型，之后在输入区切换要使用的模型。</p>

      <div class="ai-fieldset">
        <span class="ai-fieldset__legend">快速添加</span>
        <div class="ai-presets">
          <button
            v-for="preset in AI_PROVIDER_PRESETS"
            :key="preset.name"
            class="ai-preset"
            type="button"
            @click="addFromPreset(preset)"
          >
            <BrandLogo
              class="ai-preset__logo"
              :name="preset.name"
              brand-color
            />
            <span>{{ preset.name }}</span>
          </button>
        </div>
      </div>

      <div class="ai-fieldset">
        <span class="ai-fieldset__legend">已添加</span>
        <p
          v-if="!settings.profiles.length"
          class="ai-dialog__empty"
        >
          还没有配置供应商，点上方快速添加，或选择「自定义 / Custom」手动填写。
        </p>
        <ul
          v-else
          class="ai-profile-list"
        >
          <li
            v-for="profile in settings.profiles"
            :key="profile.id"
            class="ai-profile"
          >
            <button
              class="ai-profile__main"
              type="button"
              @click="editProfile(profile.id)"
            >
              <BrandLogo
                class="ai-profile__logo"
                :name="profile.name"
                brand-color
              />
              <span class="ai-profile__text">
                <span class="ai-profile__name">{{ profile.name || "未命名" }}</span>
                <span class="ai-profile__model">{{ profile.model || "未填写模型" }}</span>
              </span>
            </button>

            <template v-if="pendingDeleteId === profile.id">
              <button
                class="ai-profile__danger"
                type="button"
                @click="deleteProfile(profile.id)"
              >
                删除
              </button>
              <button
                class="ai-profile__use"
                type="button"
                @click="pendingDeleteId = ''"
              >
                取消
              </button>
            </template>
            <template v-else>
              <span
                v-if="profile.id === settings.activeProfileId"
                class="ai-profile__badge"
              >
                使用中
              </span>
              <button
                v-else
                class="ai-profile__use"
                type="button"
                @click="activateProfile(profile.id)"
              >
                设为使用
              </button>
              <button
                class="ai-profile__remove"
                type="button"
                title="删除配置"
                aria-label="删除配置"
                :disabled="settings.profiles.length <= 1"
                @click="pendingDeleteId = profile.id"
              >
                <AiIcon :icon="ICONS['trash-2']" />
              </button>
            </template>
          </li>
        </ul>
      </div>

      <p class="ai-dialog__note">配置保存在本机；API Key 随插件设置保存，请求由插件 Node 服务代理发送。</p>
    </div>

    <div
      v-else-if="editing"
      class="ai-section__body"
    >
      <div class="ai-field">
        <span class="ai-field__label">提供商</span>
        <div class="ai-field__control">
          <AiSelect
            class="ai-field__input"
            :model-value="presetName"
            label="提供商"
            :options="AI_PROVIDER_PRESETS.map(preset => ({ value: preset.name, label: preset.name }))"
            @update:model-value="handlePresetChange"
          >
            <template #icon>
              <BrandLogo
                class="ai-field__provider-logo"
                :name="editing.name"
                brand-color
              />
            </template>
          </AiSelect>
        </div>
      </div>

      <label
        v-if="showBaseURL"
        class="ai-field"
      >
        <span class="ai-field__label">接口地址</span>
        <input
          v-model="editing.baseURL"
          class="ai-field__input"
          type="text"
          placeholder="https://api.example.com/v1"
        />
        <span class="ai-field__hint">只填到 /v1，不要带 /chat/completions</span>
      </label>

      <label class="ai-field">
        <span class="ai-field__label">API Key</span>
        <span class="ai-field__control">
          <input
            v-model="apiKeyInput"
            class="ai-field__input"
            :type="apiKeyVisible ? 'text' : 'password'"
            :placeholder="keyPlaceholder"
          />
          <button
            class="ai-field__eye"
            type="button"
            :aria-label="apiKeyVisible ? '隐藏密钥' : '显示密钥'"
            @click="apiKeyVisible = !apiKeyVisible"
          >
            <AiIcon
              v-if="apiKeyVisible"
              :icon="ICONS.eye"
            />
            <AiIcon
              v-else
              :icon="ICONS['eye-off']"
            />
          </button>
        </span>
        <span
          v-if="keyHint"
          class="ai-field__hint"
        >
          {{ keyHint }}
        </span>
      </label>

      <label class="ai-field">
        <span class="ai-field__label">额外请求头</span>
        <textarea
          v-model="editing.extraHeaders"
          class="ai-field__input ai-field__textarea"
          rows="2"
          placeholder="每行一条，如 x-opencode-session: 会话ID"
        ></textarea>
        <span class="ai-field__hint">部分网关在标准协议外要求附加头（OpenCode Go 需要 x-opencode-session，新配置已自动生成）</span>
      </label>

      <div class="ai-field">
        <span class="ai-field__label">模型</span>
        <div class="ai-segment">
          <button
            class="ai-segment__item"
            :class="{ 'is-active': modelMode === 'all' }"
            type="button"
            @click="editing.modelMode = 'all'"
          >
            全部模型
          </button>
          <button
            class="ai-segment__item"
            :class="{ 'is-active': modelMode === 'single' }"
            type="button"
            @click="editing.modelMode = 'single'"
          >
            指定模型
          </button>
        </div>

        <ul
          v-if="models.length"
          class="ai-model-list"
        >
          <li
            v-for="info in models"
            :key="info.id"
          >
            <button
              class="ai-model-list__item"
              :class="{ 'is-selected': modelMode === 'single' && info.id === editing.model, 'is-static': modelMode === 'all' }"
              type="button"
              :disabled="modelMode === 'all'"
              :title="info.id"
              @click="selectSingleModel(info)"
            >
              <span class="ai-model-list__name">{{ info.name || info.id }}</span>
              <span class="ai-model-list__id">{{ info.id }}</span>
              <span
                v-if="info.contextLength"
                class="ai-model-list__meta"
              >
                {{ formatContextChip(info.contextLength) }}
              </span>
            </button>
          </li>
        </ul>

        <p
          v-else
          class="ai-field__hint"
        >
          {{
            modelHint || (modelMode === "all" ? "默认使用该供应商的全部模型，先获取一次模型列表" : "尚未获取模型列表，可直接手填模型名称")
          }}
        </p>

        <div class="ai-field__row">
          <button
            class="ai-field__action"
            type="button"
            :disabled="modelLoading"
            @click="loadModels(true)"
          >
            {{ modelLoading ? "获取中" : models.length ? "刷新列表" : "获取模型列表" }}
          </button>
          <span
            v-if="models.length"
            class="ai-field__hint"
          >
            {{ modelMode === "all" ? `共 ${models.length} 个模型，输入区可自由切换` : "点选要使用的模型" }}
          </span>
        </div>

        <input
          v-if="modelMode === 'single' && !models.length"
          v-model="editing.model"
          class="ai-field__input"
          type="text"
          placeholder="例如 gpt-4o 或 deepseek-chat"
        />
      </div>

      <template v-if="isCustomProvider">
        <label class="ai-field">
          <span class="ai-field__label">推理强度</span>
          <AiSelect
            class="ai-field__input"
            :model-value="editing.effort ?? ''"
            label="推理强度"
            :options="AI_EFFORT_OPTIONS"
            @update:model-value="handleEffortChange"
          />
        </label>

        <label class="ai-field">
          <span class="ai-field__label">上下文长度</span>
          <input
            v-model.number="editing.contextLength"
            class="ai-field__input"
            type="number"
            min="0"
            step="1000"
            placeholder="使用模型默认值"
          />
        </label>
        <div class="ai-chips">
          <button
            v-for="option in CONTEXT_PRESETS"
            :key="option"
            class="ai-chip"
            type="button"
            @click="editing.contextLength = option"
          >
            {{ formatContextChip(option) }}
          </button>
        </div>
      </template>

      <p
        v-if="message"
        class="ai-dialog__message"
      >
        {{ message }}
      </p>
    </div>

    <footer
      v-if="view === 'form'"
      class="ai-dialog__foot"
    >
      <button
        class="ai-btn ai-btn--danger"
        type="button"
        :disabled="settings.profiles.length <= 1"
        @click="removeEditing"
      >
        删除
      </button>
      <span class="ai-dialog__spacer" />
      <button
        class="ai-btn ai-btn--ghost"
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
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from "vue";
import { describeAiError } from "../../../ai-assistant/ai-error";
import { ICONS } from "./icons";
import { fetchProviderModels, type AiModelInfo } from "../../../ai-assistant/provider/models";
import {
  AI_EFFORT_OPTIONS,
  AI_PROVIDER_PRESETS,
  createProfileFromPreset,
  loadAiProviderSettings,
  resolvePresetHeaders,
  updateAiProviderSettings
} from "../../../ai-assistant/provider/providerConfig";
import type { AiProviderProfile, AiProviderSettings } from "../../../ai-assistant/types";
import AiSelect from "./AiSelect.vue";
import AiIcon from "./AiIcon.vue";
import BrandLogo from "./BrandLogo.vue";

/** Key 状态：插件没有系统密钥库，Key 随设置保存在本机 */
interface KeyState {
  configured: boolean;
  /** 桌面端数据落在用户数据目录、Web 端落在 localStorage，都等同于本机明文 */
  secure: boolean;
}

/** 上下文长度的快捷选项（取整数值，避免出现 33K / 1.048576M 这类标签） */
const CONTEXT_PRESETS = [32000, 128000, 256000, 1000000];

const emit = defineEmits<{
  (event: "saved"): void;
  /** 列表视图里按 Esc：请求设置面板关闭 */
  (event: "dismiss"): void;
}>();

const view = ref<"list" | "form">("list");
const settings = ref<AiProviderSettings>({ activeProfileId: "", profiles: [] });
const editingId = ref("");
const apiKeyInput = ref("");
const apiKeyVisible = ref(false);
const message = ref("");
const models = ref<AiModelInfo[]>([]);
const modelLoading = ref(false);
const modelHint = ref("");
const keyStates = reactive<Record<string, KeyState | undefined>>({});
const pendingDeleteId = ref("");

const editing = computed(() => settings.value.profiles.find(profile => profile.id === editingId.value));
const presetName = computed(() => AI_PROVIDER_PRESETS.find(preset => preset.baseURL === editing.value?.baseURL)?.name ?? "自定义 / Custom");
const modelMode = computed(() => editing.value?.modelMode ?? "all");
/** 自定义端点没有模型列表兜底，允许手配推理强度与上下文长度 */
const isCustomProvider = computed(() => presetName.value === "自定义 / Custom");
/** 本地或自定义端点需要手填地址，云端厂商用预设地址 */
const showBaseURL = computed(() => {
  const baseURL = editing.value?.baseURL ?? "";
  return !baseURL || /localhost|127\.0\.0\.1/.test(baseURL);
});
const keyPlaceholder = computed(() => (keyStates[editingId.value]?.configured ? "已配置，留空表示不修改" : "输入你的 API Key"));
const keyHint = computed(() => {
  const state = keyStates[editingId.value];
  const storageHint = !state?.configured
    ? "Key 随插件设置保存在本机（插件无独立密钥库）"
    : "已保存在本机设置中；请求由插件 Node 服务代理发送，Key 只在请求头传输";
  const secureHint = state && !state.secure ? "；请输入供应商提供的密钥并注意本机安全" : "";

  const isCommandCode = (editing.value?.baseURL ?? "").includes("commandcode.ai");
  return isCommandCode ? `${storageHint}${secureHint}；API Key 可在 commandcode.ai/settings/keys 创建` : `${storageHint}${secureHint}`;
});

// 分区由设置面板按需挂载：进入即按最新设置初始化
open();
window.addEventListener("keydown", handleKeydown);
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));

/** Esc：表单里退回列表，列表里请求设置面板关闭 */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;

  if (view.value === "form") backToList();
  else emit("dismiss");
}

function open(): void {
  settings.value = JSON.parse(JSON.stringify(loadAiProviderSettings())) as AiProviderSettings;
  editingId.value = settings.value.activeProfileId || settings.value.profiles[0]?.id || "";
  apiKeyInput.value = "";
  apiKeyVisible.value = false;
  message.value = "";
  models.value = [];
  modelHint.value = "";
  pendingDeleteId.value = "";
  view.value = "list";
  void refreshKeyStates();
}

/** 返回列表并丢弃本次表单里未保存的改动 */
function backToList(): void {
  settings.value = JSON.parse(JSON.stringify(loadAiProviderSettings())) as AiProviderSettings;
  editingId.value = settings.value.activeProfileId || settings.value.profiles[0]?.id || "";
  apiKeyInput.value = "";
  apiKeyVisible.value = false;
  message.value = "";
  pendingDeleteId.value = "";
  view.value = "list";
}

function addFromPreset(preset: Omit<AiProviderProfile, "id">): void {
  const profile = createProfileFromPreset(preset);
  profile.modelMode = "all";
  settings.value.profiles.push(profile);
  editingId.value = profile.id;
  view.value = "form";
  message.value = "";
  void loadModels(false);
}

function editProfile(id: string): void {
  editingId.value = id;
  view.value = "form";
  apiKeyInput.value = "";
  apiKeyVisible.value = false;
  message.value = "";
  void loadModels(false);
}

/** 把某条配置设为当前使用（列表页即时生效） */
function activateProfile(id: string): void {
  if (settings.value.activeProfileId === id) return;

  settings.value = updateAiProviderSettings(current => {
    current.activeProfileId = id;
  });
  emit("saved");
}

function handlePresetChange(name: string): void {
  const preset = AI_PROVIDER_PRESETS.find(item => item.name === name);
  if (!preset || !editing.value) return;

  editing.value.name = preset.name;
  editing.value.baseURL = preset.baseURL;
  editing.value.model = preset.model;
  editing.value.contextLength = preset.contextLength;
  // 预设自带会话占位（如 OpenCode Go）：切预设时生成一份新的会话 ID
  editing.value.extraHeaders = resolvePresetHeaders(preset);
  models.value = [];
  modelHint.value = "";
}

/** 删除某条配置：即时保存（Key 随 profile 一起删除） */
async function deleteProfile(id: string): Promise<void> {
  const index = settings.value.profiles.findIndex(profile => profile.id === id);
  if (index < 0 || settings.value.profiles.length <= 1) return;

  const removed = settings.value.profiles[index];
  settings.value = updateAiProviderSettings(current => {
    current.profiles = current.profiles.filter(profile => profile.id !== removed.id);
    if (current.activeProfileId === removed.id) current.activeProfileId = current.profiles[0]?.id ?? "";
    current.dataSharingConfirmedProfileIds = (current.dataSharingConfirmedProfileIds ?? []).filter(id => id !== removed.id);
  });

  pendingDeleteId.value = "";
  editingId.value = settings.value.activeProfileId;
  emit("saved");
  void refreshKeyStates();
}

/** 拉取供应商的模型列表，用于模型下拉与上下文长度补全 */
async function loadModels(refresh: boolean): Promise<void> {
  const profile = editing.value;
  if (!profile || !profile.baseURL.trim()) return;

  modelLoading.value = true;
  modelHint.value = "";

  try {
    models.value = await fetchProviderModels(profile, { refresh });
    modelHint.value = `已获取 ${models.value.length} 个模型`;
    applyModelContext();
  } catch (error) {
    modelHint.value = describeAiError(error) || "获取模型列表失败，可手动填写模型";
  } finally {
    modelLoading.value = false;
  }
}

/** 用模型列表里的信息补全上下文长度 */
function applyModelContext(): void {
  const profile = editing.value;
  if (!profile) return;

  const info = models.value.find(item => item.id === profile.model);
  if (info?.contextLength) profile.contextLength = info.contextLength;
}

/** 指定模型模式下从列表里选一个 */
function selectSingleModel(info: AiModelInfo): void {
  if (modelMode.value !== "single" || !editing.value) return;

  editing.value.model = info.id;
  applyModelContext();
}

function handleEffortChange(value: string): void {
  if (!editing.value) return;

  editing.value.effort = value || undefined;
}

/** 上下文长度展示：百万级保留一位小数，其余收敛到 K */
function formatContextChip(value: number): string {
  if (value >= 1000000) return `${Math.round((value / 1000000) * 10) / 10}M`;
  return `${Math.round(value / 1000)}K`;
}

async function removeEditing(): Promise<void> {
  const id = editingId.value;
  if (!id) return;

  await deleteProfile(id);
  backToList();
}

/** Key 状态直接来自当前设置：Key 就存在 profile 上 */
function refreshKeyStates(): void {
  for (const profile of settings.value.profiles) {
    keyStates[profile.id] = { configured: Boolean(profile.apiKey?.trim()), secure: false };
  }
}

async function save(): Promise<void> {
  const profile = editing.value;
  if (!profile) return;

  if (!profile.baseURL.trim()) {
    message.value = "请填写接口地址";
    return;
  }

  if ((profile.modelMode ?? "all") === "single" && !profile.model.trim()) {
    message.value = "请指定要使用的模型";
    return;
  }

  // 表单里的 Key：留空表示不修改，保存时写回 profile
  const newKey = apiKeyInput.value.trim() || profile.apiKey?.trim();

  settings.value = updateAiProviderSettings(current => {
    const savedProfile = current.profiles.find(item => item.id === profile.id);
    const isBaseURLChanged = savedProfile?.baseURL !== profile.baseURL;
    if (savedProfile) Object.assign(savedProfile, profile, { apiKey: newKey });
    else current.profiles.push({ ...profile, apiKey: newKey });
    if (isBaseURLChanged) {
      current.dataSharingConfirmedProfileIds = (current.dataSharingConfirmedProfileIds ?? []).filter(id => id !== profile.id);
    }
  });

  apiKeyInput.value = "";
  keyStates[profile.id] = { configured: Boolean(newKey), secure: false };
  emit("saved");
  backToList();
  void refreshKeyStates();
}
</script>

<style lang="scss" scoped>
/** 面板内滚动条一律隐藏，滚动交互不变 */
.ai-model-list {
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.ai-dialog__lead {
  margin: 0;
  color: var(--md-text-secondary, #8f959e);
  font-size: 13px;
  line-height: 1.7;
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
  color: var(--md-text-placeholder, #a8abb2);
  font-size: 12px;
  line-height: 1.6;
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: 8px;
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s,
    color 0.15s;

  &:hover {
    border-color: var(--ai-accent);
    background: var(--ai-accent-soft);
    color: var(--ai-accent);
  }
}

/* 品牌 logo 的尺寸：BrandLogo 自身宽高为 1em，这里用 font-size 控制大小 */
.ai-preset__logo {
  font-size: 16px;
}

.ai-profile-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-profile {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: 8px;
  background: #fff;
  transition: border-color 0.15s;

  &:hover {
    border-color: var(--ai-accent);
  }
}

.ai-profile__main {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-family: inherit;
}

.ai-profile__text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.ai-profile__logo {
  font-size: 16px;
}

.ai-profile__name {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--md-text-primary, #1f2329);
  font-size: 13px;
  font-weight: 500;
}

.ai-profile__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--ai-accent-soft);
  color: var(--ai-accent);
  font-size: 12px;
  font-weight: 400;
  line-height: 15px;
}

.ai-profile__model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--md-text-secondary, #8f959e);
  font-size: 12px;
}

.ai-profile__use {
  flex-shrink: 0;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--md-border-color, #dcdfe6);
  border-radius: 6px;
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font-family: inherit;
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

.ai-profile__danger {
  flex-shrink: 0;
  height: 24px;
  padding: 0 9px;
  border: 1px solid var(--el-color-danger, #dc2828);
  border-radius: 6px;
  background: var(--el-color-danger-light-9, #fef0f0);
  color: var(--el-color-danger, #dc2828);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.85;
  }
}

.ai-profile__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--md-text-placeholder, #a8abb2);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;

  svg {
    width: 13px;
    height: 13px;

    path,
    circle,
    rect,
    line {
      stroke-width: 1.9;
    }
  }

  &:hover:not(:disabled) {
    background: var(--el-color-danger-light-9, #fef0f0);
    color: var(--el-color-danger, #dc2828);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.ai-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ai-field__label {
  color: var(--md-text-regular, #4b5058);
  font-size: 13px;
}

.ai-field__control {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-field__input {
  height: 32px;
  min-width: 0;
  padding: 0 10px;
  box-sizing: border-box;
  border: 1px solid var(--md-border-color, #dcdfe6);
  border-radius: 6px;
  background: #fff;
  color: var(--md-text-primary, #1f2329);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;

  &::placeholder {
    color: var(--md-text-placeholder, #a8abb2);
  }

  &:focus,
  &:focus-visible {
    border-color: var(--ai-accent);
    box-shadow: 0 0 0 3px var(--ai-accent-soft);
    outline: none;
  }
}

/** 纵向布局下占满整行，行内布局（带按钮）时占剩余宽度 */
.ai-field > .ai-field__input {
  width: 100%;
}

/** 额外请求头等多行输入：高度自适应，保持与单行输入同一视觉 */
.ai-field__textarea {
  height: auto;
  min-height: 56px;
  padding: 6px 10px;
  line-height: 1.6;
  resize: vertical;
}

.ai-field__control > .ai-field__input {
  flex: 1;
}

.ai-field__eye {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--md-text-placeholder, #a8abb2);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;

  svg {
    width: 15px;
    height: 15px;

    path,
    circle,
    rect,
    line {
      stroke-width: 1.8;
    }
  }

  &:hover {
    background: var(--md-neutral-100, #f2f3f5);
    color: var(--md-text-primary, #1f2329);
  }
}

.ai-field__action {
  flex-shrink: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--md-border-color, #dcdfe6);
  border-radius: 6px;
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;

  &:hover:not(:disabled) {
    border-color: var(--ai-accent);
    color: var(--ai-accent);
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.ai-field__action--wide {
  width: 100%;
}

.ai-field__row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ai-model-list {
  max-height: 200px;
  margin: 0;
  padding: 4px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: 8px;
  overflow-y: auto;
  list-style: none;
}

.ai-model-list__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s;

  &:hover:not(:disabled) {
    background: var(--md-neutral-100, #f2f3f5);
  }

  &.is-static {
    cursor: default;
  }

  &.is-selected {
    background: var(--ai-accent-soft);
  }
}

.ai-model-list__name {
  flex-shrink: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--md-text-primary, #1f2329);
}

.ai-model-list__id {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--md-text-placeholder, #a8abb2);
  font-family: Consolas, "Courier New", monospace;
  font-size: 11px;
}

.ai-model-list__meta {
  flex-shrink: 0;
  color: var(--md-text-placeholder, #a8abb2);
  font-size: 11px;
}

.ai-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-chip {
  padding: 3px 9px;
  border: 1px solid var(--md-neutral-200, #e4e7ed);
  border-radius: 999px;
  background: #fff;
  color: var(--md-text-regular, #4b5058);
  font-family: inherit;
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

/* 品牌 logo 的尺寸：BrandLogo 自身宽高为 1em，这里用 font-size 控制大小 */
.ai-field__provider-logo {
  margin-right: 2px;
  font-size: 16px;
}

.ai-segment {
  display: inline-flex;
  align-self: flex-start;
  padding: 2px;
  border-radius: 8px;
  background: var(--md-neutral-100, #f2f3f5);
}

.ai-segment__item {
  padding: 4px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--md-text-secondary, #8f959e);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;

  &:hover {
    color: var(--md-text-primary, #1f2329);
  }

  &.is-active {
    background: #fff;
    color: var(--ai-accent);
    font-weight: 500;
  }
}

.ai-field__hint {
  color: var(--md-text-placeholder, #a8abb2);
  font-size: 12px;
  line-height: 1.6;
}

.ai-dialog__message {
  margin: 0;
  padding: 7px 10px;
  border: 1px solid var(--md-neutral-200);
  border-radius: var(--md-radius-md, 4px);
  background: var(--md-neutral-100, #f2f3f5);
  color: var(--md-text-regular, #4b5058);
  font-size: 12px;
  line-height: 1.6;
}

.ai-dialog__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--md-neutral-200, #e4e7ed);
}

.ai-dialog__spacer {
  flex: 1;
}

.ai-btn {
  height: 32px;
  padding: 0 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s,
    color 0.15s;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &--primary {
    background: var(--ai-accent);
    color: #fff;

    &:hover:not(:disabled) {
      opacity: 0.9;
    }
  }

  &--ghost {
    border-color: var(--md-border-color, #dcdfe6);
    background: #fff;
    color: var(--md-text-regular, #4b5058);

    &:hover:not(:disabled) {
      border-color: var(--ai-accent);
      color: var(--ai-accent);
    }
  }

  &--danger {
    border-color: transparent;
    background: transparent;
    color: var(--el-color-danger, #dc2828);

    &:hover:not(:disabled) {
      background: var(--el-color-danger-light-9, #fef0f0);
    }
  }
}

button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .ai-dialog-mask,
  .ai-dialog {
    animation: none;
  }

  .ai-dialog__close,
  .ai-preset,
  .ai-profile,
  .ai-field__input,
  .ai-field__eye,
  .ai-field__action,
  .ai-segment__item,
  .ai-btn {
    transition: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .ai-dialog-mask {
    background: rgba(15, 18, 23, 0.4);
    backdrop-filter: none;
  }
}
</style>
