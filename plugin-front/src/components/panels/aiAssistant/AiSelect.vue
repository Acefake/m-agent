<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import AiIcon from "./AiIcon.vue";
import { ICONS } from "./icons";
const props = defineProps<{ modelValue: string; options: { value: string; label: string }[]; disabled?: boolean; label: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const opened = ref(false);
const query = ref("");
const active = ref(0);
const position = ref({ left: "0px", top: "0px", width: "240px", maxHeight: "300px" });
const candidates = computed(() => props.options.filter(item => item.label.toLowerCase().includes(query.value.toLowerCase())));
const current = computed(() => props.options.find(item => item.value === props.modelValue)?.label ?? props.modelValue);
function close(): void {
  opened.value = false;
}
async function toggle(): Promise<void> {
  if (opened.value) {
    close();
    return;
  }
  if (props.disabled || !trigger.value) return;
  query.value = "";
  active.value = Math.max(
    0,
    props.options.findIndex(item => item.value === props.modelValue)
  );
  const box = trigger.value.getBoundingClientRect();
  const width = Math.min(Math.max(240, box.width), innerWidth - 24);
  const height = Math.min(320, props.options.length * 36 + Math.max(0, props.options.length - 1) * 4 + (props.options.length > 5 ? 58 : 18));
  const above = innerHeight - box.bottom < height + 12 && box.top > innerHeight - box.bottom;
  const available = Math.max(80, above ? box.top - 16 : innerHeight - box.bottom - 16);
  position.value = {
    left: `${Math.max(12, Math.min(box.left, innerWidth - width - 12))}px`,
    top: `${above ? Math.max(12, box.top - Math.min(height, available) - 8) : box.bottom + 8}px`,
    width: `${width}px`,
    maxHeight: `${available}px`
  };
  opened.value = true;
  await nextTick();
  (menu.value?.querySelector("input") ?? menu.value)?.focus();
}
function choose(value: string): void {
  emit("update:modelValue", value);
  close();
  trigger.value?.focus();
}
function keydown(event: KeyboardEvent): void {
  if (event.key === "Escape" || event.key === "Tab") {
    close();
    if (event.key === "Escape") {
      event.preventDefault();
      trigger.value?.focus();
    }
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + candidates.value.length) % Math.max(1, candidates.value.length);
    void nextTick(() => menu.value?.querySelector(".is-focused")?.scrollIntoView({ block: "nearest" }));
  } else if (event.key === "Enter" && candidates.value[active.value]) {
    event.preventDefault();
    choose(candidates.value[active.value].value);
  }
}
function outside(event: MouseEvent): void {
  if (!menu.value?.contains(event.target as Node) && !trigger.value?.contains(event.target as Node)) close();
}
window.addEventListener("mousedown", outside);
window.addEventListener("resize", close);
function scroll(event: Event): void {
  if (!(event.target instanceof Node) || !menu.value?.contains(event.target)) close();
}
window.addEventListener("scroll", scroll, true);
onBeforeUnmount(() => {
  window.removeEventListener("mousedown", outside);
  window.removeEventListener("resize", close);
  window.removeEventListener("scroll", scroll, true);
});
</script>
<template>
  <button
    ref="trigger"
    class="ai-select"
    type="button"
    :disabled="disabled"
    :aria-label="label"
    :aria-expanded="opened"
    aria-haspopup="listbox"
    :data-value="modelValue"
    @click="toggle"
  >
    <slot name="icon" />
    <span>{{ current }}</span>
    <AiIcon :icon="ICONS['chevron-down']" />
  </button>
  <Teleport to="body">
    <div
      v-if="opened"
      ref="menu"
      class="ai-select-menu"
      :style="position"
      tabindex="-1"
      @keydown="keydown"
    >
      <label
        v-if="options.length > 5"
        class="ai-select-menu__search"
      >
        <AiIcon :icon="ICONS.search" />
        <input
          v-model="query"
          :placeholder="`搜索${label}`"
          :aria-label="`搜索${label}`"
          @input="active = 0"
        />
      </label>
      <div
        class="ai-select-menu__list"
        role="listbox"
        :aria-label="label"
      >
        <button
          v-for="(item, index) in candidates"
          :key="item.value"
          type="button"
          role="option"
          :aria-selected="item.value === modelValue"
          :class="{ 'is-selected': item.value === modelValue, 'is-focused': index === active }"
          @click="choose(item.value)"
        >
          <span>{{ item.label }}</span>
          <AiIcon
            v-if="item.value === modelValue"
            :icon="ICONS.check"
          />
        </button>
        <p v-if="!candidates.length">没有匹配项</p>
      </div>
    </div>
  </Teleport>
</template>
<style scoped lang="scss">
.ai-select {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 5px 7px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }
  &:hover,
  &[aria-expanded="true"] {
    background: #eaeaea;
  }
  &:disabled {
    opacity: 0.55;
    cursor: default;
  }
}
.ai-select-menu {
  position: fixed;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 8px;
  overflow: hidden;
  border: 1px solid #e5e5e5;
  border-radius: 16px;
  background: #fff;
  box-shadow:
    0 8px 28px rgba(0, 0, 0, 0.09),
    0 2px 6px rgba(0, 0, 0, 0.04);
  color: #181818;
  font:
    13px/1.5 system-ui,
    sans-serif;
  outline: none;
}
.ai-select-menu__search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 8px 10px;
  margin-bottom: 6px;
  border-radius: 10px;
  background: #f7f7f7;
  svg {
    width: 15px;
    height: 15px;
    color: #858585;
  }
  input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: #181818;
    font: inherit;
    &::placeholder {
      color: #aaa;
    }
  }
}
.ai-select-menu__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
  min-height: 0;
  button {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    span {
      overflow-wrap: anywhere;
    }
    svg {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }
    &:hover,
    &.is-focused,
    &.is-selected {
      background: #f2f2f2;
    }
  }
  p {
    margin: 8px;
    color: #858585;
  }
}
.ai-select:focus-visible,
.ai-select-menu__list button:focus-visible {
  outline: 2px solid #858585;
  outline-offset: -2px;
}
</style>
