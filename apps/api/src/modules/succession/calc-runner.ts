/**
 * §4.6：run 行锁 → kind 的领域锁 → 对象保存点；任一页提交后可由另一 worker 继续，无进程租约。
 * F-512：本文件是 calc-worker 去掉默认登记表后的执行内核。health-compute-run 在 ports → health-compute 的链上被处理器
 * 引入，若它依赖的 calc-worker 又引 calc-contract 的登记表，就会回到各 kind 处理器，处理器作首个入口时登记表读到未初始化值。
 * 默认 handlers 由 calc-worker 注入。
 */
import {
  and,
  eq,
  sql,
  type Db,
  type Tx,
  withTenant,
  successionCalcRuns as runs,
  successionCalcRunObjects as objects,
  successionCalcRunFailures as failures,
} from '@italent/db';
import { isNull } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { CalcBlocked, CalcObjectFailure, type CalcRun, type CalcHandler } from './calc-contract-core.js';
import { audit, conflict, objectType, uuid } from './calc-enqueue.js';
import { enqueueCalcDone } from './calc-notifications.js';
import { rowsOf } from './read-sql.js';

const match = (tenant: string, id: string) => and(eq(runs.tenantId, tenant), eq(runs.id, id));
const objectMatch = (tenant: string, id: string) => and(eq(objects.tenantId, tenant), eq(objects.runId, id));
async function locked(tx: Tx, tenant: string, id: string) {
  const [run] = await tx
    .select()
    .from(runs)
    .where(match(uuid(tenant), uuid(id)))
    .for('update');
  if (!run) throw new AppError('NOT_FOUND', '计算任务不存在');
  return run;
}

/** 内部状态操作：B3b 在 runSuccessionCommand/CommandGuard 中调用，返回前复用 authorizeSuccessionResult。
 * retry 调用方授权 CalcRun.retry 和实际执行集合；abort 仅 SA。这里负责锁内 CAS 与不可逆终态。 */
export async function changeCalcRun(
  tx: Tx,
  tenant: string,
  id: string,
  revision: number,
  action: 'retry' | 'abort',
  commandId: string,
  now: Date,
): Promise<CalcRun> {
  const run = await locked(tx, tenant, id);
  if (run.revision !== revision) throw new AppError('REVISION_CONFLICT', '任务已变更，请刷新后重提');
  if (action === 'retry') {
    const eligible = await tx
      .select({ id: objects.objectId })
      .from(objects)
      .where(and(objectMatch(tenant, id), eq(objects.retryable, true)))
      .limit(1);
    if (run.status !== 'blocked' && !(run.status === 'partial' && eligible.length)) throw conflict('RUN_NOT_RETRYABLE');
    await tx
      .update(objects)
      .set({ outcome: null, retryable: false })
      .where(and(objectMatch(tenant, id), eq(objects.retryable, true)));
  } else if (!['pending', 'running', 'blocked', 'partial'].includes(run.status)) throw conflict('RUN_NOT_ABORTABLE');
  const [after] = await tx
    .update(runs)
    .set({
      status: action === 'retry' ? 'pending' : 'aborted',
      trigger: action === 'retry' ? 'retry' : run.trigger,
      attemptNo: run.attemptNo + (action === 'retry' ? 1 : 0),
      revision: run.revision + 1,
      blockReason: null,
      lastErrorCode: null,
      finishedAt: action === 'retry' ? null : now,
    })
    .where(match(tenant, id))
    .returning();
  await audit(tx, after!, { status: run.status, attemptNo: run.attemptNo }, now, commandId);
  if (action === 'abort') await enqueueCalcDone(tx, after!, now);
  return after!;
}

async function executePage(tx: Tx, run: CalcRun, handler: CalcHandler, now: Date): Promise<CalcRun> {
  if (handler.objectType !== objectType(run.kind)) throw new CalcBlocked('KIND_UNAVAILABLE');
  const principal = uuid(await handler.authorizePage({ tx, run, now }));
  const active = await tx.execute(
    sql`SELECT succession_calc_user_active(${run.tenantId}::uuid,${principal}::uuid) AS active`,
  );
  if (!rowsOf<{ active: boolean }>(active)[0]?.active) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const selected = await tx
    .select()
    .from(objects)
    .where(and(objectMatch(run.tenantId, run.id), isNull(objects.outcome)))
    .orderBy(objects.pageNo, objects.objectId)
    .limit(200);
  await tx
    .update(runs)
    .set({ status: 'running', startedAt: run.startedAt ?? now })
    .where(match(run.tenantId, run.id));
  const current = { ...run, status: 'running' as const, principalUserId: principal, ownerUserId: principal };
  await handler.preparePage?.({ tx, run: current, now }, selected);
  for (const object of selected) {
    const where = and(
      objectMatch(run.tenantId, run.id),
      eq(objects.objectId, object.objectId),
      eq(objects.objectType, object.objectType),
    );
    await tx
      .delete(failures)
      .where(
        and(eq(failures.tenantId, run.tenantId), eq(failures.runId, run.id), eq(failures.objectId, object.objectId)),
      );
    try {
      await tx.transaction(async (savepoint) => {
        const outcome = await handler.execute({ tx: savepoint, run: current, now }, object);
        if (!['written', 'unchanged', 'manual_kept'].includes(outcome)) throw new TypeError('计算 kind 返回非法结果');
        await savepoint.update(objects).set({ outcome, retryable: false }).where(where);
      });
    } catch (error) {
      if (!(error instanceof CalcObjectFailure)) throw error;
      const revisionConflict = error.code === 'REVISION_CONFLICT';
      await tx
        .update(objects)
        .set({
          outcome: revisionConflict ? 'revision_conflict' : 'failed',
          retryable: !revisionConflict && error.retryable,
        })
        .where(where);
      await tx.insert(failures).values({
        tenantId: run.tenantId,
        runId: run.id,
        objectType: object.objectType,
        objectId: object.objectId,
        code: error.code,
        levelId: error.levelId,
        rowNo: error.rowNo,
      });
    }
  }
  return finishPage(tx, run, principal, now);
}

async function finishPage(tx: Tx, run: CalcRun, principal: string, now: Date): Promise<CalcRun> {
  const [counts] = await tx
    .select({
      pending: sql<number>`count(*) FILTER (WHERE outcome IS NULL)::int`,
      failed: sql<number>`count(*) FILTER (WHERE outcome IN ('failed','revision_conflict'))::int`,
    })
    .from(objects)
    .where(objectMatch(run.tenantId, run.id));
  let status: CalcRun['status'] = 'succeeded';
  if (counts!.failed) status = 'partial';
  if (counts!.pending) status = 'running';
  const [after] = await tx
    .update(runs)
    .set({
      status,
      principalUserId: principal,
      ownerUserId: principal,
      startedAt: run.startedAt ?? now,
      finishedAt: status === 'running' ? null : now,
      phase: run.phase + 1,
      revision: run.revision + 1,
      blockReason: null,
      lastErrorCode: null,
    })
    .where(match(run.tenantId, run.id))
    .returning();
  await audit(tx, after!, { status: run.status, phase: run.phase }, now);
  if (status !== 'running') await enqueueCalcDone(tx, after!, now);
  return after!;
}

/** 可信同步调用：复用 worker 状态机，但使用调用方事务；错误向外抛出，run / 缓存随命令一起回滚。 */
export async function runCalcPageInTransaction(
  tx: Tx,
  tenant: string,
  id: string,
  handler: CalcHandler,
  now: Date,
): Promise<CalcRun['status']> {
  const run = await locked(tx, tenant, id);
  if (run.status !== 'pending' && run.status !== 'running') return run.status;
  if (handler.kind !== run.kind) throw new CalcBlocked('KIND_UNAVAILABLE');
  return (await executePage(tx, run, handler, now)).status;
}

/** 一次调用最多提交一页；返回 running 时调用方继续调本函数。崩溃回滚当前页，已提交对象不再执行。
 * 页事务结果未知时，独立事务重新取 run 锁并检查 revision；已提交/另一 worker 已推进时不覆盖结果。 */
export async function runCalcPageWith(
  db: Db,
  tenant: string,
  id: string,
  handlers: readonly CalcHandler[],
  now: Date,
): Promise<CalcRun['status']> {
  let observed: CalcRun | undefined;
  try {
    return await withTenant(db, tenant, async (tx) => {
      const run = await locked(tx, tenant, id);
      if (run.status !== 'pending' && run.status !== 'running') return run.status;
      observed = run;
      const handler = handlers.find((h) => h.kind === run.kind);
      if (!handler) throw new CalcBlocked('KIND_UNAVAILABLE');
      return (await executePage(tx, run, handler, now)).status;
    });
  } catch (error) {
    if (!observed) throw error;
    const previous = observed;
    return withTenant(db, tenant, async (tx) => {
      const run = await locked(tx, tenant, id);
      if (run.revision !== previous.revision) return run.status;
      const code = error instanceof CalcBlocked ? error.code : 'STORAGE_UNAVAILABLE';
      const [after] = await tx
        .update(runs)
        .set({ status: 'blocked', blockReason: code, lastErrorCode: code, revision: run.revision + 1 })
        .where(match(tenant, id))
        .returning();
      await audit(tx, after!, { status: run.status }, now);
      return 'blocked';
    });
  }
}
