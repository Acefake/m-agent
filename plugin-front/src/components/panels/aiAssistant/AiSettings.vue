<template>
  <section
    v-if="modelValue"
    class="ai-settings"
    aria-label="AI 助手设置"
  >
    <nav
      v-if="initialSection !== 'providers' && initialSection !== 'memory'"
      class="ai-library-tabs"
      aria-label="专家与技能"
    >
      <button
        type="button"
        :class="{ 'is-active': initialSection === 'experts' }"
        @click="emit('section-change', 'experts')"
      >
        <AiIcon :icon="ICONS.brain" />
        专家
      </button>
      <button
        type="button"
        :class="{ 'is-active': initialSection === 'skills' }"
        @click="emit('section-change', 'skills')"
      >
        <AiIcon :icon="ICONS.layers" />
        技能
      </button>
    </nav>
    <div class="ai-settings__content">
      <ExpertTeamSettings
        v-if="initialSection === 'experts'"
        @dismiss="close"
        @enable="emit('select-expert', $event)"
        @create="emit('create-expert')"
      />
      <ProviderSettings
        v-else-if="initialSection === 'providers'"
        @saved="emit('saved', 'providers')"
        @dismiss="close"
      />
      <MemorySettings
        v-else-if="initialSection === 'memory'"
        @dismiss="close"
      />
      <SkillSettings
        v-else
        @saved="emit('saved', 'skills')"
        @create="emit('create-skill')"
        @dismiss="close"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AiExecutionStrategy, AiSettingsSection } from "../../../ai-assistant/types";
import ProviderSettings from "./ProviderSettings.vue";
import SkillSettings from "./SkillSettings.vue";
import ExpertTeamSettings from "./ExpertTeamSettings.vue";
import MemorySettings from "./MemorySettings.vue";
import AiIcon from "./AiIcon.vue";
import { ICONS } from "./icons";

defineProps<{ modelValue: boolean; initialSection?: AiSettingsSection }>();
const emit = defineEmits<{
  (event: "section-change", section: AiSettingsSection): void;
  (event: "select-expert", strategy: AiExecutionStrategy): void;
  (event: "update:modelValue", value: boolean): void;
  (event: "saved", section: AiSettingsSection): void;
  (event: "create-skill"): void;
  (event: "create-expert"): void;
}>();
function close(): void {
  emit("update:modelValue", false);
}
</script>

<style lang="scss" scoped>
@use "./panel-tokens" as tok;
.ai-settings {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #fff;
  font-size: 13px;
  flex-direction: column;
}
.ai-settings__content {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.ai-library-tabs {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px 4px;
}
.ai-library-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 15px;
  font-weight: 500;
  color: var(--md-text-secondary);
  cursor: pointer;
}
.ai-library-tabs button.is-active {
  color: var(--md-text-primary);
  font-weight: 600;
}
.ai-library-tabs :deep(svg) {
  width: 19px;
  height: 19px;
}
.ai-library-tabs button:focus-visible {
  outline: 2px solid var(--md-text-secondary);
  outline-offset: 4px;
}
/* 分区共用骨架：标题行固定，内容区自己滚动 */
:deep(.ai-section) {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

:deep(.ai-section__head) {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 6px;
  /* 右侧多留一段：标题与返回按钮都不能压到右上角的关闭按钮下面 */
  padding: 16px 20px;
  border-bottom: 1px solid var(--md-neutral-200);
}

:deep(.ai-section__title) {
  margin: 0;
  color: var(--md-text-primary);
  font-size: 18px;
  font-weight: 600;
}

/* 返回列表：标题左侧的图标按钮（chevron-right 转 180° 当左箭头用） */
:deep(.ai-section__back) {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: -5px;
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

:deep(.ai-section__body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}
</style>
