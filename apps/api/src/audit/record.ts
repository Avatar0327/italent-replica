/**
 * 各模块统一的审计写入入口（R1-T16；DEC-019；AGENTS.md §10「审计」「事件」）。
 * 只负责审计行：在调用方传入的租户事务里写入，与业务同提交、同回滚；各模块的 outbox 写法不变，仍由各自的审计函数
 * 在同一事务里紧接着写。请求来源取自当前请求上下文（request-context.ts），系统任务的操作人传空，显示为“系统”。
 */
import {
  type AuditEventInput,
  insertAuditEvent,
  insertOperationLog,
  type OperationLogInput,
  type Tx,
} from '@italent/db';
import { currentAuditRequest } from './request-context.js';

export type RecordAuditInput = Omit<AuditEventInput, 'source'>;

export async function recordAudit(tx: Tx, entry: RecordAuditInput): Promise<void> {
  const source = currentAuditRequest()?.source;
  await insertAuditEvent(tx, { ...entry, ...(source ? { source } : {}) });
}

export type RecordOperationInput = Omit<OperationLogInput, 'source'>;

/** 对象操作日志（批量编辑 / 导入 / 导出 / 下载）：写操作与业务同事务；纯读取（下载错误报告）单独一个事务。 */
export async function recordOperationLog(tx: Tx, entry: RecordOperationInput): Promise<void> {
  const source = currentAuditRequest()?.source;
  await insertOperationLog(tx, { ...entry, ...(source ? { source } : {}) });
}

export interface ImportReceipt {
  readonly status: string;
  readonly sourceCode?: string;
  readonly code?: string;
  readonly reason?: string | null;
}

/**
 * 导入的任务级日志（20 §5 第 3 条）：逐行回执里 status = conflict 的行计为失败，失败行的行号、来源编码与原因
 * 作为错误报告随日志保存（不含其他字段值）；与导入写入同事务。
 */
export async function recordImportLog(
  tx: Tx,
  ctx: {
    readonly tenantId: string;
    readonly actorUserId: string | null;
    readonly commandId: string;
    readonly now: Date;
  },
  objectType: string,
  receipts: readonly ImportReceipt[],
): Promise<void> {
  const failures = receipts
    .map((receipt, rowIndex) => ({ rowIndex, ...receipt }))
    .filter((receipt) => receipt.status === 'conflict')
    .map(({ rowIndex, sourceCode, code, reason }) => ({ rowIndex, sourceCode, code, reason: reason ?? null }));
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId,
    behavior: 'import',
    objectType,
    successCount: receipts.length - failures.length,
    failureCount: failures.length,
    errorReport: failures.length ? failures : null,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}
