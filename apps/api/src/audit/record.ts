/**
 * 各模块统一的审计写入入口（R1-T16；DEC-019；AGENTS.md §10「审计」「事件」）。
 * 只负责审计行：在调用方传入的租户事务里写入，与业务同提交、同回滚；各模块的 outbox 写法不变，仍由各自的审计函数
 * 在同一事务里紧接着写。请求来源取自当前请求上下文（request-context.ts），系统任务的操作人传空，显示为“系统”。
 */
import {
  type AuditEventInput,
  type Db,
  insertAuditEvent,
  insertOperationLog,
  type OperationLogInput,
  type OperationLogItem,
  type Tx,
  withTenant,
} from '@italent/db';
import { AppError } from '../errors.js';
import { auditActor } from '../system-actor.js';
import { CommandFailureError } from './failures.js';
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

/** 导入行的归属（PR #75 第三轮 P1-2）：所属人员 / 组织 / 对象编号，供查询端逐行按当前范围裁剪。 */
export interface ImportRowAnchor {
  readonly objectId?: string | null;
  readonly employeeId?: string | null;
  readonly orgId?: string | null;
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
  anchors: readonly ImportRowAnchor[] = [],
): Promise<void> {
  const failures = receipts
    .map((receipt, rowIndex) => ({ rowIndex, ...receipt }))
    .filter((receipt) => receipt.status === 'conflict')
    // 错误报告统一为行号、错误码、原因（来源编码 / 编码随行保存，查询时按字段权限裁剪，DEC-197）
    .map(({ rowIndex, sourceCode, code, reason }) => ({
      rowIndex,
      errorCode: 'CONFLICT',
      reason: reason ?? null,
      sourceCode,
      code,
    }));
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.actorUserId,
    behavior: 'import',
    objectType,
    successCount: receipts.length - failures.length,
    failureCount: failures.length,
    errorReport: failures.length ? failures : null,
    items: receipts.map((receipt, rowIndex) => ({
      rowIndex,
      outcome: receipt.status === 'conflict' ? 'failed' : 'succeeded',
      ...anchors[rowIndex],
    })),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

interface FailedImport {
  readonly tenantId: string;
  readonly userId: string;
  readonly commandId: string | undefined;
  readonly objectType: string;
  /** 本次导入的总行数（整批回滚时全部计为失败）。 */
  readonly total: number;
  readonly scopeEmployeeId?: string;
  /** 逐行归属（取自原始请求，格式校验失败时也能识别）；整批失败时每行都计为失败。 */
  readonly anchors?: readonly ImportRowAnchor[];
}

/**
 * 原始请求里的导入行（PR #75 第三轮 P2-3）：格式校验之前就要识别导入任务，只取行数与可识别的归属编号，
 * 不保存其他输入值。请求体不是对象或没有行数组时返回空数组。
 */
export function rawImportRows(body: unknown, key = 'rows'): Record<string, unknown>[] {
  const rows = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return Array.isArray(rows)
    ? rows.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? (row as Record<string, unknown>) : {}))
    : [];
}

/** 原始值是 UUID 时才作为归属保存（其余输入值一律不落库）。 */
export function rawUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DEC-199：失败的导入任务同样持久保存任务级日志（条数、结果、错误报告，20 §3 / §5 第 3 条）。导入整批回滚，
 * 日志在独立事务里写入；错误报告只存行号、错误码与原因，不存字段值。结果未知时可能已生效，不记“失败”。
 */
export async function withFailedImportLog<T>(db: Db, task: FailedImport, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // 原始请求里没有导入行的不是可识别的导入任务（只留失败命令审计）
    if (task.total > 0 && !(error instanceof CommandFailureError && error.failure.outcome === 'unknown')) {
      await recordFailedImport(db, task, error).catch((logError: unknown) => {
        console.error(JSON.stringify({ type: 'audit.failed_import.unwritable', ...task, error: String(logError) }));
      });
    }
    throw error;
  }
}

async function recordFailedImport(db: Db, task: FailedImport, error: unknown): Promise<void> {
  const errorReport = failedImportReport(error);
  const items: OperationLogItem[] = Array.from({ length: task.total }, (_, rowIndex) => ({
    rowIndex,
    outcome: 'failed',
    ...task.anchors?.[rowIndex],
  }));
  await withTenant(db, task.tenantId, (tx) =>
    recordOperationLog(tx, {
      tenantId: task.tenantId,
      actorUserId: auditActor(task.userId),
      behavior: 'import',
      objectType: task.objectType,
      ...(task.scopeEmployeeId ? { objectId: task.scopeEmployeeId, scopeEmployeeId: task.scopeEmployeeId } : {}),
      successCount: 0,
      failureCount: task.total,
      errorReport,
      items,
      commandId: task.commandId ?? null,
      occurredAt: currentAuditRequest()?.clock() ?? new Date(),
    }),
  );
}

/**
 * 错误报告只存行号、错误码、原因（与出错字段的编码，查询时按字段权限裁剪），不存输入值：
 * 执行阶段的逐行错误取 details.errors；格式校验失败取 zod issues 的路径（rows / items 下标即行号）。
 */
function failedImportReport(error: unknown) {
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  const details = (error as { details?: unknown } | null)?.details;
  const rowErrors = (details as { errors?: unknown } | undefined)?.errors;
  if (Array.isArray(rowErrors) && rowErrors.length) {
    return (rowErrors as { row?: number; code?: string; details?: { reason?: string } }[]).map((row) => ({
      rowIndex: typeof row.row === 'number' ? row.row - 1 : null,
      errorCode: row.code ?? code,
      reason: row.details?.reason ?? null,
    }));
  }
  if (Array.isArray(details) && details.length && details.every(isIssue)) {
    return details.map((issue) => {
      const [first, second, ...rest] = issue.path;
      // 行数组本身被校验时路径以下标开头；整个请求体被校验时以 rows / items 开头
      const nested = (first === 'rows' || first === 'items') && typeof second === 'number';
      const rowIndex = typeof first === 'number' ? first : nested ? second : null;
      const tail = typeof first === 'number' ? issue.path.slice(1) : nested ? rest : issue.path;
      const path = tail.map(String).join('.');
      return { rowIndex, errorCode: code, reason: issue.code, ...(path ? { field: path } : {}) };
    });
  }
  return [{ rowIndex: null, errorCode: code, reason: details ? reasonOf(error) : null }];
}

function isIssue(value: unknown): value is { code: string; path: (string | number)[] } {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { code?: unknown }).code === 'string' &&
    Array.isArray((value as { path?: unknown }).path)
  );
}

function reasonOf(error: unknown): string | null {
  const reason = (error as { details?: { reason?: unknown } }).details?.reason;
  return typeof reason === 'string' ? reason : null;
}
