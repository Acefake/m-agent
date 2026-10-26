<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { isElectron } from "../../../host/runtime";
import { connectDetachedSession, publishDraft, webWindowTargets, type DetachedSession } from "../../../presentation/window-session";

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ sure: [data: unknown]; close: [data: unknown] }>();
const { PlatformModal, usePlatformModalUtil } = window.api;
const { visible, handleOk } = usePlatformModalUtil(emit);
const target = ref<HTMLElement>();
const ready = ref(false);
const error = ref("");
let session: DetachedSession | undefined;
let disposed = false;
const Panel = defineAsyncComponent(() => import("../../panels/aiAssistant/index.vue"));
async function bindWebWindow(): Promise<void> {
  visible.value = true;
  await nextTick();
  if (!disposed && target.value) webWindowTargets.get(props.sessionId)?.(target.value, () => handleOk());
}
watch(
  () => props.sessionId,
  () => {
    if (!isElectron) void bindWebWindow();
  }
);

function closeWindow(): void {
  publishDraft();
  handleOk();
}

onMounted(async () => {
  if (!isElectron) {
    await bindWebWindow();
    return;
  }
  try {
    session = await connectDetachedSession(props.sessionId, closeWindow);
    if (disposed) {
      session.dispose();
      return;
    }
    ready.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
});
onBeforeUnmount(() => {
  disposed = true;
  session?.dispose();
});
</script>

<template>
  <PlatformModal
    :visible="visible"
    title="AI 建模助手"
    :width="1120"
    :height="900"
    :min-width="800"
    :min-height="600"
    :show-footer="false"
    :mask="false"
    :resizable="true"
    :show-sizer="true"
    class="agent-window"
    @cancel="closeWindow"
  >
    <div
      ref="target"
      class="agent-window__content"
    >
      <Panel v-if="isElectron && ready" />
      <p v-else-if="isElectron">{{ error || "正在连接原项目窗口…" }}</p>
    </div>
  </PlatformModal>
</template>

<style lang="scss" scoped>
.agent-window__content {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
:deep(.c-platform-modal--content) {
  padding: 0 !important;
  overflow: hidden;
}
</style>
