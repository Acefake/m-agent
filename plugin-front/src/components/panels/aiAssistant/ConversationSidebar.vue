<script setup lang="ts">
import type { AiConversation, AiSettingsSection } from "../../../ai-assistant/types";
import { ICONS } from "./icons";
import AiIcon from "./AiIcon.vue";

defineProps<{
  conversations: AiConversation[];
  activeId: string;
  runningIds: string[];
  activeSection?: AiSettingsSection;
  floating?: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  delete: [id: string];
  create: [];
  settings: [section: AiSettingsSection];
}>();

function formatTime(value: number): string {
  const difference = Date.now() - value;
  if (difference < 60000) return "刚刚";
  if (difference < 3600000) return `${Math.floor(difference / 60000)} 分钟前`;
  if (difference < 86400000) return `${Math.floor(difference / 3600000)} 小时前`;
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
</script>

<template>
  <aside
    class="ai-conversations"
    :class="{ 'is-floating': floating }"
    aria-label="会话列表"
  >
    <header
      v-if="!floating"
      class="ai-conversations__header"
    >
      <strong>M-Design</strong>
      <span>AI 建模助手</span>
    </header>
    <div class="ai-conversations__navigation">
      <button
        class="ai-conversations__new"
        type="button"
        title="新对话"
        aria-label="新对话"
        @click="emit('create')"
      >
        <AiIcon :icon="ICONS['plus']" />
        <span>新建任务</span>
      </button>
      <button
        type="button"
        :class="{ 'is-active': activeSection === 'experts' || activeSection === 'skills' }"
        @click="emit('settings', 'experts')"
      >
        <AiIcon :icon="ICONS.brain" />
        <span>专家与技能</span>
      </button>
      <button
        type="button"
        :class="{ 'is-active': activeSection === 'providers' }"
        @click="emit('settings', 'providers')"
      >
        <AiIcon :icon="ICONS.layers" />
        <span>模型与供应商</span>
      </button>
      <button
        type="button"
        :class="{ 'is-active': activeSection === 'memory' }"
        @click="emit('settings', 'memory')"
      >
        <AiIcon :icon="ICONS['file-text']" />
        <span>记忆</span>
      </button>
    </div>
    <p class="ai-conversations__label">
      任务
      <span>({{ conversations.length }})</span>
    </p>
    <nav
      class="ai-conversations__list"
      aria-label="历史会话"
    >
      <p
        v-if="!conversations.length"
        class="ai-conversations__empty"
      >
        暂无会话，点击上方新建。
      </p>
      <article
        v-for="conversation in conversations"
        :key="conversation.id"
        class="ai-conversations__item"
        :class="{ 'is-active': !activeSection && conversation.id === activeId }"
      >
        <button
          class="ai-conversations__select"
          type="button"
          :title="conversation.title"
          :aria-current="!activeSection && conversation.id === activeId ? 'true' : undefined"
          @click="emit('select', conversation.id)"
        >
          <span class="ai-conversations__title">{{ conversation.title }}</span>
          <span
            v-if="runningIds.includes(conversation.id)"
            class="ai-conversations__working"
            role="status"
          >
            <span
              class="ai-conversations__dot"
              aria-hidden="true"
            />
            工作中
          </span>
          <span
            v-else
            class="ai-conversations__time"
          >
            {{ formatTime(conversation.updatedAt) }}
          </span>
        </button>
        <button
          class="ai-conversations__delete"
          type="button"
          :disabled="runningIds.includes(conversation.id)"
          :aria-label="`删除会话：${conversation.title}`"
          title="删除会话"
          @click="emit('delete', conversation.id)"
        >
          <AiIcon :icon="ICONS.x" />
        </button>
      </article>
    </nav>
  </aside>
</template>

<style lang="scss" scoped>
@use "./panel-tokens" as tok;

.ai-conversations {
  display: flex;
  flex: 0 0 172px;
  flex-direction: column;
  width: 172px;
  min-width: 0;
  min-height: 0;
  border-right: 1px solid var(--md-border-color);
  box-sizing: border-box;
  background: var(--md-neutral-50);
}

.ai-conversations__header {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  gap: 3px;
  padding: 18px 16px 14px;

  strong {
    font-family: var(--ai-font);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.2px;
  }
  span {
    color: var(--md-text-secondary);
    font-size: 11px;
  }
}

.ai-conversations__delete {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-sm);
  background: transparent;
  color: var(--md-text-secondary);
  cursor: pointer;

  svg {
    @include tok.ai-icon(13px);
  }
  &:hover {
    background: var(--md-neutral-200);
  }
}

.ai-conversations__list {
  flex: 1;
  min-height: 0;
  padding: 0 8px 12px;
  overflow-y: auto;
}

.ai-conversations__item {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 2px;
  border-radius: 8px;

  &:hover {
    background: var(--md-neutral-100);
  }
  &.is-active {
    background: var(--md-neutral-200);
  }
}

.ai-conversations__select {
  display: flex;
  flex: 1;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 7px 10px;
  border: none;
  border-radius: inherit;
  background: transparent;
  color: var(--md-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ai-conversations__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-conversations__time {
  flex-shrink: 0;
  color: var(--md-text-placeholder);
  font-size: 11px;
}
.ai-conversations__navigation {
  display: grid;
  gap: 2px;
  padding: 0 8px;

  button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--md-text-primary);
    font: inherit;
    text-align: left;
    cursor: pointer;
    svg {
      @include tok.ai-icon(16px);
    }
    &:hover {
      background: var(--md-neutral-100);
    }
  }
  .is-active {
    background: var(--md-neutral-200);
    font-weight: 600;
  }
}
.ai-conversations__label {
  margin: 20px 18px 6px;
  color: var(--md-text-secondary);
  font-size: 11px;
  letter-spacing: 0;
}
.ai-conversations__delete {
  position: absolute;
  right: 4px;
  width: 20px;
  margin-right: 3px;
  opacity: 0;
}
.ai-conversations__item:hover .ai-conversations__delete,
.ai-conversations__item:focus-within .ai-conversations__delete {
  opacity: 1;
}
.ai-conversations__item:hover .ai-conversations__time,
.ai-conversations__item:focus-within .ai-conversations__time {
  visibility: hidden;
}
@container assistant (min-width: 760px) {
  .ai-conversations {
    flex-basis: 200px;
    width: 200px;
  }
  .ai-conversations__header {
    padding-top: 20px;
  }
}
.ai-conversations__working {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--ai-accent);
  font-size: 11px;
}
.ai-conversations__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.ai-conversations__empty {
  margin: 10px 6px;
  color: var(--md-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.ai-conversations.is-floating .ai-conversations__navigation {
  padding-top: 16px;
}
.ai-conversations__navigation .ai-conversations__new {
  border: 1px solid transparent;
  background: var(--md-neutral-200);
  color: var(--md-text-primary);
  font-weight: 550;

  &:hover {
    background: var(--md-neutral-100);
  }
}
.ai-conversations__item.is-active .ai-conversations__title {
  font-weight: 550;
}
.ai-conversations__navigation button,
.ai-conversations__item {
  transition: background-color 120ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .ai-conversations__navigation button,
  .ai-conversations__item {
    transition: none;
  }
}
button:focus-visible {
  outline: 2px solid var(--ai-accent);
  outline-offset: 1px;
}
.ai-conversations__delete:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
