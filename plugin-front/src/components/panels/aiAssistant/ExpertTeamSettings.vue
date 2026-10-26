<script setup lang="ts">
import { computed, ref } from "vue";
import { expertStrategy, SYSML_EXPERTS } from "../../../ai-assistant/runtime/expert-roles";
import type { AiExecutionStrategy } from "../../../ai-assistant/types";
import AiIcon from "./AiIcon.vue";
import BuiltinAvatar from "./BuiltinAvatar.vue";
import { ICONS } from "./icons";

const emit = defineEmits<{ dismiss: []; enable: [strategy: AiExecutionStrategy]; create: [] }>();
const query = ref("");
const category = ref<"experts" | "teams">("experts");
const experts = computed(() =>
  SYSML_EXPERTS.filter(expert => `${expert.name}${expert.description}`.toLowerCase().includes(query.value.trim().toLowerCase()))
);
const showTeam = computed(() => "SysML 建模专家团结构建模图形布局语义检查".toLowerCase().includes(query.value.trim().toLowerCase()));
</script>

<template>
  <section class="expert-center ai-section">
    <div class="expert-center__body">
      <div class="expert-center__toolbar">
        <span>内置建模专家</span>
        <label class="expert-center__search">
          <AiIcon :icon="ICONS.search" />
          <input
            v-model="query"
            :placeholder="category === 'experts' ? '搜索专家' : '搜索专家团'"
            :aria-label="category === 'experts' ? '搜索专家' : '搜索专家团'"
          />
        </label>
        <button
          type="button"
          class="expert-center__back expert-center__create"
          @click="emit('create')"
        >
          新建专家
        </button>
        <button
          type="button"
          class="expert-center__back"
          @click="emit('dismiss')"
        >
          返回对话
        </button>
      </div>
      <div
        class="expert-center__categories"
        role="group"
        aria-label="专家分类"
      >
        <button
          type="button"
          :class="{ 'is-active': category === 'experts' }"
          :aria-pressed="category === 'experts'"
          @click="
            category = 'experts';
            query = '';
          "
        >
          专家
        </button>
        <button
          type="button"
          :class="{ 'is-active': category === 'teams' }"
          :aria-pressed="category === 'teams'"
          @click="
            category = 'teams';
            query = '';
          "
        >
          专家团
        </button>
      </div>
      <article
        v-if="category === 'teams' && showTeam"
        class="expert-center__team"
      >
        <div class="expert-center__team-icon">
          <BuiltinAvatar
            name="sysml-team"
            :size="48"
          />
        </div>
        <div>
          <h3>SysML 建模专家团</h3>
          <p>从需求梳理到模型检查，让专业分工贯穿建模过程。</p>
          <div class="expert-center__tags">
            <span>结构建模</span>
            <span>图形布局</span>
            <span>语义检查</span>
          </div>
        </div>
        <button
          class="expert-center__enable"
          type="button"
          @click="emit('enable', 'sysml-team')"
        >
          使用专家团
        </button>
      </article>
      <div
        v-if="category === 'experts'"
        class="expert-center__section"
      >
        <h3>建模专家</h3>
        <span>可单独使用，也可由专家团协作调用</span>
      </div>
      <div
        v-if="category === 'experts'"
        class="expert-center__grid"
      >
        <article
          v-for="expert in experts"
          :key="expert.role"
          class="expert-center__card"
        >
          <BuiltinAvatar
            class="expert-center__avatar"
            :name="expert.role"
            :size="40"
          />
          <div>
            <h4>{{ expert.name }}</h4>
            <p>{{ expert.description }}</p>
            <button
              class="expert-center__back"
              type="button"
              :aria-label="`使用${expert.name}`"
              @click="emit('enable', expertStrategy(expert.role))"
            >
              使用此专家
            </button>
          </div>
        </article>
      </div>
      <p
        v-if="category === 'experts' ? !experts.length : !showTeam"
        class="expert-center__empty"
      >
        没有匹配的{{ category === "experts" ? "专家" : "专家团" }}，试试其他关键词。
      </p>
      <p class="expert-center__note">专家和专家团使用当前选择的模型，沿用聊天、提案和编辑模式；提案仍需确认后执行。</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
.expert-center__body {
  flex: 1;
  min-height: 0;
  padding: 16px 20px;
  overflow-y: auto;
}
.expert-center__toolbar,
.expert-center__section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.expert-center__toolbar > span {
  font-size: 14px;
  font-weight: 600;
}
.expert-center__toolbar {
  flex-wrap: wrap;
}
.expert-center__search {
  margin-left: auto;
}
.expert-center__back {
  border: 1px solid var(--md-neutral-200);
  border-radius: 8px;
  padding: 7px 10px;
  background: #fff;
  color: var(--md-text-regular);
  font: inherit;
  cursor: pointer;
}
.expert-center__categories {
  display: flex;
  gap: 6px;
  margin-bottom: 16px;
  border-bottom: none;
}
.expert-center__categories button {
  border: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: transparent;
  color: var(--md-text-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.expert-center__categories button.is-active {
  color: var(--md-text-primary);
  font-weight: 600;
  background: var(--md-neutral-100);
}
.expert-center__search {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 180px;
  max-width: 55%;
  border: 1px solid var(--md-neutral-200);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--md-text-secondary);
}
.expert-center__search :deep(svg) {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.expert-center__search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--md-text-primary);
  font: inherit;
}
.expert-center__search:focus-within {
  border-color: var(--md-text-secondary);
}
.expert-center__team {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--md-neutral-200);
  border-radius: 12px;
  background: var(--md-neutral-50, #f7f7f7);
  margin-bottom: 18px;
}
.expert-center__team-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  border: 1px solid var(--md-neutral-200);
  border-radius: 12px;
  background: #fff;
}
.expert-center__team-icon :deep(svg) {
  width: 22px;
  height: 22px;
}
.expert-center h3,
.expert-center h4 {
  margin: 0;
  color: var(--md-text-primary);
  font-size: 15px;
  font-weight: 600;
}
.expert-center__team h3 {
  font-size: 16px;
}
.expert-center p {
  margin: 10px 0;
  color: var(--md-text-secondary);
  line-height: 1.7;
  font-size: 13px;
}
.expert-center__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 14px;
}
.expert-center__tags span {
  border-radius: 5px;
  padding: 3px 7px;
  background: #efefef;
  color: var(--md-text-regular);
  font-size: 11px;
}
.expert-center__enable {
  margin-left: auto;
  padding: 9px 14px;
  border: 1px solid #181818;
  border-radius: 9px;
  background: #181818;
  color: #fff;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.expert-center__enable:hover {
  background: #454545;
}
.expert-center__section span {
  color: var(--md-text-secondary);
  font-size: 12px;
}
.expert-center__grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
.expert-center__card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 20px;
  border: 1px solid var(--md-neutral-200);
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 3px 12px rgba(0, 0, 0, 0.025);
}
.expert-center__card > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.expert-center__avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: #f2f2f2;
  color: #454545;
  font-size: 14px;
  font-weight: 500;
}
.expert-center__card p {
  margin: 5px 0 8px;
}
.expert-center__note {
  padding-top: 16px;
}
.expert-center button:focus-visible {
  outline: 2px solid #858585;
  outline-offset: 3px;
}
@container assistant (min-width: 760px) {
  .expert-center__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
