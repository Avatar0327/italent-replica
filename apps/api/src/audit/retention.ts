/**
 * 日志保留期的定时清理（docs/02_业务建模/20 §5 第 4 条；REQ-AUD-001 R5；AGENTS.md §10「定时任务」）。
 * - 只经平台路径触发（与定时生效同一形态）：遍历启用中的租户，逐租户分批调用迁移 0051 的 purge_expired_audit
 *   （只授予平台角色；保留月数由函数读取租户配置，调用方无法缩短，PR #75 第二轮 P2-2）；租户接口上没有触发入口；
 * - 可重复执行：截止日由“业务日期 − 保留月数”确定，重跑只会删到同一截止日；同一命令 ID 重放首次结果（平台台账）；
 * - 留痕：每批有日志被清理时，函数在同一事务里写一条「日志清理」对象操作日志（操作人“系统”、来源动作“定时任务”），
 *   平台审计记整轮汇总；某个租户失败不影响其他租户，返回错误码，下一轮重试；
 * - DEC-198：到期整条清理，首个新增事件不例外；数据范围「创建人」所需的最小元数据另存，不随之删除。
 */
import {
  findPlatformCommandResult,
  isUuid,
  type PlatformCommandMeta,
  runPlatformCommand,
  sql,
  type Db,
  withPlatform,
  pgErrorCode,
} from '@italent/db';
import { AppError } from '../errors.js';

const RUN_OPERATION = 'audit.retention.run';
const BATCH_SIZE = 5000;
const MAX_BATCHES = 200;
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

/**
 * 一个租户按批清理到截止日：每批一个平台路径事务（迁移 0051 的 purge_expired_audit 只授予平台角色，保留月数在
 * 函数内读取租户配置，本批的「日志清理」操作日志在同一事务写入），控制单事务锁持有时长；批数设上限防失控。
 */
async function purgeTenant(db: Db, meta: PlatformCommandMeta, tenantId: string, now: Date): Promise<AuditRetentionRun> {
  const purged = { dataChanges: 0, operationLogs: 0, commandFailures: 0 };
  let batch: PurgeBatch | undefined;
  for (let round = 0; round < MAX_BATCHES && (!batch || batch.remaining); round += 1) {
    batch = await withPlatform(db, async (tx) => {
      const result = await tx.execute(sql`SELECT cutoff::text AS cutoff, retain_months AS "retainMonths",
          data_changes AS "dataChanges", operation_logs AS "operationLogs", command_failures AS "commandFailures",
          remaining
        FROM purge_expired_audit(${tenantId}::uuid, ${now.toISOString()}::timestamptz, ${BATCH_SIZE},
          ${meta.commandId})`);
      return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as PurgeBatch[])[0]!;
    });
    purged.dataChanges += batch.dataChanges;
    purged.operationLogs += batch.operationLogs;
    purged.commandFailures += batch.commandFailures;
  }
  const total = purged.dataChanges + purged.operationLogs + purged.commandFailures;
  return { tenantId, retainMonths: batch!.retainMonths, cutoff: batch!.cutoff, purged: { ...purged, total } };
}

interface PurgeBatch {
  readonly cutoff: string;
  readonly retainMonths: number;
  readonly dataChanges: number;
  readonly operationLogs: number;
  readonly commandFailures: number;
  readonly remaining: boolean;
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
