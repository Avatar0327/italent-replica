import {
  classifyCommandFailure,
  recordCommandFailure,
  type CommandFailure,
  type CommandPhase,
} from '../../audit/failures.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { auditSequenceResult, sequenceResults } from './sequence-result.js';
/** DEC-052：持久 outbox 消费，追加尝试日志；整批在保存点中成功或回滚，失败下次调度可重试。 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Db, type Tx, withPlatform, withTenant } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import { type Authorizer, requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { isActiveAccount } from '../approval/resolver.js';
import { auditEmployment } from '../employment/context.js';
import { personnelHooks } from '../employment/personnel-hooks.js';
import {
  bumpEmploymentBusiness,
  insertEmploymentRow,
  lockEmploymentBusiness,
  lockEmploymentEmployee,
  rowsOf,
} from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { createPermissionAuthorizer } from '../permission/authorizer.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { JOB_OBJECT_CODES, visibleJob } from '../permission/module-route-access.js';
import { SEQUENCE_REQUESTED, type SequenceRequest } from './sequence-sync.js';
import { authorizeSequenceTargets, sequenceTargets, type SequenceTarget } from './sequence-targets.js';

interface QueuedJob {
  id: string;
  commandId: string;
  payload: { after: SequenceRequest };
}
interface Options {
  readonly clock?: () => Date;
  readonly authorize?: Authorizer;
  readonly limit?: number;
  readonly cursor?: string;
}
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;

export async function runSequenceSyncJobs(db: Db, tenantId: string, options: Options = {}) {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError('同步任务上限须为 1～200');
  if (options.cursor !== undefined && !isUuid(options.cursor)) throw new RangeError('同步任务游标须为 UUID');
  const clock = options.clock ?? (() => new Date());
  const authorize = options.authorize ?? createPermissionAuthorizer(db);
  const tenant = await withPlatform(
    db,
    async (tx) =>
      rowsOf<{ timezone: string }>(
        await tx.execute(sql`
    SELECT timezone FROM tenants WHERE id=${tenantId}::uuid AND status='active'`),
      )[0],
  );
  if (!tenant) return { completed: 0, failed: 0, nextCursor: null as string | null };
  const jobs = await withTenant(db, tenantId, async (tx) =>
    rowsOf<QueuedJob>(
      await tx.execute(sql`
    SELECT o.id,o.command_id AS "commandId",o.payload FROM employment_outbox o
    WHERE o.tenant_id=${tenantId} AND o.event_type=${SEQUENCE_REQUESTED}
      AND ${pendingJob(sql`o`)}
      AND (${options.cursor ?? null}::uuid IS NULL OR (o.created_at,o.id) > (
        SELECT created_at,id FROM employment_outbox WHERE tenant_id=${tenantId} AND id=${options.cursor ?? null}::uuid))
      ORDER BY o.created_at,o.id LIMIT ${limit + 1}`),
    ),
  );
  const batch = jobs.slice(0, limit);
  const result = { completed: 0, failed: 0, nextCursor: jobs.length > limit ? batch.at(-1)!.id : null };
  // 每单单独提交释放员工锁；失败只挂起有相同来源或任职目标的后继，其他同步任务仍可执行。
  for (const job of batch) {
    const outcome = await consumeJob(db, tenantId, tenant.timezone, job, clock, authorize);
    if (outcome) result[outcome]++;
  }
  return result;
}

function pendingJob(alias: ReturnType<typeof sql.raw>) {
  return sql`(SELECT a.state FROM employment_outbox_attempts a
    WHERE a.tenant_id=${alias}.tenant_id AND a.outbox_id=${alias}.id ORDER BY a.attempt_no DESC LIMIT 1)<>'sent'`;
}

async function consumeJob(
  db: Db,
  tenantId: string,
  timezone: string,
  queued: QueuedJob,
  clock: () => Date,
  authorize: Authorizer,
) {
  const id = queued.id;
  const ctx: EmploymentContext = {
    tenantId,
    timezone,
    now: clock(),
    userId: queued.payload.after.recipientUserId,
    commandId: queued.commandId,
    expectedRevision: 0,
  };
  const progress: { phase: CommandPhase } = { phase: 'execute' };
  let failure: CommandFailure | undefined;
  try {
    const outcome = await withTenant(db, tenantId, async (tx) => {
      const [gate] = rowsOf<{ entered: boolean }>(
        await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`job-sequence:${tenantId}`},0)) AS entered`),
      );
      if (!gate?.entered) return null;
      const [job] = rowsOf<QueuedJob>(
        await tx.execute(sql`
      SELECT o.id,o.command_id AS "commandId",o.payload FROM employment_outbox o
      WHERE o.tenant_id=${tenantId} AND o.id=${id}::uuid AND o.event_type=${SEQUENCE_REQUESTED}
        AND ${pendingJob(sql`o`)} AND NOT EXISTS (
          SELECT 1 FROM employment_outbox earlier WHERE earlier.tenant_id=o.tenant_id
            AND earlier.event_type=${SEQUENCE_REQUESTED} AND (earlier.created_at,earlier.id)<(o.created_at,o.id)
            AND ${pendingJob(sql`earlier`)} AND (
              EXISTS (SELECT 1 FROM jsonb_array_elements_text(earlier.payload->'after'->'targetIds') target
                WHERE o.payload->'after'->'targetIds' ? target.value)
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(earlier.payload->'after'->'sources') a,
                jsonb_array_elements(o.payload->'after'->'sources') b WHERE a->>'id'=b->>'id')
            )) LIMIT 1`),
      );
      if (!job) return null;
      try {
        await tx.transaction(async (savepoint) => {
          const access = await sequenceJobAccess(savepoint, db, ctx, job, clock, authorize);
          await executeSequenceJob(savepoint, access, job);
          await recordAttempt(savepoint, ctx, job.id, 'sent', null);
        });
        progress.phase = 'commit';
        return 'completed' as const;
      } catch (error) {
        // 保存点已回滚；连接本身不可写时该日志事务也失败，任务仍留队列，不伪造结果。
        failure = classifyCommandFailure(error, 'execute');
        await recordAttempt(tx, ctx, job.id, 'failed', failure.errorCode);
        progress.phase = 'commit';
        return 'failed' as const;
      }
    });
    if (failure) await recordCommandFailure(db, { ...ctx, userId: SYSTEM_USER_ID }, ctx.commandId, failure);
    return outcome;
  } catch (error) {
    return recoverSequenceFailure(db, ctx, id, error, progress.phase);
  }
}

async function recoverSequenceFailure(db: Db, ctx: EmploymentContext, id: string, error: unknown, phase: CommandPhase) {
  const tenantId = ctx.tenantId;
  // 提交后断连先回查持久 sent 标志；确认成功不重记、不重做。查不到时保留 unknown，下一轮幂等重试。
  if (phase === 'commit') {
    try {
      const sent = await withTenant(
        db,
        tenantId,
        async (tx) =>
          rowsOf<{ state: string }>(
            await tx.execute(sql`
          SELECT state FROM employment_outbox_attempts WHERE tenant_id=${tenantId} AND outbox_id=${id}::uuid
          ORDER BY attempt_no DESC LIMIT 1`),
          )[0]?.state === 'sent',
      );
      if (sent) return 'completed' as const;
    } catch {
      /* 回查失败同样不能推断已回滚。 */
    }
  }
  const failure = classifyCommandFailure(error, phase);
  await recordCommandFailure(db, { ...ctx, userId: SYSTEM_USER_ID }, ctx.commandId, failure);
  await withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`job-sequence:${tenantId}`},0))`);
    const latest = rowsOf<{ state: string }>(
      await tx.execute(sql`SELECT state FROM employment_outbox_attempts
        WHERE tenant_id=${tenantId} AND outbox_id=${id}::uuid ORDER BY attempt_no DESC LIMIT 1`),
    )[0];
    if (latest?.state !== 'sent')
      await recordAttempt(tx, ctx, id, failure.outcome === 'unknown' ? 'unknown' : 'failed', failure.errorCode);
  }).catch(() => {
    /* 存储仍不可写：保留原任务；失败审计已有兜底通道，不伪造尝试写入成功。 */
  });
  return 'failed' as const;
}

async function sequenceJobAccess(
  tx: Tx,
  db: Db,
  ctx: EmploymentContext,
  job: QueuedJob,
  clock: () => Date,
  authorize: Authorizer,
): Promise<EmploymentContext> {
  const bound = authorizeInTransaction(authorize, tx);
  if (!(await isActiveAccount(tx, ctx.tenantId, ctx.userId))) throw new AppError('FORBIDDEN', '发起人已不是有效成员');
  const deps = { db, authorize: bound, clock };
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYMENT);
  for (const source of job.payload.after.sources) {
    const code = JOB_OBJECT_CODES[source.kind];
    await requirePermission(bound, { ...ctx, action: 'object.update', resource: code, fields: ['sequenceId'] });
    const jobScope = await resolveModuleScopeInTransaction(deps, ctx, tx, code);
    await visibleJob(tx, ctx, jobScope, source.kind, source.id, tenantLocalDate(ctx.now, ctx.timezone));
  }
  return { ...ctx, scope, authorize: bound };
}

async function executeSequenceJob(tx: Tx, ctx: EmploymentContext, job: QueuedJob) {
  const request = job.payload.after;
  // 先一次性按固定顺序锁全批员工，然后重读引用与状态；不使用入队时的字段快照覆盖并发调动。
  const employees = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT DISTINCT employee_id AS id FROM employment_business_objects
    WHERE tenant_id=${ctx.tenantId} AND id=ANY(${`{${request.targetIds.join(',')}}`}::uuid[]) ORDER BY id`),
  );
  for (const employee of employees) await lockEmploymentEmployee(tx, ctx, employee.id);
  const candidates = await sequenceTargets(tx, ctx, request.sources, request.targetIds, true);
  const targets = candidates.filter((target) => target.fields.sequenceId !== target.source.sequenceId);
  await authorizeSequenceTargets(tx, ctx, targets);
  const results = await sequenceResults(tx, ctx, request, candidates);
  for (const target of targets) await appendSequenceVersion(tx, ctx, target);
  await auditSequenceResult(tx, ctx, job.id, results);
  // 审批通知要求 instance_id；站内消息复用 outbox，不伪造审批实例。
  // 此载荷是内部执行证据，两个读取接口必须经 visibleSequenceReceipts 按当前权限裁剪。
  await auditEmployment(
    tx,
    { ...ctx, userId: SYSTEM_USER_ID },
    'job.sequence-sync.completed',
    'job-sequence-sync',
    job.id,
    null,
    {
      recipientUserId: request.recipientUserId,
      channel: 'inbox',
      count: targets.length,
      taskId: job.id,
      skipped: results.filter((row) => row.reason).map(({ recordId, reason }) => ({ recordId, reason })),
    },
  );
}

async function appendSequenceVersion(tx: Tx, ctx: EmploymentContext, target: SequenceTarget) {
  const business = await lockEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: target.revision },
    target.payload.businessId,
  );
  const { fields: _fields, ...metadata } = business.payload;
  const id = randomUUID();
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...metadata,
    ...target.fields,
    sequenceId: target.source.sequenceId,
    customFields: target.customFields,
    id,
    versionNo: business.payload.versionNo + 1,
    previousVersionId: business.payload.id,
    commandId: ctx.commandId,
    triggerBusinessId: business.id,
    isRecordSnapshot: target.effective,
    deferredFieldCodes: target.effective
      ? []
      : business.payload.deferredFieldCodes.filter((code) => code !== 'preset:sequenceId'),
    explicitFieldCodes: [...new Set([...business.payload.explicitFieldCodes, 'preset:sequenceId'])],
    createdAt: ctx.now.toISOString(),
  });
  await bumpEmploymentBusiness(tx, ctx, business);
  await auditEmployment(
    tx,
    { ...ctx, userId: SYSTEM_USER_ID },
    'employment.sequence-sync',
    'employment-record',
    business.id,
    { sequenceId: target.fields.sequenceId },
    { sequenceId: target.source.sequenceId },
    id,
    { sourceKind: target.source.kind, sourceId: target.source.id },
  );
  if (target.effective)
    await personnelHooks.sync(
      tx,
      ctx,
      business.employeeId,
      business.id,
      business.payload.kind,
      business.payload.effectiveDate,
    );
}

async function recordAttempt(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  state: 'sent' | 'failed' | 'unknown',
  reason: string | null,
) {
  await tx.execute(sql`INSERT INTO employment_outbox_attempts
    (tenant_id,outbox_id,attempt_no,state,error_reason,created_at)
    SELECT ${ctx.tenantId},${id},COALESCE(max(attempt_no),0)+1,${state},${reason},${ctx.now.toISOString()}::timestamptz
    FROM employment_outbox_attempts WHERE tenant_id=${ctx.tenantId} AND outbox_id=${id}::uuid`);
}

export function startSequenceSyncScheduler(db: Db, intervalMs = 5000) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (running) return;
    running = sweep(db)
      .catch((error: unknown) => console.error('序列同步调度失败', error))
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
async function sweep(db: Db) {
  let cursor: string | null = null;
  for (;;) {
    const tenants: { id: string }[] = await withPlatform(db, async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT id FROM tenants WHERE status='active' AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid)
      ORDER BY id LIMIT 100`),
      ),
    );
    for (const tenant of tenants) {
      let cursor: string | undefined;
      do {
        const result = await runSequenceSyncJobs(db, tenant.id, { cursor });
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
    }
    if (tenants.length < 100) return;
    cursor = tenants.at(-1)!.id;
  }
}
