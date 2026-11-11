/**
 * F-493 历史离职人员导入执行器（设计 §4.2）：提交只落批次与明细，这里在提交后唤醒，逐行执行。
 * 一行一个租户事务（成功即提交、失败整行回滚）：业务拒绝记为该行 failed；系统故障（非业务错误、5xx、锁超时、
 * 唯一键撞车）中止本轮，批次留在 running 并写 last_error，租约到期后由下一次唤醒接管（定时补偿在 S3b）。
 * 本文件不做：定时器、尝试次数上限、执行期权限复核、清理、通知（S3b / S3c / S3d）。
 */
import { exitImportRows, isIsolatedTestDb, sql, withTenant, type Db, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { asUuid, advisoryLock } from '../../advisory-lock.js';
import { recordOperationLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { activeTenants, type TenantRow } from './active-tenants.js';
import {
  profileFormatErrors,
  profilePatch,
  rowErrorOf,
  writeImportRow,
  type ImportBatchRef,
} from './exit-import-row.js';
import { findDepartment, resolveImportRow, type ResolvedImportRow } from './exit-import-resolve.js';
import { emailKey, type ImportRowInput, type RowError } from './exit-import-shape.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';
import { and, asc, eq } from 'drizzle-orm';

const PAGE = 50;
const LEASE = sql`interval '5 minutes'`;
const RETAIN = sql`interval '15 days'`;

export interface ExitImportTestHooks {
  /** 领到批次后、处理第一行前；rejected 即中止该租户本轮。 */
  readonly beforeBatch?: () => Promise<void>;
  /** 每行事务开始前。 */
  readonly beforeRow?: (rowNo: number) => Promise<void>;
  /** 返回 Error 时本行按系统故障处理（回滚并中止本轮）。 */
  readonly failRow?: (rowNo: number) => Error | undefined;
}

interface State {
  hooks: ExitImportTestHooks;
  clock: () => Date;
  loops: Map<string, Promise<void>>;
  again: Set<string>;
}
const states = new WeakMap<Db, State>();
const stateOf = (db: Db): State => {
  let state = states.get(db);
  if (!state) states.set(db, (state = { hooks: {}, clock: () => new Date(), loops: new Map(), again: new Set() }));
  return state;
};

/** 测试挂钩只允许装在隔离测试库上；`{}` 清除。 */
export function installExitImportTestHooks(db: Db, hooks: ExitImportTestHooks): void {
  if (!isIsolatedTestDb(db)) throw new Error('导入执行器的测试挂钩只能装在隔离测试库上');
  stateOf(db).hooks = hooks;
}

/**
 * 提交后唤醒：setImmediate 起一个单飞循环（同租户同一时刻只有一个），不阻塞调用方。
 * clock 随唤醒带入：请求用的时钟就是执行器判“今天”的时钟。
 */
export function wakeExitImports(db: Db, tenantId: string, clock?: () => Date): void {
  const state = stateOf(db);
  if (clock) state.clock = clock;
  setImmediate(() => void startLoop(db, tenantId));
}

function startLoop(db: Db, tenantId: string): Promise<void> {
  const state = stateOf(db);
  const running = state.loops.get(tenantId);
  if (running) {
    state.again.add(tenantId); // 运行中又来了新批次：当前循环收尾后再扫一遍
    return running;
  }
  const loop = (async () => {
    try {
      do {
        state.again.delete(tenantId);
        await drainExitImports(db, tenantId);
      } while (state.again.has(tenantId));
    } catch (error) {
      console.error(
        JSON.stringify({
          type: 'employment.exit-import.wake-failed',
          tenantId,
          category: error instanceof AppError ? error.code : 'SYSTEM_ERROR',
        }),
      );
    } finally {
      state.loops.delete(tenantId);
    }
  })();
  state.loops.set(tenantId, loop);
  return loop;
}

/** 测试用：等所有唤醒出来的循环（含运行中又被追加的一轮）都结束。 */
export async function exitImportIdle(db: Db): Promise<void> {
  const state = stateOf(db);
  // setImmediate 还没触发时 loops 为空：让出一轮事件循环再看
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (state.loops.size) await Promise.all([...state.loops.values()]);
}

interface ClaimedBatch extends ImportBatchRef {
  readonly attempts: number;
}

/** 处理一个租户里所有可领的批次（queued，或租约已过期的 running）；返回处理的批次数。 */
export async function drainExitImports(db: Db, tenantId: string): Promise<{ batches: number }> {
  const state = stateOf(db);
  let batches = 0;
  for await (const tenant of activeTenants(db, tenantId)) {
    for (;;) {
      const batch = await claim(db, tenant.id);
      if (!batch) break;
      batches += 1;
      await runBatch(db, state, tenant, batch);
    }
  }
  return { batches };
}

async function claim(db: Db, tenantId: string): Promise<ClaimedBatch | null> {
  const [row] = await withTenant(db, tenantId, async (tx) =>
    rowsOf<{ id: string; submitted_by: string; attempts: number }>(
      await tx.execute(sql`UPDATE exit_import_batches SET status='running', lease_until=now() + ${LEASE},
        attempts=attempts+1, started_at=COALESCE(started_at, now()), revision=revision+1
        WHERE tenant_id=${tenantId} AND id=(SELECT id FROM exit_import_batches WHERE tenant_id=${tenantId}
          AND (status='queued' OR (status='running' AND lease_until < now()))
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id::text, submitted_by::text, attempts`),
    ),
  );
  return row ? { id: row.id, submittedBy: row.submitted_by, attempts: row.attempts } : null;
}

async function runBatch(db: Db, state: State, tenant: TenantRow, batch: ClaimedBatch): Promise<void> {
  try {
    await state.hooks.beforeBatch?.();
    for (;;) {
      const pending = await pendingRows(db, tenant.id, batch.id);
      if (!pending.length) break;
      for (const record of pending) await processRow(db, state, tenant, batch, record);
    }
    await finish(db, tenant, batch, state.clock());
  } catch (error) {
    await recordFailure(db, tenant.id, batch.id, error);
    throw error;
  }
}

async function pendingRows(db: Db, tenantId: string, batchId: string): Promise<ImportRowInput[]> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(exitImportRows)
      .where(
        and(
          eq(exitImportRows.tenantId, tenantId),
          eq(exitImportRows.batchId, batchId),
          eq(exitImportRows.status, 'pending'),
        ),
      )
      .orderBy(asc(exitImportRows.rowNo))
      .limit(PAGE);
    return rows as unknown as ImportRowInput[];
  });
}

/** 系统故障：批次留在 running，写下原因，租约缩到 1 分钟让下一次唤醒尽快接管；写不进去也不掩盖原错误。 */
async function recordFailure(db: Db, tenantId: string, batchId: string, error: unknown): Promise<void> {
  const reason = error instanceof AppError ? error.code : error instanceof Error ? error.name : 'SYSTEM_ERROR';
  try {
    await withTenant(db, tenantId, (tx) =>
      tx.execute(sql`UPDATE exit_import_batches SET last_error=${reason}, lease_until=now() + interval '1 minute'
        WHERE tenant_id=${tenantId} AND id=${batchId}::uuid AND status='running'`),
    );
  } catch {
    // 租约本来就会过期，这里只是让接管更快
  }
}

// ---- 一行 ---------------------------------------------------------------------------------------------

type Outcome = {
  readonly errors: readonly RowError[];
  readonly written?: { employeeId: string; exitBusinessId: string };
};

async function processRow(
  db: Db,
  state: State,
  tenant: TenantRow,
  batch: ClaimedBatch,
  row: ImportRowInput,
): Promise<void> {
  await state.hooks.beforeRow?.(row.rowNo);
  const now = state.clock();
  try {
    await withTenant(db, tenant.id, async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      const failure = state.hooks.failRow?.(row.rowNo);
      if (failure) throw failure;
      await runRow(tx, tenant, batch, row, now);
    });
  } catch (error) {
    // 业务拒绝（4xx）：整行已回滚，另开事务登记失败；其余视为系统故障交给调用方中止本轮
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    await markFailed(db, tenant.id, batch.id, row.rowNo, [rowErrorOf(error)]);
  }
}

async function runRow(tx: Tx, tenant: TenantRow, batch: ClaimedBatch, row: ImportRowInput, now: Date): Promise<void> {
  const [current] = rowsOf<{ status: string }>(
    await tx.execute(sql`SELECT status FROM exit_import_rows WHERE tenant_id=${tenant.id}
      AND batch_id=${batch.id}::uuid AND row_no=${row.rowNo} FOR UPDATE`),
  );
  if (current?.status !== 'pending') return; // 别的执行者已处理（租约被接管后的旧执行者）
  // 同邮箱的并发导入串行：先取邮箱锁，再判 a 类（锁序：邮箱 → 组织设置 → 编制，设计 §4.2）
  await advisoryLock(tx, asUuid(tenant.id), `:exit-import-email:${emailKey(row.email!)}`);
  const verdict = await judge(tx, tenant, row, now);
  if (verdict.errors.length) return settle(tx, tenant.id, batch.id, row.rowNo, 'failed', verdict);
  await lockOrganizationSettings(tx, tenant.id);
  const ctx: EmploymentContext = {
    tenantId: tenant.id,
    userId: batch.submittedBy,
    timezone: tenant.timezone,
    now,
    commandId: `exit-import:${batch.id}:${row.rowNo}`,
    expectedRevision: 0,
  };
  const resolved = verdict.resolved!;
  const done = await writeImportRow(tx, ctx, batch, row, resolved);
  // 成功行与本行写入同事务续租（设计 §6.2 第 5 步）：长批次持续处理期间不会被另一执行者当作过期接管
  await tx.execute(sql`UPDATE exit_import_batches SET lease_until=now() + ${LEASE}
    WHERE tenant_id=${tenant.id} AND id=${batch.id}::uuid AND status='running'`);
  const errors: RowError[] = done.loginAssigned ? [] : [{ column: 'C', reason: 'LOGIN_TAKEN' }];
  await settle(tx, tenant.id, batch.id, row.rowNo, errors.length ? 'created_with_error' : 'succeeded', {
    errors,
    written: { employeeId: done.employeeId, exitBusinessId: done.exitBusinessId },
  });
}

/** 判定顺序（设计 §3.3）：a 类（邮箱已是员工）→ 引用与字典 → 区间 → 档案格式；前一步有错不进下一步。 */
async function judge(
  tx: Tx,
  tenant: TenantRow,
  row: ImportRowInput,
  now: Date,
): Promise<{ errors: readonly RowError[]; resolved?: ResolvedImportRow }> {
  if (await emailInEmployee(tx, tenant.id, emailKey(row.email!)))
    return { errors: [{ column: 'C', reason: 'EMAIL_IN_EMPLOYEE' }] };
  const verdict = await resolveImportRow(tx, tenant.id, row, tenantLocalDate(now, tenant.timezone));
  if (verdict.errors.length) return { errors: verdict.errors };
  const formats = profileFormatErrors(profilePatch(row));
  if (formats.length) return { errors: formats };
  return verdict;
}

/** 只认员工档案“电子邮件”的最新版本（备用邮箱、工作邮箱不算，DEC-834①）。 */
async function emailInEmployee(tx: Tx, tenantId: string, email: string): Promise<boolean> {
  const found = rowsOf(
    await tx.execute(sql`SELECT 1 FROM personnel_employee_versions v WHERE v.tenant_id=${tenantId}
      AND lower(btrim(v.email))=${email}
      AND v.revision=(SELECT max(o.revision) FROM personnel_employee_versions o
        WHERE o.tenant_id=v.tenant_id AND o.employee_id=v.employee_id) LIMIT 1`),
  );
  return found.length > 0;
}

async function settle(
  tx: Tx,
  tenantId: string,
  batchId: string,
  rowNo: number,
  status: 'succeeded' | 'created_with_error' | 'failed',
  outcome: Outcome,
): Promise<void> {
  await tx.execute(sql`UPDATE exit_import_rows SET status=${status}, errors=${JSON.stringify(outcome.errors)}::jsonb,
    employee_id=${outcome.written?.employeeId ?? null}::uuid,
    exit_business_id=${outcome.written?.exitBusinessId ?? null}::uuid, updated_at=now()
    WHERE tenant_id=${tenantId} AND batch_id=${batchId}::uuid AND row_no=${rowNo}`);
}

async function markFailed(db: Db, tenantId: string, batchId: string, rowNo: number, errors: readonly RowError[]) {
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`UPDATE exit_import_rows SET status='failed', errors=${JSON.stringify(errors)}::jsonb,
      updated_at=now() WHERE tenant_id=${tenantId} AND batch_id=${batchId}::uuid AND row_no=${rowNo}
      AND status='pending'`),
  );
}

// ---- 收尾 ---------------------------------------------------------------------------------------------

/** 汇总计数、置 completed、写一条导入操作日志，同一事务；租约已被别的执行者接管（status 不再是 running）则什么都不写。 */
async function finish(db: Db, tenant: TenantRow, batch: ClaimedBatch, now: Date): Promise<void> {
  await withTenant(db, tenant.id, async (tx) => {
    const rows = rowsOf<{
      row_no: number;
      status: string;
      employee_id: string | null;
      exit_business_id: string | null;
      department_code: string | null;
      errors: readonly RowError[];
    }>(
      await tx.execute(sql`SELECT row_no, status, employee_id::text, exit_business_id::text, department_code, errors
        FROM exit_import_rows WHERE tenant_id=${tenant.id} AND batch_id=${batch.id}::uuid ORDER BY row_no`),
    );
    const created = rows.filter((r) => r.status === 'succeeded' || r.status === 'created_with_error').length;
    const errorRows = rows.filter((r) => r.status === 'failed' || r.status === 'created_with_error').length;
    const errorCount = rows.reduce((sum, r) => sum + r.errors.length, 0);
    const [closed] = rowsOf<{ id: string }>(
      await tx.execute(sql`UPDATE exit_import_batches SET status='completed', created_count=${created},
        error_row_count=${errorRows}, error_count=${errorCount}, finished_at=now(), expires_at=now() + ${RETAIN},
        lease_until=NULL, last_error=NULL, revision=revision+1
        WHERE tenant_id=${tenant.id} AND id=${batch.id}::uuid AND status='running' RETURNING id`),
    );
    if (!closed) return;
    const orgOf = departmentResolver(tx, tenant.id);
    // rowIndex = 按行号升序的 0 起序号；items 与 errorReport 共用（设计 §10.3）
    const items = [];
    for (const [rowIndex, r] of rows.entries())
      items.push({
        rowIndex,
        outcome: r.status === 'succeeded' ? ('succeeded' as const) : ('failed' as const),
        objectId: r.exit_business_id,
        employeeId: r.employee_id,
        orgId: await orgOf(r.department_code),
      });
    // 每个 errors 元素一条（带原因码），而不是每个错误行一条
    const errorReport = rows.flatMap((r, rowIndex) =>
      r.status === 'succeeded'
        ? []
        : r.errors.map((error) => ({
            rowIndex,
            errorCode: r.status === 'failed' ? 'EXIT_IMPORT_ROW_FAILED' : 'EXIT_IMPORT_CREATED_WITH_ERROR',
            reason: error.reason,
          })),
    );
    await recordOperationLog(tx, {
      tenantId: tenant.id,
      actorUserId: batch.submittedBy,
      behavior: 'import',
      objectType: 'exit-import',
      objectId: batch.id,
      successCount: rows.filter((r) => r.status === 'succeeded').length,
      failureCount: errorRows,
      errorReport: errorReport.length ? errorReport : null,
      items,
      commandId: `exit-import:${batch.id}`,
      occurredAt: now,
    });
  });
}

/** 部门编码 → 组织 ID，仅在唯一解析时给出（同批多行同编码只查一次）；解析不到 / 有歧义为 null。 */
function departmentResolver(tx: Tx, tenantId: string) {
  const cache = new Map<string, string | null>();
  return async (code: string | null): Promise<string | null> => {
    if (code === null) return null;
    if (!cache.has(code)) {
      const found = await findDepartment(tx, tenantId, code);
      cache.set(code, 'id' in found ? found.id : null);
    }
    return cache.get(code)!;
  };
}

// ---- S3b 占位（红测试提交用；下一个提交替换为真实现） ------------------------------------------------------
export function startExitImportScheduler(
  _db: Db,
  _options: { clock: () => Date; onError: (error: unknown) => void; intervalMs: number },
) {
  return { stop: async () => undefined };
}
export async function purgeExpiredExitImports(_db: Db, _tenantId: string): Promise<number> {
  return 0;
}
