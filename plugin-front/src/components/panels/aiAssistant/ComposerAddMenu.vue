<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { AiExecutionStrategy, AiSkill } from "../../../ai-assistant/types";
import { expertStrategy, SYSML_EXPERTS } from "../../../ai-assistant/runtime/expert-roles";
import AiIcon from "./AiIcon.vue";
import BuiltinAvatar from "./BuiltinAvatar.vue";
import { ICONS } from "./icons";

/** 输入区添加菜单：选择已有技能、执行方式或跳转管理页面。 */
const props = defineProps<{
  skills: Pick<AiSkill, "name" | "description">[];
  strategy: AiExecutionStrategy;
  disabled: boolean;
}>();
const emit = defineEmits<{
  open: [];
  file: [];
  skill: [name: string];
  expert: [strategy: AiExecutionStrategy];
  manage: [section: "skills" | "experts"];
}>();
const opened = ref(false);
const section = ref<"skills" | "experts">();
const query = ref("");
const trigger = ref<HTMLButtonElement>();
const search = ref<HTMLInputElement>();
const availableHeight = ref(360);
const expertGroups: { name: string; choices: { name: string; description: string; value: AiExecutionStrategy; avatar: string }[] }[] = [
  { name: "助手", choices: [{ name: "普通助手", description: "直接对话，按需调用建模工具", value: "assistant", avatar: "assistant" }] },
  { name: "专家", choices: SYSML_EXPERTS.map(expert => ({ ...expert, value: expertStrategy(expert.role), avatar: expert.role })) },
  {
    name: "专家团",
    choices: [{ name: "SysML 专家团", description: "需求、语义、布局与检查专家协作", value: "sysml-team", avatar: "sysml-team" }]
  }
];
const matches = (item: { name: string; description: string }) =>
  `${item.name} ${item.description}`.toLowerCase().includes(query.value.trim().toLowerCase());
const filteredSkills = computed(() => props.skills.filter(matches));
const filteredExpertGroups = computed(() =>
  expertGroups.map(group => ({ ...group, choices: group.choices.filter(matches) })).filter(group => group.choices.length)
);

function close(restoreFocus = false): void {
  opened.value = false;
  section.value = undefined;
  query.value = "";
  if (restoreFocus) trigger.value?.focus();
}
function toggle(): void {
  if (opened.value) return close();
  emit("open");
  const button = trigger.value;
  const panelTop = button?.closest(".ai-panel__chat")?.getBoundingClientRect().top ?? 0;
  availableHeight.value = Math.max(100, (button?.getBoundingClientRect().top ?? 400) - panelTop - 12);
  opened.value = true;
}
async function selectSection(value: "skills" | "experts"): Promise<void> {
  section.value = value;
  query.value = "";
  await nextTick();
  search.value?.focus();
}
function selectSkill(name: string): void {
  close();
  emit("skill", name);
}
function selectExpert(value: AiExecutionStrategy): void {
  close(true);
  emit("expert", value);
}
function manage(): void {
  const target = section.value;
  close();
  if (target) emit("manage", target);
}
</script>

<template>
  <div
    class="composer-add"
    @keydown.esc.stop.prevent="close(true)"
  >
    <button
      ref="trigger"
      class="composer-add__trigger"
      type="button"
      aria-label="添加文件、专家、专家团或技能"
      :aria-expanded="opened"
      :disabled="disabled"
      @click="toggle"
    >
      <AiIcon :icon="ICONS.plus" />
    </button>
    <template v-if="opened">
      <div
        class="composer-add__mask"
        @click="close()"
      />
      <div
        class="composer-add__popup"
        :style="{ maxHeight: `${availableHeight}px` }"
        aria-label="添加到对话"
      >
        <div class="composer-add__nav">
          <button
            type="button"
            @click="
              close();
              emit('file');
            "
          >
            <AiIcon :icon="ICONS.paperclip" />
            <span>添加文件</span>
          </button>
          <button
            type="button"
            :class="{ 'is-active': section === 'experts' }"
            :aria-expanded="section === 'experts'"
            @click="selectSection('experts')"
          >
            <AiIcon :icon="ICONS.brain" />
            <span>专家与专家团</span>
            <AiIcon :icon="ICONS['chevron-right']" />
          </button>
          <button
            type="button"
            :class="{ 'is-active': section === 'skills' }"
            :aria-expanded="section === 'skills'"
            @click="selectSection('skills')"
          >
            <AiIcon :icon="ICONS.layers" />
            <span>技能</span>
            <AiIcon :icon="ICONS['chevron-right']" />
          </button>
        </div>
        <section
          v-if="section"
          class="composer-add__submenu"
          :aria-label="section === 'skills' ? '选择技能' : '选择专家或专家团'"
        >
          <label class="composer-add__search">
            <AiIcon :icon="ICONS.search" />
            <input
              ref="search"
              v-model="query"
              :aria-label="section === 'skills' ? '搜索技能' : '搜索专家或专家团'"
              :placeholder="section === 'skills' ? '搜索技能' : '搜索专家或专家团'"
            />
          </label>
          <div class="composer-add__list">
            <template v-if="section === 'skills'">
              <button
                v-for="skill in filteredSkills"
                :key="skill.name"
                type="button"
                class="composer-add__item"
                @click="selectSkill(skill.name)"
              >
                <BuiltinAvatar
                  class="composer-add__avatar"
                  :name="skill.name"
                  :size="28"
                />
                <span class="composer-add__copy">
                  <span>{{ skill.name }}</span>
                  <small>{{ skill.description }}</small>
                </span>
              </button>
              <p
                v-if="!filteredSkills.length"
                class="composer-add__empty"
              >
                没有匹配的技能
              </p>
            </template>
            <template v-else>
              <section
                v-for="group in filteredExpertGroups"
                :key="group.name"
                class="composer-add__group"
                :aria-label="group.name"
              >
                <h3>{{ group.name }}</h3>
                <button
                  v-for="expert in group.choices"
                  :key="expert.value"
                  type="button"
                  class="composer-add__item"
                  :aria-pressed="strategy === expert.value"
                  @click="selectExpert(expert.value)"
                >
                  <BuiltinAvatar
                    class="composer-add__avatar"
                    :name="expert.avatar"
                    :size="28"
                  />
                  <span class="composer-add__copy">
                    <span>{{ expert.name }}</span>
                    <small>{{ expert.description }}</small>
                  </span>
                  <AiIcon
                    v-if="strategy === expert.value"
                    :icon="ICONS.check"
                  />
                </button>
              </section>
              <p
                v-if="!filteredExpertGroups.length"
                class="composer-add__empty"
              >
                没有匹配的专家或专家团
              </p>
            </template>
          </div>
          <button
            class="composer-add__manage"
            type="button"
            @click="manage"
          >
            <AiIcon :icon="ICONS['settings-2']" />
            {{ section === "skills" ? "管理技能" : "管理专家与专家团" }}
          </button>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.composer-add {
  margin-right: auto;
  font-family: var(--ai-font);
  font-size: 13px;
  line-height: 1.5;
}
.composer-add button {
  font: inherit;
  color: var(--md-text-regular);
  cursor: pointer;
  border: 0;
  background: transparent;
}
.composer-add :deep(svg) {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}
.composer-add__trigger {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
}
.composer-add button:hover {
  background: var(--md-neutral-50);
}
.composer-add button.is-active {
  background: var(--md-neutral-100);
  color: var(--md-text-primary);
  font-weight: 600;
}
.composer-add button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.composer-add button:focus-visible {
  outline: 2px solid var(--md-text-secondary);
  outline-offset: -2px;
}
.composer-add__mask {
  position: fixed;
  inset: 0;
  z-index: 5;
}
.composer-add__popup {
  position: absolute;
  left: 10px;
  bottom: 44px;
  z-index: 6;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: calc(100% - 20px);
}
.composer-add__nav,
.composer-add__submenu {
  border: 1px solid var(--md-border-color);
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
  padding: 8px;
  box-sizing: border-box;
}
.composer-add__nav {
  width: 180px;
  flex-shrink: 0;
}
.composer-add__nav button {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 8px 10px;
  width: 100%;
  border-radius: 8px;
  text-align: left;
}
.composer-add__nav button span {
  flex: 1;
}
.composer-add__nav button:first-child {
  margin-bottom: 4px;
}
.composer-add__submenu {
  display: flex;
  flex-direction: column;
  max-height: inherit;
  min-height: 0;
  width: 320px;
  min-width: 0;
}
.composer-add__search {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 0 10px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--md-neutral-50);
  color: var(--md-text-secondary);
}
.composer-add__search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  font: inherit;
  background: transparent;
  color: var(--md-text-primary);
}
.composer-add__search:focus-within {
  outline: 1px solid var(--md-neutral-300);
}
.composer-add__search input::placeholder {
  color: var(--md-text-placeholder);
}
.composer-add__list {
  min-height: 0;
  max-height: min(240px, 35vh);
  overflow-y: auto;
  padding: 8px 0;
}
.composer-add__item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 60px;
  padding: 10px;
  box-sizing: border-box;
  border-radius: 8px;
  text-align: left;
}
.composer-add__group h3 {
  margin: 8px 10px 2px;
  color: var(--md-text-secondary);
  font-size: 12px;
  font-weight: 500;
}
.composer-add__group + .composer-add__group {
  margin-top: 8px;
  border-top: 1px solid var(--md-border-color);
}
.composer-add__avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--md-neutral-100);
  flex-shrink: 0;
}
.composer-add__copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.composer-add__copy > * {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.composer-add__copy small {
  font-size: 12px;
  line-height: 18px;
  color: var(--md-text-secondary);
}
.composer-add__copy > span {
  color: var(--md-text-primary);
  font-weight: 500;
  line-height: 20px;
}
.composer-add__empty {
  margin: 12px 8px;
  color: var(--md-text-secondary);
}
.composer-add .composer-add__manage {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 10px;
  border-top: 1px solid var(--md-border-color);
  text-align: left;
}
@container assistant (max-width: 760px) {
  .composer-add__popup {
    flex-direction: column;
    align-items: stretch;
    width: 320px;
  }
  .composer-add__nav {
    display: flex;
    width: 100%;
  }
  .composer-add__nav button {
    justify-content: center;
    gap: 4px;
    padding: 8px 4px;
    font-size: 12px;
  }
  .composer-add__nav button:first-child {
    margin-bottom: 0;
  }
  .composer-add__nav button span {
    flex: initial;
  }
  .composer-add__nav button > svg:last-child:not(:first-child) {
    display: none;
  }
  .composer-add__submenu {
    width: 100%;
  }
}
</style>
