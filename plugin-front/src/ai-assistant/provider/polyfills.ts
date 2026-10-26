/**
 * 为 Electron 22（Chromium 108）补齐 AI SDK 依赖的较新运行时 API。
 */
function installAbortSignalAny(): void {
  type AbortSignalWithAny = typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };
  const signalCtor = (globalThis as { AbortSignal?: AbortSignalWithAny }).AbortSignal;
  if (!signalCtor || typeof signalCtor.any === "function") return;

  signalCtor.any = signals => {
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];

    const abortFrom = (signal: AbortSignal) => {
      cleanups.forEach(cleanup => cleanup());
      cleanups.length = 0;
      (controller.abort as (reason?: unknown) => void)((signal as { reason?: unknown }).reason);
    };

    for (const signal of signals) {
      if (signal.aborted) {
        abortFrom(signal);
        break;
      }

      const listener = () => abortFrom(signal);
      signal.addEventListener("abort", listener);
      cleanups.push(() => signal.removeEventListener("abort", listener));
    }

    return controller.signal;
  };
}

installAbortSignalAny();
