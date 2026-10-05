/**
 * 日志保留期的定时清理（docs/02_业务建模/20 §5 第 4 条；REQ-AUD-001 R5；AGENTS.md §10「定时任务」）。
 * - 只经平台路径触发（与定时生效同一形态）：遍历启用中的租户，逐租户切到租户路径，按该租户的 audit.retention
 *   调用迁移 0050 的 purge_expired_audit；租户接口上没有触发入口；
 * - 可重复执行：截止日由“业务日期 − 保留月数”确定，重跑只会删到同一截止日；同一命令 ID 重放首次结果（平台台账）；
 * - 留痕：本租户有日志被清理时，在对象操作日志记一条「日志清理」（操作人“系统”、来源动作“定时任务”），
 *   平台审计记整轮汇总；某个租户失败不影响其他租户，返回错误码，下一轮重试。
 */
import {
  findPlatformCommandResult,
  insertOperationLog,
  isUuid,
  type PlatformCommandMeta,
  runPlatformCommand,
  sql,
  type Db,
  withPlatform,
  withTenant,
  pgErrorCode,
} from '@italent/db';
import { AppError } from '../errors.js';
import { tenantRetention } from './query.js';

const RUN_OPERATION = 'audit.retention.run';
const TENANT_PAGE = 100;

export interface AuditRetentionRunInput {
  /** 只跑一个租户；缺省遍历全部启用中的租户。 */
  readonly tenantId?: string;
}

export interface AuditRetentionRun {
  readonly tenantId: string;
  readonly retainMonths: number;
  /** 租户时区的业务日期：早于该日 0 点的日志被清理。 */
  readonly cutoff: string;
  readonly purged: {
    readonly dataChanges: number;
    readonly operationLogs: number;
    readonly commandFailures: number;
    readonly total: number;
  };
}

export interface AuditRetentionResult {
  readonly ranAt: string;
  readonly runs: AuditRetentionRun[];
  readonly errors: { readonly tenantId: string; readonly code: string }[];
}

export async function runAuditRetention(
  db: Db,
  meta: PlatformCommandMeta,
  input: AuditRetentionRunInput = {},
  options: { readonly clock?: () => Date } = {},
): Promise<AuditRetentionResult> {
  if (input.tenantId !== undefined && !isUuid(input.tenantId)) {
    throw new AppError('VALIDATION_FAILED', '租户标识必须是 UUID');
  }
  const normalized = { tenantId: input.tenantId ?? null };
  const replay = await findPlatformCommandResult<AuditRetentionResult>(db, meta, RUN_OPERATION, normalized);
  if (replay) return replay.value;
  const now = (options.clock ?? (() => new Date()))();
  const runs: AuditRetentionRun[] = [];
  const errors: AuditRetentionResult['errors'] = [];
  for await (const tenantId of activeTenants(db, normalized.tenantId)) {
    try {
      runs.push(await purgeTenant(db, meta, tenantId, now));
    } catch (error) {
      errors.push({
        tenantId,
        code: error instanceof AppError ? error.code : (pgErrorCode(error) ?? 'INTERNAL_ERROR'),
      });
    }
  }
  const result: AuditRetentionResult = { ranAt: now.toISOString(), runs, errors };
  return runPlatformCommand(db, meta, RUN_OPERATION, normalized, async (ctx) => {
    await ctx.auditPlatform({
      action: RUN_OPERATION,
      objectType: 'audit-retention-run',
      objectId: meta.commandId,
      before: null,
      after: {
        ranAt: result.ranAt,
        tenants: runs.length,
        purged: runs.reduce((sum, run) => sum + run.purged.total, 0),
        errors: errors.length,
      },
    });
    return result;
  });
}

async function purgeTenant(db: Db, meta: PlatformCommandMeta, tenantId: string, now: Date): Promise<AuditRetentionRun> {
  return withTenant(db, tenantId, async (tx) => {
    const { retainMonths } = await tenantRetention(tx, tenantId);
    const result = await tx.execute(sql`SELECT cutoff::text AS cutoff, data_changes AS "dataChanges",
        operation_logs AS "operationLogs", command_failures AS "commandFailures"
      FROM purge_expired_audit(${tenantId}::uuid, ${retainMonths}, ${now.toISOString()}::timestamptz)`);
    const [row] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
      cutoff: string;
      dataChanges: number;
      operationLogs: number;
      commandFailures: number;
    }[];
    const counts = {
      dataChanges: row!.dataChanges,
      operationLogs: row!.operationLogs,
      commandFailures: row!.commandFailures,
    };
    const total = counts.dataChanges + counts.operationLogs + counts.commandFailures;
    if (total > 0) {
      await insertOperationLog(tx, {
        tenantId,
        actorUserId: null,
        behavior: 'purge',
        objectType: 'audit_retention',
        successCount: total,
        failureCount: 0,
        summary: `清理 ${row!.cutoff} 之前的日志 ${total} 条（保留 ${retainMonths} 个月）`,
        errorReport: null,
        attachment: null,
        commandId: meta.commandId,
        occurredAt: now,
      });
    }
    return { tenantId, retainMonths, cutoff: row!.cutoff, purged: { ...counts, total } };
  });
}

/** 只清理启用中的租户：停用租户的数据冻结，恢复隔离中的租户（DEC-061）不做任何写入。 */
async function* activeTenants(db: Db, tenantId: string | null): AsyncGenerator<string> {
  let after: string | null = null;
  for (;;) {
    const page = await withPlatform(db, async (tx) => {
      const result = await tx.execute(sql`SELECT id::text AS id FROM tenants WHERE status='active'
        AND (${tenantId}::uuid IS NULL OR id=${tenantId}::uuid)
        AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${TENANT_PAGE}`);
      return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string }[]).map(
        (row) => row.id,
      );
    });
    yield* page;
    if (page.length < TENANT_PAGE) return;
    after = page.at(-1)!;
  }
}

export interface AuditRetentionScheduler {
  stop(): Promise<void>;
}

/** 进程内调度：默认每天一次；同一时间槽命令 ID 相同，多实例同槽只登记一个结果。 */
export function startAuditRetentionScheduler(
  db: Db,
  options: {
    readonly intervalMs?: number;
    readonly clock?: () => Date;
    readonly onError?: (error: unknown) => void;
  } = {},
): AuditRetentionScheduler {
  const intervalMs = options.intervalMs ?? 24 * 60 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
    throw new RangeError('日志清理间隔须为不小于 60000 的毫秒数');
  }
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? ((error: unknown) => console.error('日志保留期清理失败', error));
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    const slot = Math.floor(clock().getTime() / intervalMs) * intervalMs;
    running = runAuditRetention(db, { actorUserId: null, commandId: `audit-retention:${slot}` }, {}, { clock })
      .then((result) => {
        if (result.errors.length) onError(new Error(`日志清理部分租户失败：${JSON.stringify(result.errors)}`));
      })
      .catch(onError)
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
