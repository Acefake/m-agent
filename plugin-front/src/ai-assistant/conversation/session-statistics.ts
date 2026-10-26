import type { AiChatMessage } from "../types";

/** 汇总当前会话已记录的数据；历史缺项标记为部分统计，专家用量不重复累计。 */
export function aggregateSessionStatistics(
  messages: readonly AiChatMessage[],
  options: { contextLength?: number; model?: string; running?: boolean; now?: number } = {}
) {
  const runs = messages.filter(message => message.role === "assistant");
  const sum = (values: (number | undefined)[]) =>
    values.length && values.every(value => value !== undefined)
      ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
      : undefined;
  const subtotal = (values: (number | undefined)[]) => {
    const known = values.filter((value): value is number => value !== undefined);
    return known.length ? known.reduce((total, value) => total + value, 0) : undefined;
  };
  const wallMs = sum(
    runs.map(
      (run, index) =>
        run.durationMs ??
        (options.running && index === runs.length - 1 && options.now !== undefined ? Math.max(0, options.now - run.createdAt) : undefined)
    )
  );
  const measured = runs.filter(run => run.metrics);
  const modelMs = sum(measured.map(run => run.metrics?.modelMs));
  const toolMs = sum(measured.map(run => run.metrics?.toolMs));
  const firstTokenCount = sum(measured.map(run => run.metrics?.firstTokenCount));
  const firstTokenTotal = sum(measured.map(run => run.metrics?.firstTokenMsTotal));
  const generationMs = sum(measured.map(run => run.metrics?.generationMs));
  const timedOutput = sum(measured.map(run => run.metrics?.timedOutputTokens));
  const input = subtotal(runs.map(run => run.usage?.inputTokens));
  const output = subtotal(runs.map(run => run.usage?.outputTokens));
  const total = subtotal(
    runs.map(
      run =>
        run.usage?.totalTokens ??
        (run.usage?.inputTokens !== undefined && run.usage?.outputTokens !== undefined
          ? run.usage.inputTokens + run.usage.outputTokens
          : undefined)
    )
  );
  const cacheRuns = runs.filter(run => run.usage?.inputTokens !== undefined && run.usage.cachedInputTokens !== undefined);
  const cached = subtotal(cacheRuns.map(run => run.usage?.cachedInputTokens));
  const cacheInput = subtotal(cacheRuns.map(run => run.usage?.inputTokens));
  const latest = [...runs].reverse().find(run => run.contextUsage || run.usage?.latestInputTokens !== undefined);
  const snapshot = latest?.contextUsage;
  const estimated = Boolean(snapshot && snapshot.inputTokens === undefined);
  const used = snapshot
    ? (snapshot.inputTokens ?? snapshot.systemTokens + snapshot.toolTokens + snapshot.messageTokens)
    : latest?.usage?.latestInputTokens;
  const limit = snapshot
    ? (snapshot.contextLength ?? (snapshot.model === options.model ? options.contextLength : undefined))
    : latest?.model === options.model
      ? options.contextLength
      : undefined;
  return {
    timing: {
      wallMs,
      modelMs,
      toolMs,
      firstTokenMs: firstTokenCount && firstTokenTotal !== undefined ? firstTokenTotal / firstTokenCount : undefined,
      tokensPerSecond: generationMs && timedOutput !== undefined ? timedOutput / (generationMs / 1000) : undefined,
      partial: measured.length > 0 && measured.length < runs.length
    },
    tokens: {
      input,
      output,
      total,
      cached,
      uncached: cacheInput !== undefined && cached !== undefined ? Math.max(0, cacheInput - cached) : undefined,
      cacheRate: cacheInput && cached !== undefined ? (cached / cacheInput) * 100 : undefined,
      partial: runs.some(
        run => run.usage?.inputTokens === undefined || run.usage?.outputTokens === undefined || run.usage?.cachedInputTokens === undefined
      )
    },
    context: {
      used,
      limit,
      percent: used !== undefined && limit ? (used / limit) * 100 : undefined,
      estimated,
      system: snapshot?.systemTokens,
      tools: snapshot?.toolTokens,
      messages: snapshot?.messageTokens,
      model: snapshot?.model ?? latest?.model
    }
  };
}
