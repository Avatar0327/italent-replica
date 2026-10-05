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
import { automaticRenewalPlans, tenantLocalDate, type OrgId } from '@italent/domain';
import { commandHash } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { Authorizer } from '../../authorization.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { createPermissionAuthorizer } from '../permission/index.js';
import { getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { listOrgDescendantsInTransaction } from '../org/hierarchy-reader.js';
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
  /** 兼容旧调用方；工作队列改为持久尝试数轮转，游标不再过滤候选。 */
  cursor?: string;
  tenantCursor?: string;
  limit?: number;
}
type Tenant = { id: string; timezone: string };
async function dueCandidates(db: Db, tenant: Tenant, today: string, limit: number) {
  return withTenant(db, tenant.id, async (tx) => {
    const config = await settings(tx, tenant.id);
    return rowsOf<Candidate>(
      await tx.execute(sql`SELECT candidate.* FROM (
        SELECT id,employee_id AS "employeeId",'activate'::text AS kind FROM contract_requests
          WHERE tenant_id=${tenant.id} AND status='approved'
            AND CASE WHEN operation='terminate' THEN actual_termination_date ELSE effective_date END<=${today}::date
        UNION ALL
        SELECT id,employee_id AS "employeeId",'renew'::text AS kind FROM contract_records
          WHERE tenant_id=${tenant.id} AND ${config.autoRenew} AND NOT deleted AND status='valid'
            AND actual_termination_date IS NULL AND end_date IS NOT NULL
            AND end_date<=${today}::date+(SELECT max(d.days_before) FROM contract_renewal_details d
              JOIN contract_renewal_rules r ON r.tenant_id=d.tenant_id AND r.id=d.rule_id
              WHERE r.tenant_id=${tenant.id} AND r.enabled)
        UNION ALL
        SELECT id,employee_id AS "employeeId",'expire'::text AS kind FROM contract_records
          WHERE tenant_id=${tenant.id} AND ${config.autoTerminate} AND NOT deleted AND status='valid'
        AND end_date<${today}::date
      ) candidate WHERE NOT EXISTS (SELECT 1 FROM contract_job_attempts a WHERE a.tenant_id=${tenant.id}
          AND a.object_id=candidate.id AND a.kind=candidate.kind AND a.state='succeeded')
      ORDER BY CASE WHEN kind='renew' THEN 1 ELSE 0 END,
        coalesce((SELECT a.attempt_count FROM contract_job_attempts a WHERE a.tenant_id=${tenant.id}
          AND a.object_id=candidate.id AND a.kind=candidate.kind),0),
        CASE WHEN kind='activate' THEN 0 ELSE 1 END,id LIMIT ${limit + 1}`),
    );
  });
}
// 平台角色只读租户目录，业务查询始终在 withTenant 内；无显式游标的调用在进程内继续租户轮转。
const tenantCursors = new WeakMap<Db, string>();
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
  const tenantCursor = input.tenantCursor ?? (input.tenantId ? undefined : tenantCursors.get(db));
  const tenants = await withPlatform(db, async (tx) =>
    rowsOf<Tenant>(
      await tx.execute(sql`
    SELECT id,timezone FROM tenants WHERE status='active'
      AND (${input.tenantId ?? null}::uuid IS NULL OR id=${input.tenantId ?? null}::uuid)
      AND (${tenantCursor ?? null}::uuid IS NULL OR id>${tenantCursor ?? null}::uuid)
    ORDER BY id LIMIT 21
  `),
    ),
  );

  const authorize = options.authorize ?? createPermissionAuthorizer(db);
  const runs = [];
  let remaining = limit;
  for (const tenant of tenants.slice(0, 20)) {
    if (remaining === 0) break;
    const today = tenantLocalDate(now, tenant.timezone);
    const candidates = await dueCandidates(db, tenant, today, remaining);
    const batch = candidates.slice(0, remaining);
    const outcomes = [];
    // 缓存仅属于本轮当前租户；在首个续签候选事务中读取，下轮重新按业务日展开。
    let expandedRules: Awaited<ReturnType<typeof rules>> | undefined;
    const renewalRules = async (tx: Tx) => {
      expandedRules ??= await expandRenewalRules(tx, tenant.id, today);
      return expandedRules;
    };
    for (const candidate of batch) {
      outcomes.push(await runCandidate(db, tenant, candidate, now, authorize, renewalRules));
    }
    // 游标只表示本租户仍有工作；每轮重新排到期优先级，不能让旧游标跳过新到期项。
    const nextCursor = candidates.length > batch.length ? 'pending' : null;
    runs.push({ tenantId: tenant.id, businessDate: today, outcomes, nextCursor });
    remaining -= batch.length;
  }
  const nextTenantCursor = tenants.length > runs.length ? (runs.at(-1)?.tenantId ?? null) : null;
  if (!input.tenantId && !input.tenantCursor) {
    if (nextTenantCursor) tenantCursors.set(db, nextTenantCursor);
    else tenantCursors.delete(db);
  }
  return { runs, nextTenantCursor };
}
type RenewalRules = (tx: Tx) => Promise<Awaited<ReturnType<typeof rules>>>;
async function expandRenewalRules(tx: Tx, tenantId: string, today: string) {
  const enabledRules = (await rules(tx, tenantId)).filter((r) => r.enabled);
  const descendants = new Map<string, readonly string[]>();
  for (const rule of enabledRules) {
    const expanded = new Set(rule.orgIds);
    for (const orgId of rule.orgIds) {
      let children = descendants.get(orgId);
      if (!children) {
        children = await listOrgDescendantsInTransaction(
          tx,
          {
            tenantId,
            orgId: orgId as OrgId,
            dimension: 'admin',
            asOf: today,
          },
          { includeDisabled: true },
        );
        descendants.set(orgId, children);
      }
      for (const id of children) expanded.add(id);
    }
    rule.orgIds = [...expanded];
  }
  return enabledRules;
}
async function renewCandidate(
  tx: Tx,
  ctx: ContractContext,
  candidate: Candidate,
  today: string,
  renewalRules: RenewalRules,
) {
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
  const enabledRules = await renewalRules(tx);
  const plans = config.autoRenew
    ? automaticRenewalPlans(
        contracts,
        enabledRules,
        candidate.employeeId,
        employment?.fields.departmentId ?? null,
        today,
      )
    : [];
  const plan = plans.find((p) => p.targetId === candidate.id);
  if (plan) {
    const [pending] = rowsOf(
      await tx.execute(sql`SELECT id FROM contract_requests
      WHERE tenant_id=${ctx.tenantId} AND target_id=${candidate.id}::uuid
        AND status IN ('in_review','approved','returned') LIMIT 1`),
    );
    if (pending) return false;
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
async function executeCandidate(
  tx: Tx,
  ctx: ContractContext,
  candidate: Candidate,
  today: string,
  renewalRules: RenewalRules,
) {
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
    changed = await renewCandidate(tx, ctx, candidate, today, renewalRules);
  }
  return changed;
}
async function runCandidate(
  db: Db,
  tenant: Tenant,
  candidate: Candidate,
  now: Date,
  authorize: Authorizer,
  renewalRules: RenewalRules,
) {
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
      const changed = await executeCandidate(tx, ctx, candidate, today, renewalRules);
      if (changed) {
        // 同事务写调度命令台账；key 受员工锁保护，无需嵌套 runCommand 事务。
        await tx.execute(sql`INSERT INTO command_ledger(tenant_id,command_id,request_hash,response_status,response_body)
              VALUES (${tenant.id},${ctx.commandId},${commandHash(ctx.userId, candidate)},
              200,'{"succeeded":true}'::jsonb)
              ON CONFLICT (tenant_id,command_id) DO NOTHING`);
      }
      await saveAttempt(tx, ctx, candidate, changed ? 'succeeded' : 'skipped');
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
    // 失败事务已释放锁；重新按员工 → 业务顺序串行，避免覆盖另一实例刚写入的成功结果。
    await tx.execute(sql`SELECT id FROM employment_employees WHERE tenant_id=${ctx.tenantId}
      AND id=${candidate.employeeId}::uuid FOR UPDATE`);
    const [done] = rowsOf(
      await tx.execute(sql`SELECT id FROM contract_job_attempts WHERE tenant_id=${ctx.tenantId}
      AND object_id=${candidate.id}::uuid AND kind=${candidate.kind} AND state='succeeded' LIMIT 1`),
    );
    if (done) return { ...candidate, state: 'succeeded' };
    const state = error instanceof AppError ? 'failed' : 'unknown';
    const code = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
    await saveAttempt(tx, ctx, candidate, state, code);
    return { ...candidate, state, error: code };
  });
}

/** F-013：每对象 / 任务仅保留最近尝试，次数用于公平轮转；业务历史仍由审计和 outbox 保存。 */
async function saveAttempt(
  tx: Tx,
  ctx: ContractContext,
  candidate: Candidate,
  state: string,
  error: string | null = null,
) {
  await tx
    .insert(contractJobAttempts)
    .values({
      tenantId: ctx.tenantId,
      objectId: candidate.id,
      employeeId: candidate.employeeId,
      kind: candidate.kind,
      state,
      error,
      commandId: ctx.commandId,
      createdAt: ctx.now,
    })
    .onConflictDoUpdate({
      target: [contractJobAttempts.tenantId, contractJobAttempts.objectId, contractJobAttempts.kind],
      set: { state, error, createdAt: ctx.now, attemptCount: sql`${contractJobAttempts.attemptCount}+1` },
    });
}

export function startContractScheduler(
  db: Db,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
) {
  const interval = options.intervalMs ?? 300_000;
  if (!Number.isSafeInteger(interval) || interval < 1000) throw new RangeError('合同调度间隔须至少 1000ms');
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = runContractJobs(db)
      .then((result) => {
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
