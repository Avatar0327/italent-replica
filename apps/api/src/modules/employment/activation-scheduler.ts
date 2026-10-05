import { completionCandidates, remindCompletion } from '../transfer/completion.js';
/**
 * 定时生效调度（R1-T08，`08` §12 / §16；REQ-TRF-004）。按各租户时区判定业务日（DEC-056，事件时间存 UTC），
 * 把到期的「审批通过」申请经 activate 端口落地。原站 W-013 观察到生效日 01:15 由系统执行；这里每个间隔扫描一次，
 * 跨过租户本地午夜后的第一次运行即落地，保证生效日当天业务开始前完成。
 * - 只经平台路径触发：遍历租户读平台表，落地时逐员工切到租户路径（withTenant + RLS），租户接口上没有触发入口；
 * - 多实例：每名员工一个事务，先 FOR UPDATE SKIP LOCKED 锁员工行，被其他实例持有就跳过，锁内重读状态，不重复生效；
 * - 有界：每个租户每次最多处理 limit 名员工，返回续跑游标；运维补跑同样经此入口（平台命令 ID 幂等、平台审计留痕）。
 */
import {
  findPlatformCommandResult,
  isUuid,
  runPlatformCommand,
  sql,
  type Db,
  type PlatformCommandMeta,
  type Tx,
  withPlatform,
  withTenant,
} from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { activateDueBusinesses } from './activation-service.js';
import { EmploymentError } from './errors.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const RUN_OPERATION = 'employment.activation.run';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const TENANT_PAGE = 100;

export interface EmploymentActivationRunInput {
  /** 只跑一个租户；缺省遍历全部启用中的租户。 */
  readonly tenantId?: string;
  /** 上一次运行返回的续跑游标（须同时指定租户）。 */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface EmploymentActivationRun {
  readonly tenantId: string;
  readonly businessDate: string;
  readonly ranAt: string;
  readonly activated: string[];
  readonly failed: string[];
  readonly suspended: string[];
  /** 被其他实例或 HR 重试持有、本次跳过的员工数。 */
  readonly skippedLocked: number;
  /** 存储 / 依赖不可用等非业务错误：不记失败，下次运行重试。 */
  readonly errors: { readonly employeeId: string; readonly code: string }[];
  readonly nextCursor: string | null;
}

export interface EmploymentActivationRunResult {
  readonly runs: EmploymentActivationRun[];
}

function normalize(input: EmploymentActivationRunInput) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new AppError('VALIDATION_FAILED', `单次处理量须为 1～${MAX_LIMIT}`);
  if (input.tenantId !== undefined && !isUuid(input.tenantId))
    throw new AppError('VALIDATION_FAILED', '租户标识必须是 UUID');
  if (input.cursor !== undefined && (!input.tenantId || !isUuid(input.cursor)))
    throw new AppError('VALIDATION_FAILED', '续跑游标须为员工 UUID，且须指定租户');
  return { tenantId: input.tenantId ?? null, cursor: input.cursor ?? null, limit };
}

/** 运维 / 调度入口。clock 只由进程注入（测试替身），不接受调用方传入“现在”，避免提前落地未来业务。 */
export async function runEmploymentActivations(
  db: Db,
  meta: PlatformCommandMeta,
  input: EmploymentActivationRunInput = {},
  options: { readonly clock?: () => Date } = {},
): Promise<EmploymentActivationRunResult> {
  const normalized = normalize(input);
  const replay = await findPlatformCommandResult<EmploymentActivationRunResult>(db, meta, RUN_OPERATION, normalized);
  if (replay) return replay.value;
  const now = (options.clock ?? (() => new Date()))();
  const runs: EmploymentActivationRun[] = [];
  for await (const tenant of activeTenants(db, normalized.tenantId)) {
    runs.push(await sweepTenant(db, meta, tenant, now, normalized));
  }
  const result: EmploymentActivationRunResult = { runs };
  return runPlatformCommand(db, meta, RUN_OPERATION, normalized, async (ctx) => {
    await ctx.auditPlatform({
      action: RUN_OPERATION,
      objectType: 'employment-activation-run',
      objectId: meta.commandId,
      before: null,
      after: {
        ranAt: now.toISOString(),
        tenants: runs.length,
        activated: runs.reduce((sum, run) => sum + run.activated.length, 0),
        failed: runs.reduce((sum, run) => sum + run.failed.length, 0),
        suspended: runs.reduce((sum, run) => sum + run.suspended.length, 0),
        errors: runs.reduce((sum, run) => sum + run.errors.length, 0),
      },
    });
    return result;
  });
}

interface TenantRow {
  readonly id: string;
  readonly timezone: string;
}

/** 只运行启用中的租户：停用、恢复隔离中的租户（DEC-061）不落地任何业务。 */
async function* activeTenants(db: Db, tenantId: string | null): AsyncGenerator<TenantRow> {
  let after: string | null = null;
  for (;;) {
    const page: TenantRow[] = await withPlatform(db, async (tx) =>
      rowsOf<TenantRow>(
        await tx.execute(sql`SELECT id::text, timezone FROM tenants WHERE status='active'
          AND (${tenantId}::uuid IS NULL OR id=${tenantId}::uuid)
          AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${TENANT_PAGE}`),
      ),
    );
    yield* page;
    if (page.length < TENANT_PAGE) return;
    after = page.at(-1)!.id;
  }
}

async function sweepTenant(
  db: Db,
  meta: PlatformCommandMeta,
  tenant: TenantRow,
  now: Date,
  input: ReturnType<typeof normalize>,
): Promise<EmploymentActivationRun> {
  const businessDate = tenantLocalDate(now, tenant.timezone);
  const candidates = await withTenant(db, tenant.id, (tx) =>
    dueEmployees(tx, tenant.id, businessDate, input.cursor, input.limit + 1, now, tenant.timezone),
  );
  const batch = candidates.slice(0, input.limit);
  const run = { activated: [] as string[], failed: [] as string[], suspended: [] as string[], skippedLocked: 0 };
  const errors: EmploymentActivationRun['errors'] = [];
  const ctx: EmploymentContext = {
    tenantId: tenant.id,
    userId: SYSTEM_USER_ID,
    timezone: tenant.timezone,
    now,
    commandId: meta.commandId,
    expectedRevision: 0,
  };
  for (const employeeId of batch) {
    try {
      const outcome = await withTenant(db, tenant.id, async (tx) => {
        if (!(await lockEmployeeOrSkip(tx, tenant.id, employeeId))) return null;
        const outcome = await activateDueBusinesses(tx, ctx, employeeId, 'scheduler');
        await remindCompletion(tx, ctx, employeeId);
        return outcome;
      });
      if (!outcome) {
        run.skippedLocked += 1;
        continue;
      }
      run.activated.push(...outcome.activated);
      run.failed.push(...outcome.failed);
      run.suspended.push(...outcome.suspended);
    } catch (error) {
      // 整名员工回滚、不记失败；仍在候选里，下一次运行重试（DEC-052 可重试，结果未知不伪造失败记录）。
      const code = error instanceof AppError || error instanceof EmploymentError ? error.code : 'INTERNAL_ERROR';
      errors.push({ employeeId, code });
    }
  }
  const nextCursor = candidates.length > input.limit ? batch.at(-1)! : null;
  return { tenantId: tenant.id, businessDate, ranAt: now.toISOString(), ...run, errors, nextCursor };
}

async function lockEmployeeOrSkip(tx: Tx, tenantId: string, employeeId: string): Promise<boolean> {
  const locked = rowsOf(
    await tx.execute(sql`SELECT id FROM employment_employees
      WHERE tenant_id=${tenantId} AND id=${employeeId}::uuid FOR UPDATE SKIP LOCKED`),
  );
  return locked.length > 0;
}

/**
 * 有事可做的员工：有到期的审批通过申请，且它不是“失败待 HR 重试”，也不是“挂起且所等前序仍失败未修正”。
 * 只从审批通过的状态事件出发（部分索引），再确认它仍是该业务的最新状态。
 */
async function dueEmployees(
  tx: Tx,
  tenantId: string,
  businessDate: string,
  cursor: string | null,
  limit: number,
  now: Date,
  timezone: string,
): Promise<string[]> {
  const rows = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT DISTINCT s.employee_id::text AS "employeeId" FROM employment_state_events s
    JOIN LATERAL (SELECT mode, effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=s.tenant_id AND p.business_id=s.business_id ORDER BY p.version_no DESC LIMIT 1) p ON true
    LEFT JOIN LATERAL (SELECT outcome, blocked_by_business_id FROM employment_activation_attempts a
      WHERE a.tenant_id=s.tenant_id AND a.business_id=s.business_id ORDER BY a.attempt_no DESC LIMIT 1) a ON true
    WHERE s.tenant_id=${tenantId} AND s.state='approved'
      AND NOT EXISTS (SELECT 1 FROM employment_state_events n
        WHERE n.tenant_id=s.tenant_id AND n.business_id=s.business_id AND n.event_no>s.event_no)
      AND p.mode='application' AND p.effective_date<=${businessDate}::date
      AND (${cursor}::uuid IS NULL OR s.employee_id>${cursor}::uuid)
      AND (a.outcome IS NULL OR (a.outcome='suspended' AND NOT (
        (SELECT x.state FROM employment_state_events x WHERE x.tenant_id=s.tenant_id
          AND x.business_id=a.blocked_by_business_id ORDER BY x.event_no DESC LIMIT 1) = 'approved'
        AND (SELECT y.outcome FROM employment_activation_attempts y WHERE y.tenant_id=s.tenant_id
          AND y.business_id=a.blocked_by_business_id ORDER BY y.attempt_no DESC LIMIT 1) = 'failed')))
    UNION SELECT "employeeId"::text FROM (${completionCandidates({
      tenantId,
      timezone,
      now,
      userId: SYSTEM_USER_ID,
      commandId: '',
      expectedRevision: 0,
    })}) c
      WHERE (${cursor}::uuid IS NULL OR c."employeeId">${cursor}::uuid)
    ORDER BY 1 LIMIT ${limit}
  `),
  );
  return rows.map((row) => row.employeeId);
}

export interface EmploymentActivationScheduler {
  stop(): Promise<void>;
}

/**
 * 进程内调度：每个间隔对全部启用租户运行一次。同一时间槽的命令 ID 相同，多实例同槽只有一个结果登记，
 * 其余重放或在员工锁上跳过；同一进程内上一轮未结束时不叠加新一轮。
 */
export function startEmploymentActivationScheduler(
  db: Db,
  options: {
    readonly intervalMs?: number;
    readonly clock?: () => Date;
    readonly onError?: (error: unknown) => void;
  } = {},
): EmploymentActivationScheduler {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000)
    throw new RangeError('定时生效间隔须为不小于 1000 的毫秒数');
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? ((error: unknown) => console.error('定时生效运行失败', error));
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    const slot = Math.floor(clock().getTime() / intervalMs) * intervalMs;
    running = runSlot(db, slot, clock, onError)
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

async function runSlot(db: Db, slot: number, clock: () => Date, onError: (error: unknown) => void): Promise<void> {
  const report = (run: EmploymentActivationRun | undefined) => {
    // 非业务错误不记失败、下一轮重试；这里只上报，便于运维发现持续出错的员工。
    if (run?.errors.length) onError(new Error(`定时生效部分员工未处理：${JSON.stringify(run)}`));
  };
  const first = await runEmploymentActivations(db, { actorUserId: null, commandId: `emp-act:${slot}` }, {}, { clock });
  for (const run of first.runs) {
    report(run);
    let cursor = run.nextCursor;
    while (cursor) {
      const meta = { actorUserId: null, commandId: `emp-act:${slot}:${cursor}` };
      const next = await runEmploymentActivations(db, meta, { tenantId: run.tenantId, cursor }, { clock });
      report(next.runs[0]);
      cursor = next.runs[0]?.nextCursor ?? null;
    }
  }
}
