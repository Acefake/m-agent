<template>
  <article
    class="turn"
    :class="`turn--${message.role}`"
  >
    <template v-if="message.role === 'user'">
      <div class="turn__user">
        <p
          v-if="message.content"
          class="turn__user-text"
        >
          {{ message.content }}
        </p>

        <p
          v-if="message.skillNames?.length"
          class="turn__skills"
        >
          {{ message.skillNames.map(name => `/${name}`).join("、") }}
        </p>

        <div
          v-if="message.attachments?.length"
          class="turn__files"
        >
          <button
            v-for="attachment in message.attachments"
            :key="attachment.id"
            class="turn__file"
            type="button"
            :title="attachment.name"
            :disabled="!attachment.dataUrl"
            @click="previewAttachment(attachment)"
          >
            <img
              v-if="attachment.kind === 'image' && attachment.dataUrl"
              class="turn__file-thumb"
              :src="attachment.dataUrl"
              :alt="attachment.name"
            />
            <AiIcon
              v-else
              class="turn__file-icon"
              :icon="ICONS['file-text']"
            />
            <span class="turn__file-name">{{ attachment.name }}</span>
            <span class="turn__file-meta">{{ attachmentMeta(attachment) }}</span>
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div
        class="turn__body"
        :class="{ 'is-streaming': streaming }"
      >
        <div
          v-if="streaming || renderSteps.length || message.team || message.skillNames?.length"
          class="trace"
        >
          <button
            class="trace__row trace__row--summary"
            :class="{ 'is-live': streaming }"
            type="button"
            :aria-expanded="processOpen"
            @click="toggleProcess"
          >
            <span
              v-if="streaming"
              class="trace__spinner"
              aria-hidden="true"
            />
            <AiIcon
              v-else
              class="trace__icon"
              :icon="ICONS.layers"
            />
            <span class="trace__label">
              <span class="trace__text">{{ streaming ? processLabel : "已完成" }}</span>
              <span
                v-if="streaming || message.durationMs"
                class="trace__meta"
              >
                {{ formatDuration(streaming ? elapsedSeconds * 1000 : message.durationMs || 0) }}
              </span>
            </span>
            <span
              v-if="failedStepCount"
              class="trace__state is-error"
            >
              {{ failedStepCount }} 项失败
            </span>
            <AiIcon
              class="trace__chevron"
              :class="{ 'is-open': processOpen }"
              :icon="ICONS['chevron-right']"
            />
          </button>
        </div>
        <div
          v-for="skillName in message.skillNames ?? []"
          :key="skillName"
          v-show="processOpen"
          class="trace__row trace__skill"
          title="此技能已加入本轮模型提示词"
        >
          <AiIcon class="trace__icon" :icon="ICONS.layers" />
          <span>加载技能 {{ skillName }}</span>
        </div>
        <ExpertTeamProgress
          v-if="message.team"
          v-show="processOpen"
          :team="message.team"
        />
        <div
          v-if="waitingForOutput && processOpen && !message.team"
          class="trace__row trace__waiting is-live"
          role="status"
        >
          <span class="trace__slot">
            <AiIcon
              class="trace__icon"
              :icon="ICONS.brain"
            />
          </span>
          <span class="trace__text is-thinking">
            思考中
            <span
              class="trace__dots"
              aria-hidden="true"
            >
              <i />
              <i />
              <i />
            </span>
          </span>
        </div>
        <div
          v-for="stage in stages"
          :key="stage.key"
          class="turn__stage"
        >
          <div
            v-if="!message.team && processOpen && stage.processSteps.length"
            class="trace__items"
          >
            <div
              v-for="item in stage.processSteps"
              :key="item.key"
              class="trace__item"
            >
              <div
                class="trace__row"
                :class="{ 'is-live': item.running }"
              >
                <span class="trace__slot">
                  <AiIcon
                    class="trace__icon"
                    :icon="STEP_ICONS[item.icon]"
                  />
                </span>
                <button
                  class="trace__label"
                  type="button"
                  :aria-expanded="isOpen(item)"
                  @click="toggleStep(item.key)"
                >
                  <span
                    class="trace__text"
                    :class="{ 'is-thinking': item.thinking }"
                  >
                    {{ item.label }}
                    <span
                      v-if="item.thinking"
                      class="trace__dots"
                      aria-hidden="true"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                  </span>
                  <span
                    v-if="item.stateText"
                    class="trace__state"
                    :class="item.stateClass"
                  >
                    {{ item.stateText }}
                  </span>
                  <AiIcon
                    class="trace__chevron"
                    :class="{ 'is-open': isOpen(item) }"
                    :icon="ICONS['chevron-right']"
                  />
                </button>
              </div>

              <pre
                v-if="item.kind === 'reasoning' && isOpen(item)"
                :ref="element => setReasoningRef(item.key, element)"
                class="trace__reasoning"
                >{{ item.reasoningText }}</pre
              >

              <div
                v-if="item.call && isOpen(item)"
                class="trace__detail"
              >
                <div class="trace__section">
                  <span class="trace__section-label">工具</span>
                  <code class="trace__call">{{ item.call.name }}</code>
                </div>
                <div class="trace__section">
                  <span class="trace__section-label">参数</span>
                  <pre class="trace__well">{{ formatJson(item.call.input) }}</pre>
                </div>
                <div
                  v-if="item.call.output"
                  class="trace__section"
                >
                  <span class="trace__section-label">结果</span>
                  <pre class="trace__well">{{ item.call.output }}</pre>
                </div>
                <div
                  v-if="item.call.error"
                  class="trace__section"
                >
                  <span class="trace__section-label">错误</span>
                  <pre class="trace__well is-error">{{ item.call.error }}</pre>
                </div>
              </div>
            </div>
          </div>
          <!-- renderMarkdown 已禁用模型的原始 HTML，这里注入的是受控渲染结果（含关键词标记） -->
          <div
            v-if="stage.text && ((!message.team && processOpen) || (!streaming && stage.key === finalTextStageKey))"
            class="turn__md"
            v-html="renderMarkdown(stage.text) + (stage.active ? CARET_HTML : '')"
          />
        </div>

        <p
          v-if="message.runState && !['running', 'finished'].includes(message.runState.status)"
          class="turn__run-state"
          role="status"
        >
          {{ message.runState.message }}
        </p>

        <section
          v-if="message.plan"
          class="plan"
        >
          <div class="plan__header">
            <strong>{{ message.plan.title }}</strong>
            <span :class="`plan__status is-${message.plan.status}`">{{ planStatusLabel(message.plan.status) }}</span>
          </div>
          <p class="plan__summary">{{ message.plan.summary }}</p>
          <ol class="plan__steps">
            <li
              v-for="step in message.plan.steps"
              :key="step.id"
            >
              <label class="plan__step">
                <input
                  type="checkbox"
                  :checked="checkedStepIds.includes(step.id)"
                  :disabled="planLocked"
                  @change="toggleStepChecked(step.id)"
                />
                <span class="plan__step-summary">{{ step.summary }}</span>
              </label>
              <span
                v-if="step.acceptance"
                class="plan__step-acceptance"
              >
                验收：{{ step.acceptance }}
              </span>
              <span
                v-if="step.status !== 'pending'"
                :class="`plan__step-status is-${step.status}`"
              >
                {{ operationStatusLabel(step.status) }}
              </span>
              <p
                v-if="step.result && step.status !== 'completed'"
                class="plan__step-result"
              >
                {{ step.result }}
              </p>
            </li>
          </ol>
          <div
            v-if="message.plan.status === 'pending'"
            class="plan__actions"
          >
            <button
              class="proposal__execute"
              type="button"
              :disabled="streaming || !checkedStepIds.length"
              @click="emit('executePlan', message.id, [...checkedStepIds])"
            >
              执行所选步骤（{{ checkedStepIds.length }}/{{ message.plan.steps.length }}）
            </button>
            <button
              class="plan__reject"
              type="button"
              :disabled="streaming"
              @click="emit('rejectPlan', message.id)"
            >
              忽略
            </button>
          </div>
        </section>

        <section
          v-if="message.proposal"
          class="proposal"
        >
          <div class="proposal__header">
            <strong>{{ message.proposal.title }}</strong>
            <span :class="`proposal__status is-${message.proposal.status}`">{{ proposalStatusLabel(message.proposal.status) }}</span>
          </div>
          <p class="proposal__summary">{{ message.proposal.summary }}</p>
          <ol class="proposal__operations">
            <li
              v-for="operation in message.proposal.operations"
              :key="operation.id"
            >
              <span class="proposal__operation-summary">{{ operation.summary }}</span>
              <span :class="`proposal__operation-status is-${operation.status}`">{{ operationStatusLabel(operation.status) }}</span>
              <span
                v-if="operation.reverted"
                class="proposal__operation-status is-reverted"
              >
                已回滚
              </span>
              <button
                v-if="operation.type === 'replace-sysml-text' && operation.textualContent"
                class="proposal__text-toggle"
                type="button"
                :aria-expanded="textVisible(operation.id)"
                @click="toggleText(operation.id)"
              >
                {{ textVisible(operation.id) ? "收起提交文本" : "查看提交文本" }}
              </button>
              <pre
                v-if="textVisible(operation.id) && operation.textualContent"
                class="proposal__text"
                >{{ operation.textualContent }}</pre
              >
              <p
                v-if="operation.result && (operation.status !== 'completed' || isDiagramOperation(operation.type))"
                class="proposal__result"
              >
                {{ operation.result }}
              </p>
            </li>
          </ol>
          <p
            v-if="hasDeleteOperation"
            class="proposal__warning"
          >
            删除操作不可撤销，请确认提案内容后执行。
          </p>
          <button
            v-if="message.proposal.status === 'pending'"
            class="proposal__execute"
            type="button"
            :disabled="streaming"
            @click="emit('executeProposal', message.id)"
          >
            确认并执行
          </button>
          <button
            v-if="rollbackable"
            class="proposal__rollback"
            type="button"
            :disabled="streaming"
            @click="emit('rollbackProposal', message.id)"
          >
            回滚本轮改动（{{ rollbackableCount }} 项）
          </button>
          <p
            v-if="rollbackNotice"
            class="proposal__rollback-notice"
          >
            {{ rollbackNotice }}
          </p>
        </section>

        <section
          v-if="message.choicePrompt"
          class="choice"
        >
          <p class="choice__question">{{ message.choicePrompt.question }}</p>
          <div class="choice__options">
            <button
              v-for="option in message.choicePrompt.options"
              :key="option.id"
              class="choice__option"
              :class="{ 'is-selected': selectedOptionId === option.id }"
              type="button"
              :disabled="choiceAnswered || streaming"
              @click="chooseOption(option)"
            >
              <span class="choice__label">{{ option.label }}</span>
              <span
                v-if="option.description"
                class="choice__description"
              >
                {{ option.description }}
              </span>
            </button>
          </div>
          <p
            v-if="choiceAnswered"
            class="choice__answer"
          >
            {{ message.choicePrompt.status === "skipped" ? "已跳过本次追问" : `已选择：${message.choicePrompt.answer}` }}
          </p>
          <template v-else-if="message.choicePrompt.allowCustomInput">
            <div class="choice__custom">
              <input
                v-model="customChoiceText"
                class="choice__input"
                type="text"
                placeholder="或手动输入你的想法…"
                :disabled="streaming"
                @keydown.enter="submitCustomChoice"
              />
              <button
                class="choice__send"
                type="button"
                :disabled="!customChoiceText.trim() || streaming"
                @click="submitCustomChoice"
              >
                发送
              </button>
            </div>
          </template>
          <button
            v-if="!choiceAnswered"
            class="choice__skip"
            type="button"
            :disabled="streaming"
            @click="skipChoice"
          >
            跳过，继续
          </button>
        </section>

        <div
          v-if="footerLabel"
          class="turn__footer"
        >
          <span :title="message.usage ? '用量单位为 tokens；缓存命中已包含在输入中' : undefined">{{ footerLabel }}</span>
          <button
            v-if="message.content"
            class="turn__copy"
            type="button"
            :title="copied ? '已复制' : '复制整段'"
            :aria-label="copied ? '已复制' : '复制整段'"
            @click="copyContent"
          >
            <AiIcon
              v-if="!copied"
              :icon="ICONS.copy"
            />
            <AiIcon
              v-else
              :icon="ICONS.check"
            />
          </button>
        </div>
      </div>
    </template>
  </article>

  <!-- 点图片附件看大图：面板内浮层，避免依赖 window.open 被宿主拦截 -->
  <div
    v-if="previewDataUrl"
    class="turn-preview"
    @click="previewDataUrl = ''"
  >
    <img
      class="turn-preview__image"
      :src="previewDataUrl"
      alt="附件预览"
    />
  </div>
</template>

<script setup lang="ts">
import { messageStages } from "../../../ai-assistant/conversation/message-timeline";
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from "vue";
import { attachmentKindLabel, formatAttachmentSize } from "../../../ai-assistant/conversation/attachments";
import { ICONS, type IconData } from "./icons";
import { renderMarkdown } from "./markdown";
import { TOOL_LABELS } from "../../../ai-assistant/runtime/tool-labels";
import type {
  AiAttachment,
  AiChangeOperation,
  AiChangePlan,
  AiChangeProposal,
  AiChatMessage,
  AiChoiceOption,
  AiToolCallView
} from "../../../ai-assistant/types";
import AiIcon from "./AiIcon.vue";
import ExpertTeamProgress from "./ExpertTeamProgress.vue";

interface ProcessStep {
  key: string;
  stepIndex: number;
  kind: "reasoning" | "tool";
  icon: string;
  label: string;
  reasoningText: string;
  call?: AiToolCallView;
  stateText: string;
  stateClass: string;
  /** 该步正在进行（工具执行中，或正在思考） */
  running: boolean;
  /** 正在思考：显示动态提示 */
  thinking: boolean;
}

/** 过程行的图标：思考用大脑，工具调用按类型归到模型结构 / 搜索 / 文本 */
const STEP_ICONS: Record<string, IconData> = {
  brain: ICONS.brain,
  layers: ICONS.layers,
  search: ICONS.search,
  page: ICONS["file-text"]
};

const TOOL_ICONS: Record<string, string> = {
  model_search: "search",
  text_read_sysml: "page",
  text_validate: "page",
  diagram_read_palette: "search"
};

const CARET_HTML = '<span class="ai-md-caret"></span>';

const props = defineProps<{
  message: AiChatMessage;
  streaming?: boolean;
}>();

const emit = defineEmits<{
  executeProposal: [messageId: string];
  executePlan: [messageId: string, stepIds: string[]];
  rejectPlan: [messageId: string];
  rollbackProposal: [messageId: string];
  answerChoice: [messageId: string, promptId: string, answer: string | null];
}>();

/** 附件大图预览（点图片附件打开，再点关闭） */
const previewDataUrl = ref("");
const openKeys = ref<Set<string>>(new Set());
const elapsedSeconds = ref(0);
const copied = ref(false);

let elapsedTimer: ReturnType<typeof setInterval> | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/** 思考与工具调用按发生顺序展开成过程行 */
const renderSteps = computed<ProcessStep[]>(() => {
  const result: ProcessStep[] = [];
  const steps = props.message.steps ?? [];

  steps.forEach((step, index) => {
    if (step.kind === "text") return;
    if (step.kind === "reasoning") {
      // 最后一步仍在思考时给出动态提示，避免看起来像卡住
      const thinking = !!props.streaming && index === steps.length - 1;
      result.push({
        key: `reasoning-${index}`,
        stepIndex: index,
        kind: "reasoning",
        icon: "brain",
        label: thinking ? "思考中" : "深度思考",
        reasoningText: step.text,
        stateText: "",
        stateClass: "",
        running: thinking,
        thinking
      });
      return;
    }

    const call = props.message.toolCalls.find(item => item.id === step.id);
    if (!call) return;

    result.push({
      key: call.id,
      stepIndex: index,
      kind: "tool",
      icon: TOOL_ICONS[call.name] ?? "layers",
      label: toolLabel(call),
      reasoningText: "",
      call,
      stateText: call.state === "running" ? "执行中" : call.state === "error" ? "失败" : "",
      stateClass: call.state === "running" ? "is-running" : call.state === "error" ? "is-error" : "",
      running: call.state === "running",
      thinking: false
    });
  });

  return result;
});

/** 思考文本容器：内容持续追加时保持滚动到底部 */
const reasoningElements = new Map<string, HTMLElement>();

function setReasoningRef(key: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) reasoningElements.set(key, element);
  else reasoningElements.delete(key);
}

function scrollThinkingToBottom(): void {
  const active = [...renderSteps.value].reverse().find(step => step.thinking);
  const element = active ? reasoningElements.get(active.key) : undefined;
  if (element) element.scrollTop = element.scrollHeight;
}

watch(
  () => props.message.steps,
  () => void nextTick(scrollThinkingToBottom)
);

const stages = computed(() =>
  messageStages(props.message).map((stage, index, all) => ({
    ...stage,
    processSteps: renderSteps.value.filter(step => stage.stepIndexes.includes(step.stepIndex)),
    active: !!props.streaming && index === all.length - 1
  }))
);

const finalTextStageKey = computed(() => [...stages.value].reverse().find(stage => stage.text)?.key);
/** 普通助手过程默认收起；专家团由自身管理成员列表的完成态。 */
const processOpen = ref(!!props.message.team);
watch(
  () => props.streaming,
  () => {
    if (!props.message.team) processOpen.value = false;
  }
);
const waitingForOutput = computed(
  () => !!props.streaming && !props.message.content && !props.message.steps?.length && !props.message.toolCalls.length
);
const failedStepCount = computed(() => renderSteps.value.filter(step => step.call?.state === "error").length);
/** 当前阶段保留继续执行的状态提示。 */
const processLabel = computed(() => (props.message.runState?.status === "continuing" ? "继续执行中" : "工作中"));
/** 结束时的一行收据：总耗时、token 用量与模型 */
const footerLabel = computed(() => {
  if (props.streaming || !props.message.durationMs) return "";

  const parts = [`用时 ${formatDuration(props.message.durationMs)}`];
  const usage = props.message.usage;
  if (usage) {
    if (usage.inputTokens !== undefined) parts.push(`输入 ${usage.inputTokens.toLocaleString()}`);
    if (usage.outputTokens !== undefined) parts.push(`输出 ${usage.outputTokens.toLocaleString()}`);
    parts.push(usage.cachedInputTokens === undefined ? "缓存命中 未提供" : `缓存命中 ${usage.cachedInputTokens.toLocaleString()}`);
    if (usage.inputTokens === undefined && usage.outputTokens === undefined && usage.totalTokens !== undefined) {
      parts.push(`合计 ${usage.totalTokens.toLocaleString()} tokens`);
    }
  }
  if (props.message.model) parts.push(props.message.model);
  return parts.join(" · ");
});
const hasDeleteOperation = computed(
  () => props.message.proposal?.operations.some(operation => operation.type === "delete-element") ?? false
);

/** 计划步骤的勾选状态：默认全选，切换计划或转成提案后重置 */
const checkedStepIds = ref<string[]>([]);
watch(
  () => props.message.plan?.id,
  () => {
    checkedStepIds.value = props.message.plan?.steps.map(step => step.id) ?? [];
  },
  { immediate: true }
);

/** 计划待选择且本轮不在流式中才允许勾选与执行 */
const planLocked = computed(() => !!props.streaming || props.message.plan?.status !== "pending");

function toggleStepChecked(stepId: string): void {
  if (planLocked.value) return;
  checkedStepIds.value = checkedStepIds.value.includes(stepId)
    ? checkedStepIds.value.filter(id => id !== stepId)
    : [...checkedStepIds.value, stepId];
}

function planStatusLabel(status: AiChangePlan["status"]): string {
  return { pending: "待选择", converted: "已转为提案", rejected: "已忽略" }[status];
}

/** 可回滚的操作数：已提交、带逆操作且尚未回滚 */
const rollbackableCount = computed(
  () =>
    props.message.proposal?.operations.filter(operation => operation.status === "completed" && operation.revert && !operation.reverted)
      .length ?? 0
);
const rollbackable = computed(() => rollbackableCount.value > 0 && !props.streaming);

/** 回滚结果提示：已回滚项数 + 未能回滚的原因 */
const rollbackNotice = computed(() => {
  const result = props.message.rollback;
  if (!result) return "";

  const parts: string[] = [];
  if (result.reverted) parts.push(`已回滚 ${result.reverted} 项改动`);
  if (result.skipped.length) parts.push(`未能回滚：${result.skipped.join("；")}`);
  return parts.join("；") || "没有可回滚的改动";
});

watch(
  () => props.streaming,
  streaming => {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;

    if (!streaming) return;

    elapsedSeconds.value = 0;
    elapsedTimer = setInterval(() => {
      elapsedSeconds.value += 1;
    }, 1000);
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  clearInterval(elapsedTimer);
  clearTimeout(copiedTimer);
});

function toggleProcess(): void {
  processOpen.value = !processOpen.value;
}

/** 步骤详情只在用户点击后展开；运行中的步骤也不例外，进度由行内高亮与状态提示表达 */
function isOpen(item: ProcessStep): boolean {
  return openKeys.value.has(item.key);
}

function toggleStep(key: string): void {
  const next = new Set(openKeys.value);

  if (next.has(key)) next.delete(key);
  else next.add(key);

  openKeys.value = next;
}

/** 画布操作执行成功后保留 result（里面有新图形 id，供连线引用），其他类型成功时隐藏 */
function isDiagramOperation(type: AiChangeOperation["type"]): boolean {
  return type === "create-shape" || type === "create-connector" || type === "place-shape" || type === "arrange-shapes";
}

/** 附件副标题：类型 + 体积；文本被截断、图片被清理等状态也在这里标注 */
function attachmentMeta(attachment: AiAttachment): string {
  if (attachment.kind === "image" && attachment.missing) return "图片已清理";
  const parts = [attachmentKindLabel(attachment), formatAttachmentSize(attachment.size)];
  if (attachment.truncated) parts.push("已截断");
  return parts.join(" · ");
}

/** 点图片附件看大图；文本附件没有可预览的内容 */
function previewAttachment(attachment: AiAttachment): void {
  if (attachment.dataUrl) previewDataUrl.value = attachment.dataUrl;
}

/** 选择卡片已作答（展示答案、禁用选项与输入框） */
const choiceAnswered = computed(() => {
  const status = props.message.choicePrompt?.status;
  return status === "answered" || status === "skipped";
});
/** 手动输入框的内容 */
const customChoiceText = ref("");
/** 用户点选的选项 id（高亮用；作答后卡片整体禁用） */
const selectedOptionId = ref("");

/** 点选选项：直接作为答案提交，由面板转发给 store 继续下一轮 */
function chooseOption(option: AiChoiceOption): void {
  const prompt = props.message.choicePrompt;
  if (!prompt || prompt.status !== "pending" || props.streaming) return;
  selectedOptionId.value = option.id;
  emit("answerChoice", props.message.id, prompt.id, option.label);
}

/** 跳过本次追问，以独立于选项答案的信号继续任务。 */
function skipChoice(): void {
  const prompt = props.message.choicePrompt;
  if (!prompt || prompt.status !== "pending" || props.streaming) return;
  emit("answerChoice", props.message.id, prompt.id, null);
}

/** 手动输入提交：判空后同样走 answerChoice 通道 */
function submitCustomChoice(): void {
  const prompt = props.message.choicePrompt;
  const text = customChoiceText.value.trim();
  if (!prompt || prompt.status !== "pending" || !text || props.streaming) return;
  emit("answerChoice", props.message.id, prompt.id, text);
}

/** 把机器工具名翻译成动作描述，并带上关键入参 */
function toolLabel(call: AiToolCallView): string {
  const base = TOOL_LABELS[call.name] ?? call.name;
  const input = (call.input ?? {}) as Record<string, unknown>;
  const hint = input.keyword ?? input.elementId ?? input.rootId;

  if (typeof hint !== "string" || !hint) return base;
  return `${base} · ${hint}`;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;

  if (seconds < 10) return `${seconds.toFixed(1)} 秒`;
  if (seconds < 60) return `${Math.round(seconds)} 秒`;

  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 复制整条回复的原文（markdown 源文本） */
async function copyContent(event: MouseEvent): Promise<void> {
  const content = props.message.content;
  if (!content) return;
  const owner = (event.currentTarget as HTMLElement).ownerDocument;
  if (!(await writeClipboard(content, owner).catch(() => false))) return;

  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1500);
}

/** 写入剪贴板：优先 Clipboard API，失败时回退到隐藏 textarea */
async function writeClipboard(text: string, owner: Document): Promise<boolean> {
  try {
    await (owner.defaultView?.navigator ?? navigator).clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文或权限受限时走回退分支
  }

  const textarea = owner.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  owner.body.appendChild(textarea);
  textarea.select();

  const ok = owner.execCommand("copy");
  owner.body.removeChild(textarea);
  return ok;
}

/** 已展开「查看提交文本」的操作 id */
const visibleTextIds = ref<Set<string>>(new Set());

function textVisible(operationId: string): boolean {
  return visibleTextIds.value.has(operationId);
}

function toggleText(operationId: string): void {
  const next = new Set(visibleTextIds.value);
  if (next.has(operationId)) next.delete(operationId);
  else next.add(operationId);
  visibleTextIds.value = next;
}

function proposalStatusLabel(status: AiChangeProposal["status"]): string {
  return { pending: "待确认", executing: "执行中", completed: "已完成", partial: "部分失败", rejected: "不可执行" }[status];
}

function operationStatusLabel(status: AiChangeOperation["status"]): string {
  return { pending: "待执行", running: "执行中", completed: "已提交", failed: "未完成", skipped: "已跳过" }[status];
}
</script>

<style lang="scss" scoped>
@use "./panel-tokens" as tok;

/* 宿主全局 reset 关掉了文本选择，对话内容需要能选中复制 */
.turn__body :deep(*),
.turn__user-text {
  user-select: text;
}

/** 面板内滚动条一律隐藏，滚动交互不变 */
.trace__reasoning,
.trace__well,
:deep(pre) {
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.turn {
  @include tok.ai-tokens;

  margin-bottom: 16px;
  font-family: var(--ai-font);
}

/* ---------------- 用户消息 ---------------- */

.turn--user {
  display: flex;
  justify-content: flex-end;
}

/* 正文气泡 + 技能标记 + 附件条，整体右对齐 */
.turn__user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  max-width: 92%;
}

.turn__user-text {
  width: fit-content;
  max-width: 100%;
  margin: 0;
  padding: 9px 14px;
  border-radius: 12px;
  background: var(--ai-accent-soft);
  color: var(--md-text-primary);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 本轮的技能标记：/name 形式，等宽字体，与输入区的技能 token 同族 */
.turn__skills {
  margin: 0;
  color: var(--md-text-secondary);
  font-family: var(--ai-mono);
  font-size: 11px;
}

.turn__files {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.turn__file {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 8px;
  border: 1px solid var(--md-neutral-200);
  border-radius: var(--md-radius-md);
  background: #fff;
  color: var(--md-text-regular);
  font: inherit;
  font-size: 12px;

  &:disabled {
    cursor: default;
  }
}

.turn__file-thumb {
  width: 28px;
  height: 28px;
  border-radius: var(--md-radius-sm);
  object-fit: cover;
}

.turn__file-icon {
  @include tok.ai-icon(14px, 1.8);

  color: var(--md-text-placeholder);
}

.turn__file-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.turn__file-meta {
  @include tok.ai-tabular;

  flex-shrink: 0;
  color: var(--md-text-placeholder);
}

/* 图片大图预览：面板内浮层 */
.turn-preview {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(15, 18, 23, 0.55);
  cursor: zoom-out;
}

.turn-preview__image {
  max-width: 100%;
  max-height: 100%;
  border-radius: var(--md-radius-lg);
  background: #fff;
  object-fit: contain;
}

/* ---------------- 过程（工作日志） ---------------- */

/* 阶段使用自然文档顺序，正文不会被移到所有工具调用之后。 */
.turn__stage + .turn__stage {
  margin-top: 8px;
}

.trace {
  display: flex;
  flex-direction: column;
  margin: 0 0 8px;
}

.trace__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding-right: 4px;
  border-radius: var(--md-radius-md);
  background: transparent;
}

/* 步骤图标固定宽度，使展开的调用和详情保持对齐。 */
.trace__slot {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}

.trace__item .trace__slot {
  border-radius: var(--md-radius-sm);
  background: transparent;
}

/* 运行中的步骤使用浅底强调。 */
.trace__row.is-live .trace__slot {
  background: var(--ai-accent-soft);
}

/* 摘要保持一行，运行进度和失败状态在收起时仍可见。 */
.trace__row--summary {
  width: fit-content;
  max-width: 100%;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--md-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;

  .trace__text {
    color: var(--md-text-secondary);
    font-size: 12px;
  }

  &:focus-visible {
    outline: 2px solid var(--ai-accent);
    outline-offset: 1px;
  }
}

/* 运行中的阶段标题跟步骤一样点亮，避免整行看起来是灰的 */
.trace__row--summary.is-live .trace__text {
  color: var(--ai-accent);
}

.trace__items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 12px;
}

.trace__item {
  position: relative;
}

.trace__icon {
  @include tok.ai-icon(12px, 2);

  color: var(--md-text-placeholder);
  transition: color 0.15s;
}

.trace__row.is-live .trace__icon {
  color: var(--ai-accent);
}

.trace__row:hover .trace__icon {
  color: var(--md-text-secondary);
}

.trace__label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:disabled {
    cursor: default;
  }
}

.trace__text {
  overflow: hidden;
  color: var(--md-text-secondary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trace__row:hover .trace__text {
  color: var(--md-text-primary);
}

.trace__label:disabled .trace__text {
  color: var(--md-text-secondary);
}

/* 思考中：主色文字 + 跳动的小点，避免看起来像卡住 */
.trace__text.is-thinking {
  color: var(--ai-accent);
}

/* 时长、步数等机械元数据：弱一级、等宽数字 */
.trace__meta {
  @include tok.ai-tabular;

  flex-shrink: 0;
  color: var(--md-text-placeholder);
  font-size: 12px;
}

.trace__dots {
  display: inline-flex;
  align-items: center;
  margin-left: 3px;

  i {
    width: 3px;
    height: 3px;
    margin-left: 2px;
    border-radius: 50%;
    background: currentColor;
    animation: ai-dot 1.1s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.18s;
    }

    &:nth-child(3) {
      animation-delay: 0.36s;
    }
  }
}

.trace__state {
  flex-shrink: 0;
  color: var(--md-text-secondary);
  font-size: 12px;

  &.is-running {
    color: var(--ai-accent);
  }

  &.is-error {
    color: var(--ai-danger);
  }
}

.trace__chevron {
  @include tok.ai-icon(12px, 2);

  color: var(--md-text-placeholder);
  transition: transform 0.15s;

  &.is-open {
    transform: rotate(90deg);
  }
}

/* 思考文本：浅底块，内容持续追加时保持滚动到底部 */
.trace__reasoning {
  margin: 6px 0 14px;
  padding: 2px 12px;
  border-left: 3px solid var(--md-neutral-200);
  background: transparent;
  color: var(--md-text-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow: auto;
}

/* 工具调用明细：缩进对齐到轨道线右侧的文本列 */
.trace__detail {
  margin: 2px 0 10px 28px;
}

.trace__section + .trace__section {
  margin-top: 10px;
}

.trace__section-label {
  display: block;
  margin-bottom: 4px;
  color: var(--md-text-placeholder);
  font-size: 11px;
}

.trace__call {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--md-neutral-200);
  border-radius: var(--md-radius-sm);
  background: var(--md-neutral-100);
  color: var(--md-text-regular);
  font-family: var(--ai-mono);
  font-size: 12px;
}

.trace__well {
  margin: 4px 0 0;
  padding: 8px 12px;
  border: 1px solid var(--md-neutral-200);
  border-radius: var(--md-radius-md);
  background: var(--md-neutral-50);
  color: var(--md-text-regular);
  font-family: var(--ai-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;

  &.is-error {
    border-color: rgba(207, 74, 66, 0.28);
    background: #fdf4f3;
    color: var(--ai-danger);
  }
}

.trace__spinner {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--md-neutral-300);
  border-top-color: var(--ai-accent);
  border-radius: 50%;
  animation: ai-spin 0.8s linear infinite;
}

/* ---------------- 回复收尾 ---------------- */

.turn__footer {
  @include tok.ai-tabular;

  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  color: var(--md-text-placeholder);
  font-size: 11px;
}

/* 复制整段：复制成功后短暂变成对勾 */
.turn__copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: var(--md-radius-md);
  background: transparent;
  color: var(--md-text-placeholder);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;

  svg {
    @include tok.ai-icon(13px, 1.9);
  }

  &:hover {
    background: var(--md-neutral-100);
    color: var(--md-text-primary);
  }
}

/* ---------------- 变更提案 ---------------- */

.proposal {
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid var(--ai-accent-line);
  border-radius: 10px;
  background: var(--ai-accent-soft);
}

.proposal__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.proposal__header strong {
  color: var(--md-text-primary);
  font-size: 13px;
  font-weight: 600;
}

.proposal__status,
.proposal__operation-status {
  flex-shrink: 0;
  color: var(--md-text-secondary);
  font-size: 11px;
}

.proposal__status.is-completed,
.proposal__operation-status.is-completed {
  color: var(--ai-ok);
}

.proposal__status.is-partial,
.proposal__status.is-rejected,
.proposal__operation-status.is-failed {
  color: var(--ai-danger);
}

.proposal__summary,
.proposal__result {
  margin: 5px 0 0;
  color: var(--md-text-regular);
  font-size: 12px;
  line-height: 1.6;
}

.proposal__warning {
  margin: 7px 0 0;
  color: var(--ai-danger);
  font-size: 12px;
}

.proposal__operations {
  margin: 6px 0 0;
  padding-left: 16px;
  color: var(--md-text-regular);
  font-size: 12px;
  line-height: 1.6;
}

/* 摘要在左、状态在右；执行结果独占一行，避免把摘要挤成竖排 */
.proposal__operations li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 3px 8px;
}

.proposal__operations li + li {
  margin-top: 4px;
}

.proposal__operations li > .proposal__result {
  flex: 1 1 100%;
}

.proposal__operation-summary {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

.proposal__result {
  color: var(--md-text-secondary);
}

/* 查看提交文本：小字链接样式，文本区可直接复制 */
.proposal__text-toggle {
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ai-accent);
  font: inherit;
  font-size: 11px;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.proposal__text {
  flex: 1 1 100%;
  max-height: 260px;
  margin: 2px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--md-neutral-200);
  border-radius: var(--md-radius-md);
  background: #fff;
  color: var(--md-text-regular);
  font-family: var(--ai-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  user-select: text;
}

.proposal__execute {
  margin-top: 10px;
  padding: 6px 12px;
  border: 1px solid var(--ai-accent);
  border-radius: var(--md-radius-md);
  background: var(--ai-accent);
  color: #fff;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 0.15s,
    border-color 0.15s;

  &:hover:not(:disabled) {
    border-color: var(--ai-accent-strong);
    background: var(--ai-accent-strong);
  }

  &:disabled {
    border-color: var(--md-neutral-200);
    background: var(--md-neutral-200);
    color: var(--md-text-placeholder);
    cursor: not-allowed;
  }
}

/* 已回滚标记与回滚入口：次级按钮，与「确认并执行」区分主次 */
.proposal__operation-status.is-reverted {
  color: var(--ai-warn);
}

.proposal__rollback {
  margin-top: 10px;
  margin-left: 8px;
  padding: 6px 12px;
  border: 1px solid var(--md-border-color);
  border-radius: var(--md-radius-md);
  background: #fff;
  color: var(--md-text-regular);
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;

  &:hover:not(:disabled) {
    border-color: var(--ai-accent-line);
    color: var(--md-text-primary);
  }

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}

.proposal__rollback-notice {
  margin: 6px 0 0;
  color: var(--md-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-line;
}

/* ---------------- 分步计划 ---------------- */

/* 分步计划卡片：中性地平线卡片，勾选步骤后转提案确认 */
.plan {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--md-neutral-200);
  border-radius: 8px;
  background: var(--md-neutral-50);
}

.plan__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.plan__header strong {
  color: var(--md-text-primary);
  font-weight: 600;
}

.plan__status {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--md-neutral-100);
  color: var(--md-text-secondary);
  font-size: 11px;
  line-height: 16px;

  &.is-converted {
    color: var(--ai-ok);
  }
}

.plan__summary {
  margin: 6px 0 8px;
  color: var(--md-text-regular);
  font-size: 12px;
  line-height: 1.6;
}

.plan__steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan__step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  line-height: 1.6;
  cursor: pointer;

  input {
    margin-top: 2px;
    cursor: pointer;
  }

  input:disabled {
    cursor: default;
  }
}

.plan__step-summary {
  color: var(--md-text-primary);
}

.plan__step-acceptance,
.plan__step-result {
  display: block;
  margin: 2px 0 0 22px;
  color: var(--md-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.plan__step-status {
  margin-left: 6px;
  color: var(--md-text-secondary);
  font-size: 11px;

  &.is-completed {
    color: var(--ai-ok);
  }

  &.is-failed {
    color: var(--ai-danger);
  }
}

.plan__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.plan__reject {
  padding: 6px 12px;
  border: 1px solid var(--md-border-color);
  border-radius: var(--md-radius-md);
  background: transparent;
  color: var(--md-text-regular);
  font-size: 13px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}

/* ---------------- 用户选择卡片 ---------------- */

/* 问题 + 选项按钮 + 手动输入 */
.choice {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--md-neutral-200);
  border-radius: 8px;
  background: #fff;
}

.choice__question {
  margin: 0;
  color: var(--md-text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.55;
}

.choice__options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.choice__option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--md-border-color);
  border-radius: var(--md-radius-md);
  background: #fff;
  color: var(--md-text-regular);
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background-color 0.15s;

  &:hover:not(:disabled) {
    border-color: var(--ai-accent-line);
    background: var(--md-neutral-50);
  }

  &.is-selected {
    border-color: var(--ai-accent-line);
    background: var(--ai-accent-soft);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }
}

.choice__label {
  font-weight: 600;
}

.choice__description {
  color: var(--md-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.choice__answer {
  margin: 6px 0 0;
  color: var(--ai-ok);
  font-size: 12px;
}

.choice__custom {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.choice__input {
  flex: 1;
  min-width: 0;
  padding: 5px 9px;
  border: 1px solid var(--md-border-color);
  border-radius: var(--md-radius-md);
  background: #fff;
  color: var(--md-text-primary);
  font: inherit;
  font-size: 12px;
  outline: none;

  &:focus {
    border-color: var(--ai-accent);
  }

  &::placeholder {
    color: var(--md-text-placeholder);
  }
}

.choice__skip {
  display: block;
  margin: 10px 0 0 auto;
  padding: 4px 0;
  border: none;
  background: transparent;
  color: var(--md-text-secondary);
  font: inherit;
  cursor: pointer;
  &:hover:not(:disabled) {
    color: var(--md-text-primary);
    text-decoration: underline;
  }
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
  &:focus-visible {
    outline: 2px solid var(--md-text-secondary);
    outline-offset: 3px;
  }
}

.choice__send {
  flex-shrink: 0;
  padding: 5px 12px;
  border: 1px solid var(--ai-accent);
  border-radius: var(--md-radius-md);
  background: var(--ai-accent);
  color: #fff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;

  &:disabled {
    border-color: var(--md-neutral-200);
    background: var(--md-neutral-200);
    color: var(--md-text-placeholder);
    cursor: not-allowed;
  }
}

/* ---------------- Markdown 正文 ---------------- */

/** 模型返回的 Markdown 正文；行距与段距收紧，长回答保持紧凑 */
.turn__md {
  color: var(--md-text-primary);
  font-size: 13px;
  line-height: 1.68;
  word-break: break-word;

  :deep(> :first-child) {
    margin-top: 0;
  }

  :deep(> :last-child) {
    margin-bottom: 0;
  }

  :deep(p) {
    margin: 0 0 6px;
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    margin: 14px 0 6px;
    font-weight: 600;
    line-height: 1.4;
  }

  :deep(h1) {
    font-size: 15px;
  }

  :deep(h2) {
    font-size: 13.5px;
  }

  :deep(h3),
  :deep(h4) {
    font-size: 13px;
  }

  :deep(ul),
  :deep(ol) {
    margin: 0 0 6px;
    padding-left: 18px;
  }

  :deep(li) {
    margin: 2px 0;
  }

  :deep(li > p) {
    margin: 0;
  }

  :deep(strong) {
    font-weight: 600;
  }

  :deep(a) {
    color: var(--ai-accent);
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  :deep(blockquote) {
    margin: 6px 0;
    padding: 3px 0 3px 10px;
    border-left: 2px solid var(--md-neutral-200);
    color: var(--md-text-secondary);
  }

  :deep(hr) {
    margin: 10px 0;
    border: none;
    border-top: 1px solid var(--md-neutral-200);
  }

  :deep(code) {
    padding: 1px 5px;
    border-radius: var(--md-radius-sm);
    background: var(--md-neutral-100);
    font-family: var(--ai-mono);
    font-size: 12px;
  }

  :deep(pre) {
    margin: 6px 0;
    padding: 8px 10px;
    border: 1px solid var(--md-neutral-200);
    border-radius: var(--md-radius-md);
    background: var(--md-neutral-50);
    overflow: auto;
  }

  :deep(pre code) {
    display: block;
    padding: 0;
    background: transparent;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
  }

  :deep(table) {
    display: block;
    width: 100%;
    margin: 6px 0;
    border-collapse: collapse;
    font-size: 12px;
    overflow-x: auto;
  }

  :deep(th),
  :deep(td) {
    padding: 4px 8px;
    border: 1px solid var(--md-neutral-200);
    text-align: left;
    word-break: break-word;
  }

  :deep(th) {
    background: var(--md-neutral-100);
    font-weight: 600;
  }

  :deep(.ai-md-caret) {
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 2px;
    vertical-align: -0.15em;
    background: var(--ai-accent);
    animation: ai-caret-blink 1.05s steps(1, end) infinite;
  }

  /* 关键词标记：底色区分语义，密集出现时也能一眼扫到 */
  :deep(.kw--id) {
    padding: 1px 5px;
    border-radius: var(--md-radius-sm);
    background: #efe9fb;
    color: #5b46a8;
    font-family: var(--ai-mono);
    font-size: 12px;
  }

  :deep(.kw--tool) {
    padding: 1px 5px;
    border-radius: var(--md-radius-sm);
    background: #e9f1fc;
    color: #2b579f;
    font-family: var(--ai-mono);
    font-size: 12px;
  }

  :deep(.kw--sysml) {
    padding: 1px 5px;
    border-radius: var(--md-radius-sm);
    background: #e7f5ef;
    color: #1f7a58;
    font-family: var(--ai-mono);
    font-size: 12px;
  }

  :deep(.kw--option) {
    padding: 1px 5px;
    border-radius: var(--md-radius-sm);
    background: #fbf1e0;
    color: #8a6420;
    font-weight: 600;
  }

  :deep(.kw--doc) {
    padding: 1px 5px;
    border-radius: var(--md-radius-sm);
    background: var(--md-neutral-100);
    color: var(--md-text-regular);
    font-family: var(--ai-mono);
    font-size: 12px;
  }
}

/* ---------------- 动画 ---------------- */

@keyframes ai-caret-blink {
  0%,
  49% {
    opacity: 1;
  }

  50%,
  100% {
    opacity: 0;
  }
}

@keyframes ai-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes ai-dot {
  0%,
  60%,
  100% {
    opacity: 0.25;
    transform: translateY(0);
  }

  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .trace__spinner {
    animation: none;
  }

  .trace__dots i {
    animation: none;
    opacity: 1;
  }

  .trace__chevron,
  .trace__row,
  .trace__slot,
  .trace__icon,
  .turn__copy {
    transition: none;
  }

  .turn__md :deep(.ai-md-caret) {
    animation: none;
  }
}
.turn__run-state {
  margin: 8px 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ai-text-secondary, #64748b);
}
</style>
