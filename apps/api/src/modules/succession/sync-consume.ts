/** D1b / §5.7 P0+P1：租户互斥 → T04 消费记录 → 目标锁 → 记录行；失败先回滚再记状态。 */
import {
  and,
  eq,
  getTenant,
  isUuid,
  sql,
  withTenant,
  successionSyncBatches as batches,
  type Db,
  type Tx,
} from '@italent/db';
import { recordSyncAudit, batchAuditSnapshot } from './sync-audit.js';
import { AppError } from '../../errors.js';
import type { SyncRunHeader, TalentReviewSyncPort } from '../talent-review/sync-port.js';
import { SyncPortError } from '../talent-review/sync-port.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import {
  PlanFailure,
  activeUser,
  targetAccess,
  authorizeRequesterTargets,
  writerAccess,
  type AccessDeps,
} from './sync-access.js';
import { collectTargets, persistPlan, readPlan } from './sync-plan.js';
import { rowsOf } from './read-sql.js';
import { executeSyncBatch } from './sync-execute.js';
import { claimSync, retryTime } from './sync-control.js';
import { enqueueSyncHealth } from './sync-health.js';
import { lockOrganizationSettings } from '../org/locks.js';

export interface SyncDeps extends AccessDeps {
  db: Db;
  port: TalentReviewSyncPort;
  /** SP-18 替身注入共同事务；真实端口直接使用同一个 PostgreSQL tx。 */
  transaction?: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>;
}
export interface SyncInput {
  tenantId: string;
  runId: string;
  leaseOwner: string;
  requesterUserId?: string;
}
type Batch = typeof batches.$inferSelect;
const terminal = (batch: Batch) => ['completed', 'terminated', 'rejected'].includes(batch.status);
const batchKey = (input: SyncInput) => and(eq(batches.tenantId, input.tenantId), eq(batches.sourceRunId, input.runId));
const denied = (reason: string) => new AppError('FORBIDDEN', '同步批次不可操作', { reason });
const C_CODES = ['SCOPE_REQUIRED', 'UNSUPPORTED_TRIGGER', 'ACTOR_SCOPE_EXCEEDED'];
export async function ensureBatch(tx: Tx, input: SyncInput, header: SyncRunHeader) {
  await tx
    .insert(batches)
    .values({
      tenantId: input.tenantId,
      sourceRunId: input.runId,
      projectId: header.projectId,
      trigger: header.trigger,
      manualOverride: header.manualOverride,
      actorUserId: header.actorUserId,
      ownerUserId: header.ownerUserId,
      sourcePrincipalUserId: header.principalUserId,
      businessDate: header.businessDate,
      scopeExplicit: header.scopeExplicit,
      scopeOrgIds: header.scopeOrgIds,
    })
    .onConflictDoNothing({ target: [batches.tenantId, batches.sourceRunId] });
  return (await tx.select().from(batches).where(batchKey(input)))[0]!;
}
export async function mutex(tx: Tx, tenantId: string) {
  await tx.execute(
    sql`INSERT INTO succession_sync_mutex (tenant_id) VALUES (${tenantId}::uuid) ON CONFLICT DO NOTHING`,
  );
  return rowsOf<{ batch_id: string | null }>(
    await tx.execute(sql`SELECT batch_id FROM succession_sync_mutex
    WHERE tenant_id=${tenantId}::uuid FOR UPDATE`),
  )[0]!.batch_id;
}
export async function release(tx: Tx, batch: Batch) {
  await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=NULL
    WHERE tenant_id=${batch.tenantId}::uuid AND batch_id=${batch.id}::uuid`);
}
export async function save(
  tx: Tx,
  batch: Batch,
  patch: Partial<Batch>,
  now: Date,
  commandId: string,
  phase = 'plan',
  actorUserId: string | null = null,
) {
  // 调用方先按协议取得互斥/消费记录锁；统一在更新前锁内重读，禁止用镜像伪造前值。
  const where = and(eq(batches.tenantId, batch.tenantId), eq(batches.id, batch.id));
  const [before] = await tx.select().from(batches).where(where).for('update');
  const [saved] = await tx
    .update(batches)
    .set({
      ...(patch.status === 'blocked' || patch.status === 'waiting'
        ? { nextRetryAt: retryTime(before!.autoRetryCount, now) }
        : patch.status === 'completed'
          ? { nextRetryAt: null }
          : {}),
      ...patch,
      revision: before!.revision + 1,
    })
    .where(and(eq(batches.tenantId, batch.tenantId), eq(batches.id, batch.id)))
    .returning();
  await recordSyncAudit(
    tx,
    batch,
    { actorUserId, now, commandId, phase },
    batchAuditSnapshot(before!),
    batchAuditSnapshot(saved!),
  );
  return saved!;
}
export async function notify(tx: Tx, batch: Batch, now: Date, actorUserId: string | null = null) {
  const commandId = `${batch.sourceRunId}:succession:done`;
  const inserted = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`INSERT INTO succession_notifications
    (tenant_id,batch_id,recipient_user_id,kind,command_id,created_at)
    SELECT ${batch.tenantId}::uuid,${batch.id}::uuid,${batch.actorUserId}::uuid,'sync_done',
      ${commandId},${now.toISOString()}::timestamptz
    WHERE succession_calc_user_active(${batch.tenantId}::uuid,${batch.actorUserId}::uuid)
    ON CONFLICT (tenant_id,subject_id,recipient_user_id,kind) DO NOTHING
    RETURNING id,recipient_user_id AS "recipientUserId",kind,state`),
  );
  if (inserted[0])
    await recordSyncAudit(tx, batch, { actorUserId, now, commandId, phase: 'sync_done' }, null, inserted[0]);
}
class FirstPlan {
  header: SyncRunHeader | null = null;
  executionNo: number | undefined;
  pageCommandId: string | undefined;
  readonly key;
  constructor(
    readonly deps: SyncDeps,
    readonly input: SyncInput,
    readonly timezone: string,
    readonly now: Date,
  ) {
    this.key = { tenantId: input.tenantId, runId: input.runId, consumer: 'succession' as const };
  }
  async run(tx: Tx): Promise<Batch> {
    const { deps, input, key, now } = this;
    const existing = (await tx.select().from(batches).where(batchKey(input)))[0];
    if (existing && terminal(existing)) {
      if (input.requesterUserId) throw denied('RUN_NOT_RETRYABLE');
      return existing;
    }
    if (existing?.hasPlan) return existing; // 阶段 E 由 D2 接续，不重新计划 / 授权原触发人。
    this.header = await deps.port.loadRun(tx, key);
    if (!this.header) throw new PlanFailure('SOURCE_UNAVAILABLE');
    let batch = await ensureBatch(tx, input, this.header);
    const owner = await mutex(tx, input.tenantId);
    if (owner && owner !== batch.id) {
      const [other] = await tx
        .select()
        .from(batches)
        .where(and(eq(batches.tenantId, input.tenantId), eq(batches.id, owner)));
      if (other && !terminal(other)) throw new PlanFailure('BATCH_IN_PROGRESS');
    }
    // 等互斥期间同 run 可能已完成计划，必须在锁内重读。
    batch = (await tx.select().from(batches).where(batchKey(input)).for('update'))[0]!;
    if (terminal(batch) || batch.hasPlan) {
      if (terminal(batch) && input.requesterUserId) throw denied('RUN_NOT_RETRYABLE');
      return batch;
    }
    await tx.execute(sql`UPDATE succession_sync_mutex SET batch_id=${batch.id}::uuid,
      acquired_at=${now.toISOString()}::timestamptz WHERE tenant_id=${input.tenantId}::uuid`);
    this.header = await deps.port.loadRun(tx, key);
    if (!this.header) throw new PlanFailure('SOURCE_UNAVAILABLE');
    if (this.header.status === 'superseded') throw new PlanFailure('RUN_SUPERSEDED');
    if (this.header.trigger !== 'sync_requested') throw new PlanFailure('UNSUPPORTED_TRIGGER');
    return this.commit(tx, batch, this.header);
  }
  private async commit(tx: Tx, batch: Batch, header: SyncRunHeader) {
    const { deps, input, key, now, timezone } = this;
    const state = await deps.port.beginConsumption(tx, { ...key, leaseOwner: input.leaseOwner, leaseSeconds: 120 });
    const executionNo = (this.executionNo = state.executionNo);
    const pageCommandId = (this.pageCommandId = `${input.runId}:succession:${executionNo}:0`);
    const strategy = (await readEffectiveSetting(tx, input.tenantId, 'succession.sync_strategy')).value as NonNullable<
      Batch['strategy']
    >;
    if (strategy === 'overwrite_in_scope' && !header.scopeExplicit) throw new PlanFailure('SCOPE_REQUIRED');
    const plan = await readPlan(tx, input.tenantId, input.runId, deps.port);
    const writer = await writerAccess(deps, tx, input.tenantId, timezone);
    const targets = await collectTargets(tx, input.tenantId, header, plan, strategy);
    const authorizationTargets = [
      ...targets,
      ...plan.nominations.map((n) => ({ kind: n.kind, id: (n.orgId ?? n.positionId)! })),
    ];
    const access = await targetAccess(deps, tx, input.tenantId, timezone, header.actorUserId);
    let covered = await activeUser(tx, input.tenantId, header.actorUserId);
    for (const target of authorizationTargets) if (!(await access.covers(target))) covered = false;
    if (!covered) throw new PlanFailure('ACTOR_SCOPE_EXCEEDED');
    if (input.requesterUserId)
      await authorizeRequesterTargets(
        deps,
        tx,
        { tenantId: input.tenantId, timezone, userId: input.requesterUserId },
        authorizationTargets,
      );
    if (targets.some((t) => t.kind === 'org_health')) await lockOrganizationSettings(tx, input.tenantId);
    const planned = await persistPlan(tx, {
      tenantId: input.tenantId,
      batchId: batch.id,
      header,
      plan,
      targets,
      writer,
      executionNo,
      pageCommandId,
      now,
    });
    await deps.port.registerTargets(tx, {
      ...key,
      executionNo,
      planCommandId: pageCommandId,
      targets: planned.registrations,
      planOutcomes: planned.outcomes,
    });
    if (!planned.pending) await deps.port.completeConsumption(tx, { ...key, executionNo });
    const result = planned.outcomes.some((o) => o.status === 'failed') ? 'partial' : 'succeeded';
    batch = await save(
      tx,
      batch,
      {
        strategy,
        writePrincipalUserId: writer.userId,
        actorScopeCheckedAt: now,
        hasPlan: true,
        status: planned.pending ? 'executing' : 'completed',
        blockReason: null,
        executionNo,
        leaseOwner: input.leaseOwner,
        plannedAt: now,
        startedAt: now,
        finishedAt: planned.pending ? null : now,
        result: planned.pending ? null : result,
      },
      now,
      pageCommandId,
      'plan',
      input.requesterUserId ?? null,
    );
    if (!planned.pending) {
      await release(tx, batch);
      await notify(tx, batch, now, input.requesterUserId ?? null);
      await enqueueSyncHealth(tx, batch, now);
    }
    return batch;
  }
  async confirm(tx: Tx) {
    const { deps, input, key } = this;
    const proof = await deps.port.getPageCommit(tx, { ...key, pageCommandId: this.pageCommandId! });
    const [local] = await tx.select().from(batches).where(batchKey(input));
    const valid =
      proof?.kind === 'plan' &&
      proof.executionNo === this.executionNo &&
      local?.hasPlan &&
      local.executionNo === this.executionNo;
    if (local?.hasPlan && !valid) throw new PlanFailure('STORAGE_UNAVAILABLE');
    return valid ? local : undefined;
  }
  async fail(tx: Tx, failure: PlanFailure | SyncPortError) {
    const { deps, input, key, now } = this;
    let batch = await ensureBatch(tx, input, this.header!);
    await mutex(tx, input.tenantId);
    batch = (await tx.select().from(batches).where(batchKey(input)).for('update'))[0]!;
    if (terminal(batch) || batch.hasPlan) return batch;
    const rejected = C_CODES.includes(failure.code);
    const superseded = failure.code === 'RUN_SUPERSEDED';
    let status: Batch['status'] = 'blocked';
    if (rejected) status = 'rejected';
    else if (superseded) status = 'terminated';
    else if (failure.code === 'BATCH_IN_PROGRESS') status = 'waiting';
    if (rejected)
      await deps.port.abortConsumption(tx, { ...key, executionNo: null, code: failure.code, recovery: 'new_run' });
    batch = await save(
      tx,
      batch,
      {
        status,
        blockReason: rejected || superseded ? null : failure.code,
        endReason: superseded ? 'superseded' : rejected ? failure.code : null,
        finishedAt: rejected || superseded ? now : null,
      },
      now,
      `${input.runId}:succession:plan:${failure.code}`,
      'plan',
      input.requesterUserId ?? null,
    );
    await release(tx, batch);
    if (rejected) await notify(tx, batch, now, input.requesterUserId ?? null);
    return batch;
  }
}
/** 可信后台入口；HTTP /sync 与 retry 后续由 D3 的 commands.ts / authorizeSuccessionResult 包装。 */
export async function planSyncRun(deps: SyncDeps, input: SyncInput): Promise<Batch | undefined> {
  if (!isUuid(input.tenantId) || !isUuid(input.runId) || !input.leaseOwner) throw new TypeError('同步输入非法');
  input = { ...input, tenantId: input.tenantId.toLowerCase(), runId: input.runId.toLowerCase() };
  const tenant = await getTenant(deps.db, input.tenantId);
  if (!tenant || tenant.status !== 'active') throw denied('TENANT_UNAVAILABLE');
  const transaction =
    deps.transaction ?? (<T>(work: (tx: Tx) => Promise<T>) => withTenant(deps.db, input.tenantId, work));
  const plan = new FirstPlan(deps, input, tenant.timezone, deps.clock());
  // SP-11：只认同执行号的 plan 证明；无证明则同一命令重做，已有本地计划但证明不符时保留未知。
  for (let attempt = 0; ; attempt++) {
    try {
      return await transaction((tx) => plan.run(tx));
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (!(error instanceof PlanFailure) && !(error instanceof SyncPortError) && plan.pageCommandId) {
        const committed = await transaction((tx) => plan.confirm(tx));
        if (committed) return committed;
        if (!attempt) continue;
      }
      if (error instanceof SyncPortError && error.code === 'CONSUMPTION_LEASED') return undefined;
      const failure =
        error instanceof PlanFailure || error instanceof SyncPortError ? error : new PlanFailure('STORAGE_UNAVAILABLE');
      if (!plan.header) throw failure;
      const batch = await transaction((tx) => plan.fail(tx, failure));
      if (failure.code === 'BATCH_IN_PROGRESS' && input.requesterUserId)
        throw new AppError('CONFLICT', '租户已有同步批次', { reason: failure.code });
      return batch;
    }
  }
}
export async function consumeRun(deps: SyncDeps, input: SyncInput): Promise<Batch | undefined> {
  let batch = await planSyncRun(deps, input);
  if (!batch?.hasPlan || terminal(batch)) return batch;
  const tenant = await getTenant(deps.db, input.tenantId);
  batch = await claimSync(deps, input, batch, tenant!.timezone);
  return batch && !terminal(batch) ? executeSyncBatch(deps, input, batch) : batch;
}
/** SP-02：outbox 只提供租户和 run 定位；主体、日期、策略都在 consumeRun 重读，不能信任事件附带值。 */
export const consumeSyncOutbox = (
  deps: SyncDeps,
  event: { tenantId: string; payload: { runId: string } },
  owner: string,
) => consumeRun(deps, { tenantId: event.tenantId, runId: event.payload.runId, leaseOwner: owner });
