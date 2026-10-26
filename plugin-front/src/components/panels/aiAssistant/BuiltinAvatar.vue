<script setup lang="ts">
import { computed } from "vue";
import atlas from "./assets/builtin-avatars-v1.png?inline";
import memoryAvatar from "./assets/memory-cooperation-avatar-v1.png?inline";
import AiIcon from "./AiIcon.vue";
import { ICONS } from "./icons";

/** 内置角色使用透明头像；用户自定义技能保留通用图标。 */
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 24 });
const cells: Record<string, number> = {
  assistant: 0,
  lead: 0,
  requirements: 1,
  semantics: 2,
  layout: 3,
  checker: 4,
  "sysml-team": 5,
  "sysml-modeling": 6,
  "skill-creator": 7,
  "expert-manager": 8
};
const cell = computed(() => cells[props.name]);
const isMemoryAvatar = computed(() => props.name === "memory-cooperation");
const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  ...(cell.value !== undefined
    ? {
        backgroundImage: `url(${atlas})`,
        backgroundSize: "300% 300%",
        backgroundRepeat: "no-repeat",
        backgroundPosition: `${(cell.value % 3) * 50}% ${Math.floor(cell.value / 3) * 50}%`
      }
    : {}),
  ...(isMemoryAvatar.value
    ? {
        backgroundImage: `url(${memoryAvatar})`,
        backgroundSize: "contain",
        backgroundPosition: "center"
      }
    : {})
}));
</script>

<template>
  <span
    class="builtin-avatar"
    :data-avatar="name"
    :style="style"
    aria-hidden="true"
  >
    <AiIcon
      v-if="cell === undefined && !isMemoryAvatar"
      :icon="ICONS.brain"
    />
  </span>
</template>

<style scoped>
.builtin-avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  background-size: 300% 300%;
  background-repeat: no-repeat;
}
.builtin-avatar svg {
  width: 65%;
  height: 65%;
}
</style>
