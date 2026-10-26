<script setup lang="ts">
import { computed } from "vue";
import type { AiTeamRun, AiExpertRun } from "../../../ai-assistant/types";
import { SYSML_EXPERTS } from "../../../ai-assistant/runtime/expert-roles";
import { toolLabelOf } from "../../../ai-assistant/runtime/tool-labels";
import AiIcon from "./AiIcon.vue";
import BuiltinAvatar from "./BuiltinAvatar.vue";
import { ICONS } from "./icons";

const props = defineProps<{ team: AiTeamRun }>();
const statusLabels: Record<AiExpertRun["status"], string> = {
  queued: "等待中",
  running: "进行中",
  completed: "已完成",
  error: "失败",
  cancelled: "已停止",
  "not-called": "未调用"
};
const members = computed(() => props.team.members.filter(member => member.status !== "not-called"));
const unused = computed(() => props.team.members.filter(member => member.status === "not-called"));
const summary = computed(
  () =>
    ({
      running: "正在协作",
      completed: "协作完成",
      error: "部分工作未完成",
      cancelled: "已停止",
      "waiting-approval": "等待确认提案",
      "waiting-user": "等待补充信息",
      interrupted: "上次运行已中断"
    })[props.team.status]
);
const progress = computed(() => {
  const completed = members.value.filter(member => member.status === "completed").length;
  const running = members.value.filter(member => member.status === "running").length;
  return [`已完成 ${completed} 项`, running ? `${running} 项进行中` : ""].filter(Boolean).join(" · ");
});
const nameOf = (member: AiExpertRun) => SYSML_EXPERTS.find(expert => expert.role === member.role)?.name ?? member.role;
</script>

<template>
  <details
    class="team-progress"
    :open="team.status !== 'completed'"
  >
    <summary class="team-progress__summary">
      <BuiltinAvatar
        name="sysml-team"
        :size="24"
      />
      <strong>SysML 专家团</strong>
      <span
        class="team-progress__summary-state"
        :class="{ 'is-error': team.status === 'error' }"
      >
        {{ summary }}
      </span>
      <AiIcon
        class="team-progress__caret"
        :icon="ICONS['chevron-right']"
      />
    </summary>
    <div class="team-progress__members">
      <p class="team-progress__count">{{ members.length ? progress : "正在安排分工" }}</p>
      <p
        v-if="team.error"
        class="team-progress__error is-error"
      >
        {{ team.error }}
      </p>
      <details
        v-for="member in members"
        :key="member.id"
        class="team-progress__member"
        :data-status="member.status"
      >
        <summary class="team-progress__heading">
          <span
            class="team-progress__status-icon"
            :class="{ 'is-running': member.status === 'running', 'is-error': member.status === 'error' }"
          >
            <AiIcon
              v-if="member.status === 'completed'"
              :icon="ICONS.check"
            />
            <AiIcon
              v-else-if="member.status === 'error' || member.status === 'cancelled'"
              :icon="ICONS.x"
            />
            <span
              v-else
              class="team-progress__dot"
            />
          </span>
          <BuiltinAvatar
            :name="member.role"
            :size="28"
          />
          <span class="team-progress__identity">
            <strong>{{ nameOf(member) }}</strong>
            <span
              class="team-progress__task"
              :title="member.task"
            >
              {{ member.task }}
            </span>
            <span
              v-if="member.error"
              class="team-progress__inline-error is-error"
            >
              {{ member.error }}
            </span>
          </span>
          <span
            class="team-progress__state"
            :class="{ 'is-error': member.status === 'error' }"
          >
            {{ statusLabels[member.status] }}
          </span>
          <AiIcon
            class="team-progress__caret"
            :icon="ICONS['chevron-right']"
          />
        </summary>
        <div class="team-progress__detail">
          <p class="team-progress__full-task">{{ member.task }}</p>
          <div
            v-if="member.result || member.toolCalls.length || member.usage?.totalTokens !== undefined"
            class="team-progress__result"
          >
            <p class="team-progress__metadata">
              <span v-if="member.toolCalls.length">{{ member.toolCalls.length }} 次工具调用</span>
              <span v-if="member.usage?.totalTokens !== undefined">{{ member.usage.totalTokens.toLocaleString() }} tokens</span>
            </p>
            <pre
              v-if="member.result"
              class="team-progress__report"
              >{{ member.result }}</pre
            >
            <details
              v-for="tool in member.toolCalls"
              :key="tool.id"
              class="team-progress__tool"
            >
              <summary>
                <AiIcon :icon="ICONS['chevron-right']" />
                <span>{{ toolLabelOf(tool.name) }}</span>
                <span
                  class="team-progress__tool-state"
                  :class="{ 'is-error': tool.state === 'error' }"
                >
                  {{ tool.state === "running" ? "进行中" : tool.state === "error" ? "失败" : "已返回" }}
                </span>
              </summary>
              <pre>{{ tool.error || tool.output || (tool.state === "running" ? "等待工具结果" : "工具未返回文本") }}</pre>
            </details>
          </div>
          <p
            v-else
            class="team-progress__empty"
          >
            {{
              member.status === "queued"
                ? "等待前序任务完成后开始。"
                : member.status === "running"
                  ? "正在处理任务，结果返回后将在这里显示。"
                  : "没有可展示的执行记录。"
            }}
          </p>
        </div>
      </details>
      <details
        v-if="unused.length"
        class="team-progress__unused"
      >
        <summary>本轮未调用 {{ unused.length }} 位专家</summary>
        <p>{{ unused.map(nameOf).join("、") }}</p>
      </details>
    </div>
  </details>
</template>

<style scoped lang="scss">
.team-progress {
  --team-text: #242424;
  --team-secondary: #626262;
  --team-line: #e5e5e5;
  --team-surface: #f5f5f5;
  margin: 0 0 12px;
  color: var(--team-text);
  font-size: 12px;
  line-height: 1.5;
  min-width: 0;
}
.team-progress summary {
  list-style: none;
  cursor: pointer;
}
.team-progress summary::-webkit-details-marker {
  display: none;
}
.team-progress summary:focus-visible {
  outline: 2px solid #737373;
  outline-offset: 2px;
  border-radius: 6px;
}
.team-progress svg {
  flex: none;
  width: 14px;
  height: 14px;
}
.team-progress__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
}
.team-progress__summary strong {
  font-size: 13px;
  font-weight: 600;
}
.team-progress__summary-state,
.team-progress__count {
  color: var(--team-secondary);
}
.team-progress__summary-state {
  margin-left: auto;
  text-align: right;
}
.team-progress__caret {
  color: var(--team-secondary);
}
.team-progress[open] > summary > .team-progress__caret,
.team-progress__member[open] > summary > .team-progress__caret,
.team-progress__tool[open] > summary > svg {
  transform: rotate(90deg);
}
.team-progress__members {
  padding-left: 22px;
}
.team-progress__count {
  margin: 0 0 4px;
  font-variant-numeric: tabular-nums;
}
.team-progress__member {
  border-bottom: 1px solid var(--team-line);
}
.team-progress__member:last-child {
  border-bottom: 0;
}
.team-progress__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 4px;
  border-radius: 6px;
}
.team-progress__heading:hover {
  background: var(--team-surface);
}
.team-progress__identity {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.team-progress__identity strong {
  font-size: 13px;
  font-weight: 500;
}
.team-progress__task {
  color: var(--team-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.team-progress__state {
  flex: none;
  color: var(--team-secondary);
}
.team-progress__status-icon {
  width: 16px;
  height: 16px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--team-secondary);
}
.team-progress__dot {
  width: 6px;
  height: 6px;
  border: 1px solid currentColor;
  border-radius: 50%;
}
.team-progress__status-icon.is-running {
  border: 1.5px solid var(--team-line);
  border-top-color: #626262;
  border-radius: 50%;
  animation: team-turn 1s linear infinite;
}
.team-progress__status-icon.is-running .team-progress__dot {
  display: none;
}
.team-progress__detail {
  margin: 0 4px 12px 64px;
  min-width: 0;
}
.team-progress__full-task {
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.team-progress__metadata {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 0 0 6px;
  color: var(--team-secondary);
  font-variant-numeric: tabular-nums;
}
.team-progress__empty {
  margin: 0;
  color: var(--team-secondary);
}
.team-progress pre {
  max-height: 280px;
  overflow: auto;
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--team-surface);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.65;
  scrollbar-width: thin;
  scrollbar-color: #a3a3a3 transparent;
}
.team-progress__tool summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 0;
}
.team-progress__tool summary > span:first-of-type {
  min-width: 0;
  overflow-wrap: anywhere;
}
.team-progress__tool-state {
  margin-left: auto;
  flex: none;
  color: var(--team-secondary);
}
.team-progress__unused {
  padding: 8px 4px;
  color: var(--team-secondary);
}
.team-progress__unused p {
  margin: 6px 0 0;
}
.team-progress__error {
  margin: 6px 0;
}
.team-progress__inline-error {
  overflow-wrap: anywhere;
}
.team-progress .is-error {
  color: #a3372b;
}
@keyframes team-turn {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .team-progress__status-icon.is-running {
    animation: none;
  }
}
</style>
