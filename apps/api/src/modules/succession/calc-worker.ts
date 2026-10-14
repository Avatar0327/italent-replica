/** §4.6：run 行锁 → kind 的领域锁 → 对象保存点；任一页提交后可由另一 worker 继续，无进程租约。 */
import { createHash } from 'node:crypto';
import {
  and,
  eq,
  sql,
  isUuid,
  type Db,
  type Tx,
  withTenant,
  successionCalcRuns as runs,
  successionCalcRunObjects as objects,
  successionCalcRunFailures as failures,
} from '@italent/db';
import { isNull } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import {
  calcKey,
  CalcBlocked,
  CalcObjectFailure,
  SUCCESSION_CALC_KINDS,
  type CalcInput,
  type CalcRun,
  type CalcHandler,
} from './calc-contract.js';
import { enqueueCalcDone } from './calc-notifications.js';
import { rowsOf } from './read-sql.js';

const match = (tenant: string, id: string) => and(eq(runs.tenantId, tenant), eq(runs.id, id));
const objectMatch = (tenant: string, id: string) => and(eq(objects.tenantId, tenant), eq(objects.runId, id));
const conflict = (reason: string) => new AppError('CONFLICT', '计算任务状态冲突', { reason });
const uuid = (id: string) => {
  if (!isUuid(id)) throw new TypeError('计算对象 ID 非法');
  return id.toLowerCase();
};
const objectType = (kind: CalcInput['kind']) => {
  if (kind === 'exit_sweep') return 'employee';
  return kind === 'position_risk' ? 'position' : 'org';
};

async function audit(tx: Tx, run: CalcRun, before: unknown, now: Date, commandId = run.commandId) {
  await recordAudit(tx, {
    tenantId: run.tenantId,
    actorUserId: null,
    objectType: 'Succession.CalcRun',
    objectId: run.id,
    action: 'succession.calc_run',
    commandId,
    occurredAt: now,
    before,
    after: { status: run.status, attemptNo: run.attemptNo, phase: run.phase, blockReason: run.blockReason },
  });
}
async function locked(tx: Tx, tenant: string, id: string) {
  const [run] = await tx
    .select()
    .from(runs)
    .where(match(uuid(tenant), uuid(id)))
    .for('update');
  if (!run) throw new AppError('NOT_FOUND', '计算任务不存在');
  return run;
}

/** 在调用方的命令/调度事务内冻结集合。调用方先授权，不接受未经校验的 HTTP 输入。
 * A3/C1 在自身 SUCCESSION_JOBS 中生成输入；调度时间传 now/timezone，businessDate 必须为同一租户日期。
 * manual 的同键异内容冲突；定时同槽已存在则保留首次冻结集合（不能因后来成员变化扩大集合）。 */
export async function enqueueCalcRun(tx: Tx, input: CalcInput, now: Date): Promise<string> {
  const normalized = {
    ...input,
    tenantId: uuid(input.tenantId),
    requestedBy: input.requestedBy ? uuid(input.requestedBy) : null,
    batchId: input.batchId ? uuid(input.batchId) : undefined,
  };
  const key = calcKey(normalized);
  if (!input.commandId.trim()) throw new TypeError('命令 ID 不得为空');
  const scope = {
    ...(input.scope?.rootOrgId ? { rootOrgId: uuid(input.scope.rootOrgId) } : {}),
    ...(input.scope?.sourceBatchId ? { sourceBatchId: uuid(input.scope.sourceBatchId) } : {}),
  };
  const frozen = input.objects
    .map((o) => ({
      objectType: o.objectType,
      objectId: uuid(o.objectId),
      expectedRevision: o.expectedRevision ?? null,
    }))
    .sort((a, b) => a.objectId.localeCompare(b.objectId));
  if (
    new Set(frozen.map((o) => o.objectId)).size !== frozen.length ||
    frozen.some(
      (o) =>
        o.objectType !== objectType(input.kind) ||
        (o.expectedRevision !== null && (!Number.isSafeInteger(o.expectedRevision) || o.expectedRevision < 0)) ||
        (input.kind === 'org_health_reset' && o.expectedRevision === null),
    )
  )
    throw new TypeError('冻结对象类型、revision 或唯一性非法');
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        kind: input.kind,
        businessDate: input.businessDate,
        requestedBy: normalized.requestedBy,
        objects: frozen,
        scope,
      }),
    )
    .digest('hex');
  const [created] = await tx
    .insert(runs)
    .values({
      tenantId: normalized.tenantId,
      kind: input.kind,
      trigger: input.trigger,
      idempotencyKey: key,
      requestHash: hash,
      scope,
      requestedBy: normalized.requestedBy,
      commandId: input.commandId,
      businessDate: input.businessDate,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const [existing] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.tenantId, normalized.tenantId), eq(runs.idempotencyKey, key)));
    if (!existing || (input.trigger === 'manual' && existing.requestHash !== hash))
      throw conflict('IDEMPOTENCY_CONFLICT');
    return existing.id;
  }
  for (let offset = 0; offset < frozen.length; offset += 200)
    await tx
      .insert(objects)
      .values(
        frozen
          .slice(offset, offset + 200)
          .map((o) => ({ ...o, tenantId: created.tenantId, runId: created.id, pageNo: offset / 200 })),
      );
  await audit(tx, created, null, now);
  return created.id;
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
export async function runCalcPage(
  db: Db,
  tenant: string,
  id: string,
  handlers: readonly CalcHandler[] = SUCCESSION_CALC_KINDS,
  now = new Date(),
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
