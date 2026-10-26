import type { AiChangeOperation, AiRollbackResult } from "../types";

/** 宿主执行的逆操作入口（由 AiAssistantHost.revertExecutor 提供） */
export interface AiRevertExecutor {
  /** 执行一条逆操作，返回结果文本；语义与 proposalExecutor.execute 一致 */
  execute(operation: AiChangeOperation): Promise<string>;
}

/**
 * 逐条回滚一组已执行的操作（提案执行后或编辑模式直接执行后）。
 *
 * 只处理 status 为 completed 且尚未回滚的操作：失败项本就没落盘，回滚它会报出无意义的错误；
 * 已回滚项重复回滚会把改动再翻一次。任一条失败不阻断其余——各操作相互独立，
 * 用户期望尽量还原；无法回滚的（如 delete-element 未捕获逆操作）计入 skipped。
 *
 * @param operations 本轮要回滚的操作
 * @param executor 宿主注入的逆操作执行能力；缺省（宿主不支持）时全部计入 skipped
 */
export async function rollbackOperations(operations: AiChangeOperation[], executor: AiRevertExecutor | undefined): Promise<AiRollbackResult> {
  const done = operations.filter(operation => operation.status === "completed" && !operation.reverted);
  const reverted: string[] = [];
  const skipped: string[] = [];

  for (const operation of done) {
    const label = operation.summary || operation.type;
    if (!operation.revert) {
      skipped.push(`${label}：${describeNoRevertReason(operation.type)}`);
      continue;
    }
    if (!executor) {
      skipped.push(`${label}：当前宿主不支持回滚`);
      continue;
    }

    try {
      const text = await executor.execute(operation.revert);
      operation.reverted = true;
      // 保留原执行结果，回滚说明追加在后面（两段信息都要能看到）
      operation.result = operation.result ? `${operation.result}\n已回滚：${text}` : `已回滚：${text}`;
      reverted.push(label);
    } catch (error) {
      skipped.push(`${label}：${describeRevertError(error)}`);
    }
  }

  return { reverted: reverted.length, skipped };
}

/** 无法回滚时的用户可读原因 */
function describeNoRevertReason(type: AiChangeOperation["type"]): string {
  if (type === "delete-element") return "删除已落盘且未保留副本，无法自动恢复";
  return "该操作未记录逆操作，无法自动回滚";
}

/** 回滚失败的原因文本（错误对象可能是字符串） */
function describeRevertError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "未知错误";
}
