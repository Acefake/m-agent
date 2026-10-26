<template>
  <div
    ref="root"
    class="session-statistics"
    :class="{ 'is-compact': compact }"
    @keydown.esc.stop="close"
    @focusout="onFocusOut"
    @mouseenter="cancelLeave"
    @mouseleave="leave"
  >
    <div
      v-for="entry in entries"
      :key="entry.key"
      class="session-statistics__entry"
      @mouseenter="hoverEntry($event, entry.key)"
    >
      <button
        type="button"
        :data-statistic="entry.key"
        :aria-label="entry.title"
        :title="entry.hint"
        :aria-expanded="open === entry.key"
        :aria-controls="`${id}-${entry.key}`"
        @focus="open = entry.key"
        @click="toggle(entry.key)"
      >
        <svg
          v-if="entry.key === 'timing'"
          class="statistics-gauge"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 18a9 9 0 1 1 16 0" />
          <path d="m12 13 4-5M5 15H3m3-8 2 2m4-6v3m6 1-2 2m3 6h2" />
          <circle
            cx="12"
            cy="14"
            r="1"
          />
        </svg>
        <AiIcon
          v-else-if="entry.key === 'tokens'"
          :icon="ICONS.layers"
        />
        <svg
          v-else
          class="statistics-ring"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <circle
            cx="10"
            cy="10"
            r="7.5"
            fill="none"
            stroke-width="2.5"
            class="statistics-ring__track"
          />
          <circle
            cx="10"
            cy="10"
            r="7.5"
            fill="none"
            stroke-width="2.5"
            stroke-linecap="round"
            transform="rotate(-90 10 10)"
            :stroke-dasharray="`${ringDash} 47.12`"
            class="statistics-ring__fill"
          />
        </svg>
        <span class="session-statistics__value">{{ entry.value }}</span>
      </button>
      <Teleport to="body">
        <section
          v-if="open === entry.key"
          :ref="setPopup"
          @mouseenter="cancelLeave"
          @mouseleave="leave"
          @focusout="onFocusOut"
          @keydown.esc.stop="close"
          :id="`${id}-${entry.key}`"
          class="session-statistics__popover"
          :class="`popover-${entry.key}`"
          :style="popoverPosition"
          :aria-label="entry.title"
          :title="entry.hint"
        >
          <header>
            <span class="session-statistics__heading">
              <svg
                v-if="entry.key === 'timing'"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M4 18a9 9 0 1 1 16 0m-8-5 4-5" />
              </svg>
              <AiIcon
                v-else-if="entry.key === 'tokens'"
                :icon="ICONS.layers"
              />
              <span>{{ entry.key === "context" ? `上下文已用 ${contextPercent}` : entry.title }}</span>
            </span>
            <strong v-if="entry.headerValue">{{ entry.headerValue }}</strong>
          </header>
          <div
            v-if="entry.key === 'context'"
            class="session-statistics__bar"
            aria-label="上下文估算分布"
          >
            <span
              v-for="segment in contextSegments"
              :key="segment.key"
              :class="`segment-${segment.key}`"
              :style="{ width: `${segment.percent}%` }"
            />
          </div>
          <dl>
            <template
              v-for="(row, index) in entry.rows"
              :key="row[0]"
            >
              <dt>
                <i
                  v-if="entry.key === 'context'"
                  class="legend-dot"
                  :class="`segment-${['system', 'tools', 'messages'][index]}`"
                />
                {{ row[0] }}
              </dt>
              <dd>{{ row[1] }}</dd>
            </template>
          </dl>
        </section>
      </Teleport>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nanoid } from "nanoid";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { AiChatMessage } from "../../../ai-assistant/types";
import { aggregateSessionStatistics } from "../../../ai-assistant/conversation/session-statistics";
import AiIcon from "./AiIcon.vue";
import { ICONS } from "./icons";

const props = defineProps<{
  /** Current conversation only, with parent totals already including experts. */
  messages: AiChatMessage[];
  /** Active model window, used only for matching legacy messages. */
  contextLength?: number;
  /** Active model identifier. */
  model?: string;
  /** Closes transient details when the conversation changes. */
  conversationId: string;
  /** Whether this conversation is currently executing. */
  running?: boolean;
  compact?: boolean;
}>();
const root = ref<HTMLElement>();
const popup = ref<HTMLElement>();
function setPopup(element: unknown) {
  if (element instanceof HTMLElement) popup.value = element;
}
const open = ref<string>();
let pinned: string | undefined;
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
const id = `statistics-${nanoid(8)}`;
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let runningSince = Date.now();
let runningBase = 0;
let runningMessageId: string | undefined;
watch(
  [() => props.running, () => props.conversationId, () => props.messages.filter(message => message.role === "assistant").at(-1)?.id],
  () => {
    clearInterval(clock);
    if (!props.running) return;
    const latest = props.messages.filter(message => message.role === "assistant").at(-1);
    runningSince = Date.now();
    runningBase = latest?.durationMs ?? (latest ? Math.max(0, runningSince - latest.createdAt) : 0);
    runningMessageId = latest?.id;
    now.value = runningSince;
    clock = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  },
  { immediate: true }
);
const stats = computed(() => {
  const messages = props.running
    ? props.messages.map(message =>
        message.id === runningMessageId ? { ...message, durationMs: runningBase + Math.max(0, now.value - runningSince) } : message
      )
    : props.messages;
  return aggregateSessionStatistics(messages, props);
});
const count = (value: number | undefined) => (value === undefined ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 0 }));
const compactCount = (value: number | undefined) =>
  value === undefined ? "—" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const duration = (value: number | undefined) => {
  if (value === undefined) return "—";
  if (value < 1000) return `${Math.round(value)}毫秒`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}时${minutes % 60}分${seconds % 60}秒`;
};
const percent = (value: number | undefined) => (value === undefined ? "—" : `${Math.round(value)}%`);
const contextPercent = computed(() => `${stats.value.context.estimated ? "~" : ""}${percent(stats.value.context.percent)}`);
const ringDash = computed(() => Math.min(100, Math.max(0, stats.value.context.percent ?? 0)) * 0.4712);
const contextSegments = computed(() => {
  const c = stats.value.context;
  const total = (c.system ?? 0) + (c.tools ?? 0) + (c.messages ?? 0);
  const denominator = Math.max(c.limit ?? total, total, 1);
  return [
    { key: "system", value: c.system ?? 0 },
    { key: "tools", value: c.tools ?? 0 },
    { key: "messages", value: c.messages ?? 0 }
  ].map(segment => ({ ...segment, percent: (segment.value / denominator) * 100 }));
});
const entries = computed(() => {
  const { timing: t, tokens: u, context: c } = stats.value;
  const timingMark = t.partial ? "≥" : "";
  const tokenMark = u.partial ? "≥" : "";
  const timed = (value: number | undefined) => (value === undefined ? "—" : `${timingMark}${duration(value)}`);
  const tok = (value: number | undefined) => (value === undefined ? "—" : `${tokenMark}${count(value)} tok`);
  const speed = t.tokensPerSecond === undefined ? "—" : `${Math.round(t.tokensPerSecond)} tok/s`;
  const hint = "— 表示未记录；≥ 表示仅统计已记录的数据";
  return [
    {
      key: "timing",
      title: "会话统计",
      hint: `${hint}；并行工作耗时可能超过会话耗时`,
      value: `${duration(t.wallMs)} · ${speed}`,
      headerValue: "",
      rows: [
        ["模型用时", timed(t.modelMs)],
        ["工具调用用时", timed(t.toolMs)],
        ["首 token 平均 (TTFT)", timed(t.firstTokenMs)],
        ["输出速度 (TPS)", speed]
      ]
    },
    {
      key: "tokens",
      title: "Token 用量",
      hint: `${hint}；缓存读取已包含在输入中`,
      value: `${u.total === undefined ? "—" : `${tokenMark}${compactCount(u.total)}`} tok · 缓存命中${percent(u.cacheRate)}`,
      headerValue: tok(u.total),
      rows: [
        ["缓存命中", percent(u.cacheRate)],
        ["未缓存输入", tok(u.uncached)],
        ["缓存读取", tok(u.cached)],
        ["输出", tok(u.output)]
      ]
    },
    {
      key: "context",
      title: "上下文用量",
      hint: "最近请求输入占用；~ 表示本地估算，— 表示未记录",
      value: contextPercent.value,
      headerValue: `${c.estimated && c.used !== undefined ? "~" : ""}${compactCount(c.used)} / ${compactCount(c.limit)}`,
      rows: [
        ["系统提示词", c.system === undefined ? "—" : `~${compactCount(c.system)}`],
        ["工具定义", c.tools === undefined ? "—" : `~${compactCount(c.tools)}`],
        ["对话消息", c.messages === undefined ? "—" : `~${compactCount(c.messages)}`]
      ]
    }
  ];
});
const popoverPosition = computed(() => {
  const trigger = root.value?.querySelector<HTMLElement>(`[data-statistic="${open.value}"]`);
  if (!trigger) return {};
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 24);
  let zIndex = 20;
  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    const layer = Number.parseInt(window.getComputedStyle(parent).zIndex, 10);
    if (Number.isFinite(layer)) zIndex = Math.max(zIndex, layer + 1);
  }
  return {
    zIndex,
    left: `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2))}px`,
    bottom: `${window.innerHeight - rect.top}px`
  };
});
function hoverEntry(_event: MouseEvent, key: string) {
  cancelLeave();
  open.value = key;
}
function cancelLeave() {
  clearTimeout(leaveTimer);
}
function close() {
  cancelLeave();
  open.value = undefined;
  pinned = undefined;
}
function toggle(key: string) {
  if (pinned === key) close();
  else {
    pinned = key;
    open.value = key;
  }
}
function leave() {
  cancelLeave();
  leaveTimer = setTimeout(() => {
    open.value = pinned;
  }, 160);
}
function onFocusOut(event: FocusEvent) {
  const target = event.relatedTarget;
  if (target instanceof Node && (root.value?.contains(target) || popup.value?.contains(target))) return;
  if (!target && popup.value?.matches(":hover")) return;
  close();
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target) && !popup.value?.contains(event.target)) close();
}
watch(() => props.conversationId, close);
onMounted(() => document.addEventListener("pointerdown", outside));
onBeforeUnmount(() => {
  clearInterval(clock);
  cancelLeave();
  document.removeEventListener("pointerdown", outside);
});
</script>

<style scoped>
.session-statistics {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  position: relative;
  gap: 2px 8px;
  max-width: 100%;
  min-width: 0;
  color: #727b88;
  font-size: 11px;
}
.session-statistics__entry {
  min-width: 0;
  max-width: 100%;
}
.session-statistics button {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  padding: 4px 2px;
  font: inherit;
  cursor: pointer;
}
.session-statistics button:hover,
.session-statistics button[aria-expanded="true"] {
  background: #eef0f3;
  color: #414b59;
}
.session-statistics button:focus-visible {
  outline: 2px solid #536dba;
  outline-offset: 1px;
}
.session-statistics svg,
.session-statistics__popover svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}
.session-statistics .statistics-ring {
  width: 15px;
  height: 15px;
}
.statistics-ring__track {
  stroke: #d8dde5;
}
.statistics-ring__fill {
  stroke: #727b88;
}
.session-statistics__value {
  min-width: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.session-statistics__popover {
  position: fixed;
  box-sizing: border-box;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 12px 16px;
  border: 1px solid #e1e5eb;
  border-radius: 12px;
  background: #fff;
  color: #414b59;
  box-shadow: 0 6px 20px #18253b1a;
  z-index: 20;
  font-size: 12px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 8px;
  border-bottom: 1px solid #e8ebf0;
  line-height: 20px;
}
.session-statistics__heading {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
strong {
  font-weight: 600;
  text-align: right;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 10px;
  margin: 0;
  line-height: 24px;
}
dt {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #727b88;
  white-space: nowrap;
}
dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.session-statistics__bar {
  display: flex;
  height: 5px;
  border-radius: 3px;
  background: #eef0f3;
  overflow: hidden;
  margin: 12px 0 10px;
}
.segment-system {
  background: #7371c4;
}
.segment-tools {
  background: #52939f;
}
.segment-messages {
  background: #7ca28a;
}
.legend-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex-shrink: 0;
}
.popover-context header {
  margin-bottom: 0;
  border-bottom: 0;
  padding-bottom: 0;
}
@media (max-width: 360px) {
  .session-statistics {
    gap: 2px 6px;
  }
}
</style>
