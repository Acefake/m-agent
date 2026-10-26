import {
  isStepCount,
  asSchema,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolExecutionOptions,
  type ToolSet
} from "ai";
import type { AiRunState, AiUsage, AiRunMetrics } from "../types";
import { compactToolResults } from "./context-compaction";
import { compactSessionMessages, estimateMessagesTokens, estimateTextTokens } from "./session-compaction";

const STEPS_PER_SEGMENT = 8;
const MAX_REPEATED_STEPS = 3;
/** 写去重表保留的成功写入条数：A、B、A 交替时也不能重复执行 A */
const MAX_WRITE_RECEIPTS = 16;
const PAUSE_TOOLS = new Set(["ask_user_choice", "model_propose_changes", "model_present_plan"]);

type SettledTool = { id: string; name: string; input: unknown; output?: unknown; error?: string };
type LoopPart =
  | TextStreamPart<ToolSet>
  | { type: "run-state"; state: AiRunState }
  | { type: "model-context"; messages: ModelMessage[] }
  | { type: "run-usage"; usage: AiUsage }
  | { type: "tool-settled"; tool: SettledTool };

interface LoopOptions {
  onMetrics?: (metrics: AiRunMetrics) => void;
  onContextEstimate?: (tokens: { systemTokens: number; toolTokens: number; messageTokens: number; inputTokens?: number }) => void;
  model: LanguageModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  signal?: AbortSignal;
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
  /** 单次请求的输入预算（token）：超出时把较早会话折成摘要，见 session-compaction.ts */
  contextBudget?: number;
}

/** 采集真实请求与工具区间；模型计时排除同一请求中重叠的工具执行区间。 */
export function createRunMetrics(now = () => performance.now()) {
  const metrics: AiRunMetrics = { modelMs: 0, toolMs: 0, firstTokenMsTotal: 0, firstTokenCount: 0, generationMs: 0, timedOutputTokens: 0 };
  let started: number | undefined;
  let firstToken: number | undefined;
  let intervals: [number, number][] = [];
  const activeTools = new Set<{ begin: number }>();
  const overlap = (from: number, to: number) => {
    let end = from;
    let duration = 0;
    const spans: [number, number][] = [...intervals, ...[...activeTools].map(tool => [tool.begin, to] as [number, number])];
    for (const [left, right] of spans.sort((a, b) => a[0] - b[0])) {
      const begin = Math.max(from, left, end);
      const finish = Math.min(to, right);
      if (finish > begin) duration += finish - begin;
      end = Math.max(end, finish);
    }
    return duration;
  };
  return {
    snapshot: () => {
      const current = now();
      return {
        ...metrics,
        modelMs: metrics.modelMs + (started === undefined ? 0 : Math.max(0, current - started - overlap(started, current))),
        toolMs: metrics.toolMs + [...activeTools].reduce((sum, tool) => sum + current - tool.begin, 0)
      };
    },
    startRequest() {
      started = now();
      firstToken = undefined;
      intervals = [];
    },
    token() {
      if (started === undefined || firstToken !== undefined) return false;
      firstToken = now();
      metrics.firstTokenMsTotal += firstToken - started;
      metrics.firstTokenCount++;
      return true;
    },
    startTool() {
      const begin = now();
      const active = { begin };
      activeTools.add(active);
      return () => {
        const end = now();
        metrics.toolMs += end - begin;
        activeTools.delete(active);
        intervals.push([begin, end]);
      };
    },
    finishRequest(outputTokens?: number) {
      if (started === undefined) return;
      const end = now();
      metrics.modelMs += Math.max(0, end - started - overlap(started, end));
      if (firstToken !== undefined && outputTokens !== undefined) {
        const duration = end - firstToken - overlap(firstToken, end);
        if (duration > 0) {
          metrics.generationMs += duration;
          metrics.timedOutputTokens += outputTokens;
        }
      }
      started = undefined;
    }
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map(key => JSON.stringify(key) + ":" + stableJson(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function writeSignature(input: unknown): string {
  if (!input || typeof input !== "object" || !("operations" in input) || !Array.isArray(input.operations)) return stableJson(input);
  return stableJson(
    input.operations.map(operation => {
      if (!operation || typeof operation !== "object") return operation;
      const { id, summary, ...fields } = operation as Record<string, unknown>;
      return fields;
    })
  );
}

function toolContext(tools: SettledTool[]): ModelMessage[] {
  if (!tools.length) return [];
  return [
    {
      role: "assistant",
      content: tools.map(tool => ({ type: "tool-call" as const, toolCallId: tool.id, toolName: tool.name, input: tool.input }))
    },
    {
      role: "tool",
      content: tools.map(tool => ({
        type: "tool-result" as const,
        toolCallId: tool.id,
        toolName: tool.name,
        output: {
          type: tool.error ? ("error-text" as const) : ("text" as const),
          value: tool.error ?? (typeof tool.output === "string" ? tool.output : (JSON.stringify(tool.output) ?? ""))
        }
      }))
    }
  ];
}

/** 分段续跑同一任务；保留 SDK 原始工具上下文，显式报告暂停和异常。 */
export async function* streamAgentWithContinuation(options: LoopOptions): AsyncGenerator<LoopPart> {
  const timing = createRunMetrics();
  const publishMetrics = () => options.onMetrics?.(timing.snapshot());
  const telemetryTimer = options.onMetrics ? setInterval(publishMetrics, 1000) : undefined;
  const toolDefinitions = Promise.all(
    Object.entries(options.tools).map(async ([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.inputSchema ? await asSchema(tool.inputSchema).jsonSchema : {}
    }))
  );
  let contextEstimate: { systemTokens: number; toolTokens: number; messageTokens: number; inputTokens?: number } | undefined;
  const generated: ModelMessage[] = [];
  const usage: AiUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let cacheUsageComplete = true;
  const usageComplete = { inputTokens: true, outputTokens: true, totalTokens: true };
  const pending = new Set<Promise<unknown>>();
  const settled = new Map<string, SettledTool>();
  /** 成功写入的去重表：键为操作签名，值为当时的真实收据 */
  const writeReceipts = new Map<string, string>();
  /** 写操作串行链：同一模型的并发写可能相互冲突，串行也让去重判断可靠 */
  let writeChain: Promise<unknown> = Promise.resolve();
  let modelSteps = 0;
  let continuations = 0;
  let repeatedSteps = 0;
  let previousStep = "";
  let stalled = false;
  let pauseTool = "";
  let lastState: AiRunState | undefined;
  const state = (status: AiRunState["status"], message: string, finishReason?: string, rawFinishReason?: string): AiRunState => {
    lastState = { status, message, modelSteps, continuations, finishReason, rawFinishReason };
    return lastState;
  };

  const tools: ToolSet = Object.fromEntries(
    Object.entries(options.tools).map(([name, original]) => {
      const execute = original.execute;
      if (!execute) return [name, original];
      return [
        name,
        {
          ...original,
          execute: async (input: unknown, context: ToolExecutionOptions<unknown>) => {
            options.signal?.throwIfAborted();
            const signature = name === "model_apply_changes" ? writeSignature(input) : "";
            const run = async () => {
              // 排队期间可能已经收到停止信号：不再启动新的写操作
              options.signal?.throwIfAborted();
              const previous = signature ? writeReceipts.get(signature) : undefined;
              if (previous) return "这些改动刚刚已成功执行，本次未重复写入。实际结果：\n" + previous;
              const finishTool = timing.startTool();
              let output: unknown;
              try {
                output = await execute(input, { ...context, abortSignal: options.signal ?? context.abortSignal });
              } finally {
                finishTool();
                publishMetrics();
              }
              if (signature && typeof output === "string" && /^已执行 \d+ 项改动/.test(output)) {
                writeReceipts.set(signature, output);
                // 只保留最近的成功写入，避免长任务里去重表无限增长
                if (writeReceipts.size > MAX_WRITE_RECEIPTS) {
                  const oldest = writeReceipts.keys().next().value;
                  if (oldest !== undefined) writeReceipts.delete(oldest);
                }
              }
              return output;
            };
            const execution = signature ? writeChain.then(run, run) : run();
            if (signature) writeChain = execution.catch(() => undefined);
            pending.add(execution);
            try {
              const output = await execution;
              settled.set(context.toolCallId, { id: context.toolCallId, name, input, output });
              return output;
            } catch (error) {
              settled.set(context.toolCallId, { id: context.toolCallId, name, input, error: errorText(error) });
              throw error;
            } finally {
              pending.delete(execution);
            }
          }
        }
      ];
    })
  );

  try {
    for (let segment = 0; ; segment++) {
      if (options.signal?.aborted) break;
      settled.clear();
      pauseTool = "";
      const observed = new Set<string>();
      let finish: Extract<TextStreamPart<ToolSet>, { type: "finish" }> | undefined;
      let streamFailed = false;
      let thrownMessage = "";
      yield {
        type: "run-state",
        state: state(segment ? "continuing" : "running", segment ? "已保留已执行结果，正在自动继续剩余任务" : "正在执行")
      };
      const result = streamText({
        model: options.model,
        system: options.system,
        messages: [...options.messages, ...generated],
        tools,
        // 先在消息内缩减旧只读结果，仍超出请求预算时再把更早的轮次折成摘要
        prepareStep: async ({ messages }) => {
          const prepared = compactSessionMessages(compactToolResults(messages), options.contextBudget);
          const definitions = await toolDefinitions;
          contextEstimate = {
            systemTokens: estimateTextTokens(options.system),
            toolTokens: estimateTextTokens(JSON.stringify(definitions)),
            messageTokens: estimateMessagesTokens(prepared)
          };
          options.onContextEstimate?.({ ...contextEstimate });
          timing.startRequest();
          publishMetrics();
          return { messages: prepared };
        },
        providerOptions: options.providerOptions,
        abortSignal: options.signal,
        stopWhen: [isStepCount(STEPS_PER_SEGMENT), () => Boolean(pauseTool) || stalled],
        onError: () => undefined,
        onChunk: ({ chunk }) => {
          if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-input-delta") && timing.token())
            publishMetrics();
        },
        onStepFinish: step => {
          // 当前兼容供应商会把缺失 token 字段补成 0，需用原始响应区分未知与真实零值。
          const hasInput = typeof step.usage.raw?.prompt_tokens === "number";
          const hasOutput = typeof step.usage.raw?.completion_tokens === "number";
          if (contextEstimate)
            options.onContextEstimate?.({ ...contextEstimate, inputTokens: hasInput ? step.usage.inputTokens : undefined });
          timing.finishRequest(hasOutput ? step.usage.outputTokens : undefined);
          publishMetrics();
          usageComplete.inputTokens = usageComplete.inputTokens && hasInput;
          usageComplete.outputTokens = usageComplete.outputTokens && hasOutput;
          usageComplete.totalTokens = usageComplete.totalTokens && hasInput && hasOutput;
          usage.latestInputTokens = hasInput ? step.usage.inputTokens : undefined;
          usage.latestOutputTokens = hasOutput ? step.usage.outputTokens : undefined;
          // 兼容供应商 SDK 会把缺失缓存字段填成 0，必须检查原始统计。
          const details = step.usage.raw?.prompt_tokens_details;
          const cached = details && typeof details === "object" && "cached_tokens" in details ? details.cached_tokens : undefined;
          cacheUsageComplete = cacheUsageComplete && typeof cached === "number";
          if (cacheUsageComplete && typeof cached === "number") usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + cached;
          else delete usage.cachedInputTokens;
          pauseTool = step.toolCalls.find(call => PAUSE_TOOLS.has(call.toolName))?.toolName ?? "";
          const signature = stableJson({
            calls: step.toolCalls.map(call => ({ name: call.toolName, input: call.input })),
            results: step.toolResults.map(tool => ({ name: tool.toolName, output: tool.output }))
          });
          repeatedSteps = step.toolCalls.length && signature === previousStep ? repeatedSteps + 1 : 1;
          previousStep = signature;
          stalled = repeatedSteps >= MAX_REPEATED_STEPS;
        }
      });

      try {
        for await (const part of result.fullStream) {
          if (part.type === "finish") {
            finish = part;
            continue;
          }
          if (part.type === "finish-step") modelSteps++;
          if (part.type === "tool-result" || part.type === "tool-error") observed.add(part.toolCallId);
          if (part.type === "error") streamFailed = true;
          yield part;
        }
      } catch (error) {
        streamFailed = true;
        thrownMessage = errorText(error);
      } finally {
        // 停止流不等于取消数据库提交；先记录在途工具的真实结果，再结束本轮。
        await Promise.allSettled([...pending]);
        timing.finishRequest();
        publishMetrics();
      }

      for (const tool of settled.values()) {
        if (!observed.has(tool.id)) yield { type: "tool-settled", tool };
      }
      let responses: ModelMessage[];
      if (finish && !streamFailed && !options.signal?.aborted) {
        responses = await result.responseMessages;
      } else {
        responses = toolContext([...settled.values()]);
      }
      generated.push(...responses);
      yield { type: "model-context", messages: [...generated] };

      if (finish) {
        for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
          const tokens = finish.totalUsage[key];
          if (usageComplete[key] && typeof tokens === "number") usage[key] = (usage[key] ?? 0) + tokens;
          else delete usage[key];
        }
        yield { type: "run-usage", usage: { ...usage } };
      }
      if (options.signal?.aborted) break;
      if (streamFailed || !finish) {
        yield {
          type: "run-state",
          state: state("error", thrownMessage || "请求未正常结束，已保留实际工具执行结果", finish?.finishReason, finish?.rawFinishReason)
        };
        return;
      }
      if (pauseTool) {
        const waiting = pauseTool === "ask_user_choice";
        yield {
          type: "run-state",
          state: state(
            waiting ? "waiting-user" : "waiting-approval",
            waiting ? "等待你的选择，回答后继续" : "等待确认，确认后执行提案或计划",
            finish.finishReason,
            finish.rawFinishReason
          )
        };
        return;
      }
      if (stalled) {
        yield {
          type: "run-state",
          state: state(
            "stalled",
            "连续三轮调用相同工具且结果未变化，已暂停以避免空转；已完成的改动保留",
            finish.finishReason,
            finish.rawFinishReason
          )
        };
        return;
      }
      if (finish.finishReason === "stop") {
        yield { type: "run-state", state: state("finished", "本轮已正常结束", finish.finishReason, finish.rawFinishReason) };
        return;
      }
      if (finish.finishReason !== "tool-calls") {
        const message =
          finish.finishReason === "length"
            ? "模型输出达到长度上限，已保留执行结果，未自动重放写操作"
            : "模型中止了本轮回答：" + finish.finishReason;
        yield { type: "run-state", state: state("error", message, finish.finishReason, finish.rawFinishReason) };
        return;
      }
      continuations++;
    }
  } catch (error) {
    await Promise.allSettled([...pending]);
    if (!options.signal?.aborted) {
      yield { type: "run-state", state: state("error", errorText(error)) };
      return;
    }
  } finally {
    clearInterval(telemetryTimer);
    timing.finishRequest();
    publishMetrics();
  }
  yield {
    type: "run-state",
    state: state("cancelled", "已停止；已提交的改动保留，未启动后续操作", lastState?.finishReason, lastState?.rawFinishReason)
  };
}
