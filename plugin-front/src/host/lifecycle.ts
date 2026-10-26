import { ref } from "vue";

export const pluginActive = ref(false);
const cleanups = new Set<() => void>();

export function registerCleanup(cleanup: () => void): () => void {
  cleanups.add(cleanup);
  return () => cleanups.delete(cleanup);
}

export function stopPlugin(): void {
  pluginActive.value = false;
  cleanups.forEach(cleanup => cleanup());
  cleanups.clear();
}
