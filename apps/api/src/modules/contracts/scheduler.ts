import {
  and,
  eq,
  contractRecords,
  contractJobAttempts,
  sql,
  withTenant,
  withPlatform,
  type Db,
  type Tx,
} from '@italent/db';
import { automaticRenewalPlans, tenantLocalDate } from '@italent/domain';
import { commandHash } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { Authorizer } from '../../authorization.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { createPermissionAuthorizer } from '../permission/index.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { rowsOf, type ContractContext } from './context.js';
import { rules, settings } from './configuration.js';
import { applyRequest, createCommand, loadContract, loadRequest, setContractState } from './service.js';

interface Candidate {
  id: string;
  employeeId: string;
  kind: 'activate' | 'renew' | 'expire';
}
export interface ContractSchedulerInput {
  tenantId?: string;
  cursor?: string;
  tenantCursor?: string;
  limit?: number;
}
type Tenant = { id: string; timezone: string };
async function dueCandidates(db: Db, tenant: Tenant, today: string, input: ContractSchedulerInput, limit: number) {
  return withTenant(db, tenant.id, async (tx) => {
    const config = await settings(tx, tenant.id);
    return rowsOf<Candidate>(
      await tx.execute(sql`SELECT * FROM (
        SELECT id,employee_id AS "employeeId",'activate'::text AS kind FROM contract_requests
          WHERE tenant_id=${tenant.id} AND status='approved'
            AND CASE WHEN operation='terminate' THEN actual_termination_date ELSE effective_date END<=${today}::date
        UNION ALL
        SELECT id,employee_id AS "employeeId",'renew'::text AS kind FROM contract_records
          WHERE tenant_id=${tenant.id} AND ${config.autoRenew} AND NOT deleted AND status='valid'
            AND actual_termination_date IS NULL AND end_date IS NOT NULL
        UNION ALL
        SELECT id,employee_id AS "employeeId",'expire'::text AS kind FROM contract_records
          WHERE tenant_id=${tenant.id} AND ${config.autoTerminate} AND NOT deleted AND status='valid'
        AND end_date<${today}::date
      ) candidate WHERE (${input.cursor ?? null}::text IS NULL OR id::text||':'||kind>${input.cursor ?? null})
        AND NOT EXISTS (SELECT 1 FROM contract_job_attempts a WHERE a.tenant_id=${tenant.id}
          AND a.object_id=candidate.id AND a.kind=candidate.kind AND a.state='succeeded')
      ORDER BY id::text||':'||kind LIMIT ${limit + 1}`),
    );
  });
}
/** R1-T08 模式：租户时区、员工 SKIP LOCKED、每次有界、唯一业务命令去重，失败尝试可见并在下一轮重试。 */
export async function runContractJobs(
  db: Db,
  input: ContractSchedulerInput = {},
  options: { clock?: () => Date; authorize?: Authorizer } = {},
) {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new AppError('VALIDATION_FAILED', '单次处理量须为 1～500');
  const now = (options.clock ?? (() => new Date()))();
  const tenants = await withPlatform(db, async (tx) =>
    rowsOf<{ id: string; timezone: string }>(
      await tx.execute(sql`
    SELECT id,timezone FROM tenants WHERE status='active'
        AND (${input.tenantId ?? null}::uuid IS NULL OR id=${input.tenantId ?? null}::uuid)
    AND (${input.tenantCursor ?? null}::uuid IS NULL OR id>${input.tenantCursor ?? null}::uuid) ORDER BY id LIMIT 21`),
    ),
  );
  const authorize = options.authorize ?? createPermissionAuthorizer(db);
  const runs = [];
  let remaining = limit;
  for (const tenant of tenants.slice(0, 20)) {
    if (remaining === 0) break;
    const today = tenantLocalDate(now, tenant.timezone);
    const candidates = await dueCandidates(db, tenant, today, input, remaining);
    const batch = candidates.slice(0, remaining);
    const outcomes = [];
    for (const candidate of batch) {
      outcomes.push(await runCandidate(db, tenant, candidate, now, authorize));
    }
    const nextCursor = candidates.length > batch.length ? `${batch.at(-1)!.id}:${batch.at(-1)!.kind}` : null;
    runs.push({ tenantId: tenant.id, businessDate: today, outcomes, nextCursor });
    remaining -= batch.length;
  }
  return { runs, nextTenantCursor: tenants.length > runs.length ? (runs.at(-1)?.tenantId ?? null) : null };
}
async function renewCandidate(tx: Tx, ctx: ContractContext, candidate: Candidate, today: string) {
  const config = await settings(tx, ctx.tenantId);
  const contracts = await tx
    .select()
    .from(contractRecords)
    .where(
      and(
        eq(contractRecords.tenantId, ctx.tenantId),
        eq(contractRecords.employeeId, candidate.employeeId),
        eq(contractRecords.deleted, false),
      ),
    )
    .limit(10001);
  if (contracts.length > 10000) throw new AppError('PAYLOAD_TOO_LARGE', '单人合同数超过调度处理上限');
  const employment = await findCurrentRecord(tx, ctx.tenantId, candidate.employeeId, today);
  const plans = config.autoRenew
    ? automaticRenewalPlans(
        contracts,
        (await rules(tx, ctx.tenantId)).filter((r) => r.enabled),
        candidate.employeeId,
        employment?.fields.departmentId ?? null,
        today,
      )
    : [];
  const plan = plans.find((p) => p.targetId === candidate.id);
  if (plan) {
    const current = contracts.find((c) => c.id === plan.targetId)!;
    await createCommand(
      tx,
      { ...ctx, userId: plan.initiatorId, expectedRevision: current.revision },
      {
        operation: 'renew',
        mode: 'application',
        employeeId: current.employeeId,
        targetId: current.id,
        fields: {
          effectiveDate: plan.effectiveDate,
          endDate: plan.endDate,
          termType: plan.termType,
          termMonths: plan.termMonths,
        },
      },
      true,
    );
    return true;
  }
  return false;
}
async function executeCandidate(tx: Tx, ctx: ContractContext, candidate: Candidate, today: string) {
  let changed = false;
  if (candidate.kind === 'activate') {
    const request = await loadRequest(tx, ctx.tenantId, candidate.id);
    if (request.status === 'approved') {
      await applyRequest(tx, { ...ctx, userId: request.createdBy }, request);
      changed = true;
    }
  } else if (candidate.kind === 'expire') {
    const current = await loadContract(tx, ctx.tenantId, candidate.id);
    const config = await settings(tx, ctx.tenantId);
    if (config.autoTerminate && current.status === 'valid' && current.endDate && current.endDate < today) {
      await setContractState(tx, ctx, current, 'terminated', current.endDate);
      changed = true;
    }
  } else {
    changed = await renewCandidate(tx, ctx, candidate, today);
  }
  return changed;
}
async function runCandidate(db: Db, tenant: Tenant, candidate: Candidate, now: Date, authorize: Authorizer) {
  const today = tenantLocalDate(now, tenant.timezone);
  const ctx: ContractContext = {
    tenantId: tenant.id,
    timezone: tenant.timezone,
    userId: SYSTEM_USER_ID,
    now,
    commandId: `ct-job:${candidate.kind}:${candidate.id}`,
    expectedRevision: 0,
    fields: {
      viewable: (tx, userId, objectCode) =>
        getModuleViewableFieldsInTransaction(
          { db, authorize, clock: () => now },
          { tenantId: tenant.id, timezone: tenant.timezone, userId },
          objectCode,
          tx,
        ),
    },
  };
  try {
    const result = await withTenant(db, tenant.id, async (tx) => {
      const [locked] = rowsOf(
        await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${tenant.id}
            AND id=${candidate.employeeId}::uuid FOR UPDATE SKIP LOCKED`),
      );
      if (!locked) return 'locked';
      const [done] = rowsOf(
        await tx.execute(sql`SELECT 1 FROM contract_job_attempts WHERE tenant_id=${tenant.id}
            AND object_id=${candidate.id}::uuid AND kind=${candidate.kind} AND state='succeeded' LIMIT 1`),
      );
      if (done) return 'succeeded';
      const [ledger] = rowsOf<{ request_hash: string }>(
        await tx.execute(sql`SELECT request_hash FROM command_ledger
        WHERE tenant_id=${ctx.tenantId} AND command_id=${ctx.commandId}`),
      );
      if (ledger && ledger.request_hash !== commandHash(ctx.userId, candidate)) {
        throw new AppError('IDEMPOTENCY_CONFLICT', '调度命令 ID 已被其他内容使用');
      }
      // 员工锁下同一个目标 / 周期只能落地一次；失败事务不留命令结果。
      const changed = await executeCandidate(tx, ctx, candidate, today);
      if (changed) {
        await tx.insert(contractJobAttempts).values({
          tenantId: tenant.id,
          objectId: candidate.id,
          employeeId: candidate.employeeId,
          kind: candidate.kind,
          state: 'succeeded',
          commandId: ctx.commandId,
          createdAt: now,
        });
        // 同事务写调度命令台账；key 受员工锁保护，无需嵌套 runCommand 事务。
        await tx.execute(sql`INSERT INTO command_ledger(tenant_id,command_id,request_hash,response_status,response_body)
              VALUES (${tenant.id},${ctx.commandId},${commandHash(ctx.userId, candidate)},
              200,'{"succeeded":true}'::jsonb)
              ON CONFLICT (tenant_id,command_id) DO NOTHING`);
      }
      return changed ? 'succeeded' : 'skipped';
    });
    return { ...candidate, state: result };
  } catch (error) {
    return recoverCandidate(db, ctx, candidate, error);
  }
}
async function recoverCandidate(db: Db, ctx: ContractContext, candidate: Candidate, error: unknown) {
  // 提交结果未知时先回查成功记录；存储不可用则继续抛出，不能伪造业务失败。
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [done] = rowsOf(
      await tx.execute(sql`SELECT id FROM contract_job_attempts WHERE tenant_id=${ctx.tenantId}
      AND object_id=${candidate.id}::uuid AND kind=${candidate.kind} AND state='succeeded' LIMIT 1`),
    );
    if (done) return { ...candidate, state: 'succeeded' };
    const state = error instanceof AppError ? 'failed' : 'unknown';
    const code = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
    await tx.insert(contractJobAttempts).values({
      tenantId: ctx.tenantId,
      objectId: candidate.id,
      employeeId: candidate.employeeId,
      kind: candidate.kind,
      state,
      error: code,
      commandId: ctx.commandId,
      createdAt: ctx.now,
    });
    return { ...candidate, state, error: code };
  });
}

export function startContractScheduler(
  db: Db,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
) {
  const interval = options.intervalMs ?? 300_000;
  if (!Number.isSafeInteger(interval) || interval < 1000) throw new RangeError('合同调度间隔须至少 1000ms');
  let running: Promise<unknown> | null = null;
  let cursor: ContractSchedulerInput = {};
  const tick = () => {
    if (running) return;
    running = runContractJobs(db, cursor)
      .then((result) => {
        const last = result.runs.at(-1);
        cursor = last?.nextCursor
          ? { tenantId: last.tenantId, cursor: last.nextCursor }
          : result.nextTenantCursor
            ? { tenantCursor: result.nextTenantCursor }
            : cursor.tenantId
              ? { tenantCursor: cursor.tenantId }
              : {};
        const failures = result.runs.flatMap((r) => r.outcomes.filter((o) => ['failed', 'unknown'].includes(o.state)));
        if (failures.length) options.onError?.(new Error(`合同任务失败 ${failures.length} 条，请查看失败列表`));
      })
      .catch(options.onError ?? console.error)
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, interval);
  tick();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
