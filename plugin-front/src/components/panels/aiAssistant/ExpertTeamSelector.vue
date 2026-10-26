<script setup lang="ts">
import type { AiExecutionStrategy } from "../../../ai-assistant/types";
import { computed } from "vue";
import { selectedExpert } from "../../../ai-assistant/runtime/expert-roles";
import AiIcon from "./AiIcon.vue";
import BuiltinAvatar from "./BuiltinAvatar.vue";
import { ICONS } from "./icons";

/** 已选专家或专家团标签；移除恢复本会话的普通助手。 */
const props = defineProps<{ strategy: AiExecutionStrategy; disabled: boolean }>();
const emit = defineEmits<{ select: [strategy: AiExecutionStrategy] }>();
const expert = computed(() => selectedExpert(props.strategy));
const name = computed(() => expert.value?.name ?? "SysML 专家团");
const removeLabel = computed(() => (expert.value ? `移除${expert.value.name}` : "移除专家团"));
</script>

<template>
  <div
    v-if="expert || strategy === 'sysml-team'"
    class="team-selector"
  >
    <BuiltinAvatar
      :name="expert?.role ?? 'sysml-team'"
      :size="18"
    />
    <span>{{ name }}</span>
    <button
      class="team-selector__remove"
      type="button"
      :title="removeLabel"
      :aria-label="removeLabel"
      :disabled="disabled"
      @click="emit('select', 'assistant')"
    >
      <AiIcon :icon="ICONS.x" />
    </button>
  </div>
</template>

<style scoped lang="scss">
.team-selector {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 5px 3px 7px;
  border-radius: 7px;
  color: var(--md-text-regular);
  font-size: 12px;
}
.team-selector :deep(svg) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.team-selector > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-selector__remove {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--md-text-secondary);
  cursor: pointer;
  opacity: 0;
}
.team-selector:hover,
.team-selector:focus-within {
  background: var(--md-neutral-100);
}
.team-selector:hover .team-selector__remove,
.team-selector:focus-within .team-selector__remove {
  opacity: 1;
}
.team-selector__remove:hover:not(:disabled) {
  background: var(--md-neutral-200);
  color: var(--md-text-primary);
}
.team-selector__remove:disabled {
  cursor: not-allowed;
  color: var(--md-text-placeholder);
}
.team-selector__remove:focus-visible {
  outline: 2px solid var(--md-text-secondary);
  outline-offset: 1px;
}
@media (hover: none) {
  .team-selector__remove {
    opacity: 1;
  }
}
</style>
