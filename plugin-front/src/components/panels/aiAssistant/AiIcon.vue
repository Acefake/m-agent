<template>
  <svg
    :viewBox="`0 0 ${icon.size} ${icon.size}`"
    aria-hidden="true"
  >
    <component
      :is="element.tag"
      v-for="(element, index) in icon.elements"
      :key="index"
      v-bind="element.attrs"
      fill="none"
      stroke="currentColor"
      :stroke-width="icon.strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</template>

<script setup lang="ts">
import type { IconData } from "./icons";

defineProps<{
  icon: IconData;
}>();
</script>
