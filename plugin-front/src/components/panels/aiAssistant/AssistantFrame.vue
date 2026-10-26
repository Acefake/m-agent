<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import {
  assistantPresentation,
  hostGlobal,
  PANEL_VALUE,
  pendingAssistantOpen,
  registerAssistantPresentation,
  rememberAssistantPresentation
} from "../../../presentation/panel";
import { registerCleanup } from "../../../host/lifecycle";
import { isElectron, notify } from "../../../host/runtime";
import {
  ASSISTANT_WINDOW_NAME,
  createOwnerSession,
  detachedSession,
  publishDraft,
  webWindowTargets
} from "../../../presentation/window-session";
import { useAiAssistantStore } from "../../../ai-assistant/conversation/store";

const mirror = detachedSession;
const store = useAiAssistantStore();
const launching = ref(!mirror && assistantPresentation() === "window" && pendingAssistantOpen());
const target = ref<HTMLElement>();
const detached = ref(false);
const busy = ref(false);
const floating = computed(() => Boolean(mirror || detached.value || target.value));
let session: ReturnType<typeof createOwnerSession> | undefined;
let ipcWindow: InstanceType<typeof window.api.IpcWindow> | undefined;
let closeWeb: (() => void) | undefined;
let webId = "";
let openingTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let docking = false;
let openedSuccessfully = false;
let removePresentation: (() => void) | undefined;

async function restore(): Promise<void> {
  if (openingTimer) clearTimeout(openingTimer);
  openingTimer = undefined;
  if (!disposed) hostGlobal()?.setActiveRightTab?.(docking || !openedSuccessfully ? PANEL_VALUE : undefined);
  await nextTick();
  target.value = undefined;
  detached.value = false;
  busy.value = false;
  launching.value = false;
  session?.dispose();
  session = undefined;
  if (webId) webWindowTargets.delete(webId);
  closeWeb = undefined;
}

function requestDock(): void {
  docking = true;
  rememberAssistantPresentation("panel");
  if (mirror) {
    publishDraft();
    mirror.send({ type: "dock" });
  } else if (session) session.close();
  else closeWeb?.();
}

function toggle(): void {
  if (floating.value) {
    requestDock();
    return;
  }
  if (busy.value) return;
  try {
    if (!window.api.IpcWindow) throw new Error("当前宿主未提供通用 IpcWindow");
    busy.value = true;
    launching.value = true;
    docking = false;
    openedSuccessfully = false;
    ipcWindow ??= new window.api.IpcWindow(ASSISTANT_WINDOW_NAME);
    let sessionId: string;
    const opened = () => {
      if (disposed) return;
      if (openingTimer) clearTimeout(openingTimer);
      busy.value = false;
      openedSuccessfully = true;
      launching.value = false;
      rememberAssistantPresentation("window");
      detached.value = isElectron;
      hostGlobal()?.setActiveRightTab?.(undefined);
    };
    if (isElectron) {
      session = createOwnerSession(store, opened, requestDock);
      sessionId = session.id;
    } else {
      webId = crypto.randomUUID();
      sessionId = webId;
      webWindowTargets.set(webId, (element, close) => {
        target.value = element;
        closeWeb = close;
        opened();
      });
    }
    openingTimer = setTimeout(() => {
      requestDock();
      ipcWindow?.done();
      void restore();
      notify({ title: "AI 智能体", message: "助手窗口启动超时，请重试", type: "error", forbidTranslate: true });
    }, 12000);
    void ipcWindow
      .popup({ sessionId })
      .catch(error => {
        if (error) notify({ title: "AI 智能体", message: String(error), type: "error", forbidTranslate: true });
      })
      .finally(restore);
  } catch (error) {
    void restore();
    notify({ title: "AI 智能体", message: String(error), type: "error", forbidTranslate: true });
  }
}

const removeCleanup = registerCleanup(() => {
  if (session) session.close();
  else closeWeb?.();
  ipcWindow?.done();
  void restore();
});
onMounted(() => {
  mirror?.mounted();
  if (!mirror)
    removePresentation = registerAssistantPresentation(() => {
      if (assistantPresentation() === "window" && !floating.value && !busy.value) toggle();
    });
});
onBeforeUnmount(() => {
  disposed = true;
  removePresentation?.();
  if (mirror) publishDraft();
  else if (session) session.close();
  else closeWeb?.();
  ipcWindow?.done();
  void restore();
  removeCleanup();
});
</script>

<template>
  <div
    class="ai-assistant-mount"
    :class="{ 'is-floating': (floating || launching) && !mirror, 'is-mirror': mirror }"
  >
    <Teleport
      :to="target || 'body'"
      :disabled="!target"
    >
      <section
        class="ai-assistant-frame"
        :class="{ 'is-detached': detached, 'is-launching': launching, 'is-window': floating }"
      >
        <slot
          :floating="floating"
          :toggle="toggle"
          :busy="busy"
        />
      </section>
    </Teleport>
  </div>
</template>

<style lang="scss" scoped>
.ai-assistant-mount {
  /* 停靠时宽度跟着面板拖拽变量走，独立窗口与镜像另有两处覆盖 */
  width: var(--ai-panel-width, 580px);
  height: 100%;
  min-height: 0;
}
.ai-assistant-mount.is-floating {
  width: 0;
  height: 0;
}
.ai-assistant-mount.is-mirror {
  width: 100%;
}
.ai-assistant-frame {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
}
.ai-assistant-frame.is-launching,
.ai-assistant-frame.is-detached {
  display: none;
}
</style>
