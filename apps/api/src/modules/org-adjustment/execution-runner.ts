/**
 * R2-T08 §7.4 / §7.6A / §7.7 / §7.8：执行开始复核、逐组执行、失败分类与收尾。
 * 挂在任职定时生效的同一定时器上（activation-scheduler.ts runSlot），每刻遍历活跃租户；执行身份为系统用户。
 */
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { rowsOf, schedulerAwareContext } from '../approval/context.js';
import { notifyMessage } from '../approval/notifications.js';
import { latestInstanceOf } from '../approval/store.js';
import { activeTenants, type TenantRow } from '../employment/active-tenants.js';
import { lockOrganizationSettings } from '../org/locks.js';
import {
  groupScope,
  loadAdjustmentHead,
  loadExecutionGroups,
  loadExecutionItems,
  type AdjustmentHead,
  type ExecutionGroup,
  type GroupExecutors,
} from './execution-groups.js';
import {
  claimOrgAdjustmentRunner,
  fenced,
  FencingLost,
  pickAdjustment,
  PROCESS_HOLDER_TOKEN,
  releaseRunner,
  type RunnerLease,
} from './runner-lease.js';

export const MAX_GROUP_ATTEMPTS = 5;

export interface RunnerOptions {
  readonly holderToken?: string;
  readonly leaseMs?: number;
  /** 各明细执行器（BE-11b～11f 接入）；没有执行器的组按业务失败 EXECUTOR_NOT_AVAILABLE 记结果。 */
  readonly executors?: GroupExecutors;
  /** §7.6A 申请人主体组织层复核（§6.3“执行”列）；未注入时放行，组内逐对象复核由执行器负责。 */
  readonly subjectCheck?: (tx: Tx, adjustment: AdjustmentHead) => Promise<boolean>;
  /** 测试钩子：抛错即模拟在该点崩溃。 */
  readonly hooks?: {
    readonly afterGroup?: (group: ExecutionGroup) => Promise<void> | void;
    readonly beforeFinalize?: (adjustmentId: string) => Promise<void> | void;
  };
}

export interface TenantRunResult {
  readonly claimed: boolean;
  readonly completed: readonly string[];
  readonly stopped?: 'fencing' | 'retry';
}

interface Run {
  readonly db: Db;
  readonly lease: RunnerLease;
  readonly options: RunnerOptions;
  readonly adjustment: AdjustmentHead;
  readonly commandId: string;
}

const failed = (reason: string, message: string) => ({ reason, message });
type Failure = ReturnType<typeof failed>;

export async function runOrgAdjustmentTenant(
  db: Db,
  tenant: TenantRow,
  clock: () => Date,
  options: RunnerOptions = {},
): Promise<TenantRunResult> {
  const lease = await claimOrgAdjustmentRunner(
    db,
    tenant.id,
    options.holderToken ?? PROCESS_HOLDER_TOKEN,
    clock,
    options.leaseMs,
  );
  if (!lease) return { claimed: false, completed: [] };
  const completed: string[] = [];
  try {
    for (;;) {
      const picked = await fenced(db, lease, (tx) => pickAdjustment(tx, tenant.id, tenant.timezone, clock()));
      if (!picked) {
        await releaseRunner(db, lease);
        return { claimed: true, completed };
      }
      const adjustment = await withTenant(db, tenant.id, (tx) =>
        loadAdjustmentHead(tx, tenant.id, picked.adjustment_id),
      );
      const run = { db, lease, options, adjustment, commandId: `org-adjustment:${adjustment.id}` };
      await fenced(db, lease, (tx) => (picked.state === 'pending' ? start(tx, run) : audit(tx, run, 'takeover', {})));
      if (!(await runGroups(run))) return { claimed: true, completed, stopped: 'retry' };
      await options.hooks?.beforeFinalize?.(adjustment.id);
      await fenced(db, lease, (tx) => finalize(tx, run));
      completed.push(adjustment.id);
    }
  } catch (error) {
    if (error instanceof FencingLost) return { claimed: true, completed, stopped: 'fencing' };
    throw error;
  }
}

/** §7.6A：锁序 ⓪ → ③ 本单行 → ④ 组织设置；按当前树重算 S′，扩大的组记 SCOPE_CHANGED，暂停行 = 其余组 S′ 之并。 */
async function start(tx: Tx, run: Run) {
  const { tenantId } = run.lease;
  const { id, effectiveDate } = run.adjustment;
  await tx.execute(sql`SELECT id FROM org_adjustments WHERE tenant_id=${tenantId} AND id=${id}::uuid FOR UPDATE`);
  await lockOrganizationSettings(tx, tenantId);
  const allowed = (await run.options.subjectCheck?.(tx, run.adjustment)) ?? true;
  const items = await loadExecutionItems(tx, tenantId, id);
  const scope = rowsOf<{ group_item_id: string; org_id: string }>(
    await tx.execute(sql`SELECT group_item_id, org_id FROM org_adjustment_scope_orgs
      WHERE tenant_id=${tenantId} AND adjustment_id=${id}::uuid`),
  );
  const paused = new Set<string>();
  for (const group of await loadExecutionGroups(tx, tenantId, id, effectiveDate)) {
    if (!allowed) {
      await failGroup(tx, run, group, failed('APPLICANT_OUT_OF_SCOPE', '申请人已无权调整该组织'));
      continue;
    }
    const approved = new Set(scope.filter((s) => s.group_item_id === group.id).map((s) => s.org_id));
    const actual = await groupScope(tx, tenantId, group, items, effectiveDate);
    if (actual.some((orgId) => !approved.has(orgId)))
      await failGroup(tx, run, group, failed('SCOPE_CHANGED', '审批后涉及组织范围已扩大，请另起单据'));
    else actual.forEach((orgId) => paused.add(orgId));
  }
  for (const orgId of paused)
    await tx.execute(sql`INSERT INTO org_adjustment_pauses(tenant_id, org_id, adjustment_id)
      VALUES (${tenantId}, ${orgId}::uuid, ${id}::uuid)`);
  const now = run.lease.clock().toISOString();
  await tx.execute(sql`UPDATE org_adjustment_executions SET state='running', started_at=${now}
    WHERE tenant_id=${tenantId} AND adjustment_id=${id}::uuid`);
  await tx.execute(sql`UPDATE org_adjustments SET execution_status=3, revision=revision+1, updated_at=${now}
    WHERE tenant_id=${tenantId} AND id=${id}::uuid`);
  await tx.execute(sql`UPDATE org_adjustment_tenant_runners SET current_adjustment_id=${id}::uuid
    WHERE tenant_id=${tenantId}`);
  await audit(tx, run, 'started', { pausedOrgIds: [...paused].sort() });
}

/** 串行推进各组；返回 false 表示本刻停止（可恢复失败未满次数），下一刻重试同一组。 */
async function runGroups(run: Run): Promise<boolean> {
  const { db, lease, adjustment } = run;
  const groups = await withTenant(db, lease.tenantId, (tx) =>
    loadExecutionGroups(tx, lease.tenantId, adjustment.id, adjustment.effectiveDate),
  );
  const results = new Map<string, number | null>();
  for (const group of groups) {
    if (group.items.every((item) => item.execPhase === 2)) {
      group.items.forEach((item) => results.set(item.id, item.executionResult));
      continue;
    }
    const outcome = await runGroup(run, group, results);
    if (outcome === 'retry') return false;
    group.items.forEach((item) => results.set(item.id, outcome === 'done' ? 1 : 2));
    await run.options.hooks?.afterGroup?.(group);
  }
  return true;
}

async function runGroup(run: Run, group: ExecutionGroup, results: ReadonlyMap<string, number | null>) {
  const refs = group.items.flatMap((item) => [item.parentItemId, item.transferToItemId]);
  const external = refs.filter((ref): ref is string => !!ref && !group.items.some((item) => item.id === ref));
  if (external.some((ref) => results.get(ref) !== 1))
    return recordFailure(run, group, failed('DEPENDENCY_FAILED', '所依赖的同单明细未执行成功'));
  const executor = run.options.executors?.[group.lead.adjustType];
  if (!executor) return recordFailure(run, group, failed('EXECUTOR_NOT_AVAILABLE', '该类明细的执行器尚未接入'));
  try {
    for (;;) {
      const outcome = await fenced(run.db, run.lease, async (tx) => {
        const result = await executor(tx, { adjustment: run.adjustment, group, commandId: run.commandId });
        if (result === 'done') await succeedGroup(tx, run, group);
        return result;
      });
      if (outcome === 'done') return 'done' as const;
    }
  } catch (error) {
    if (error instanceof FencingLost) throw error;
    if (error instanceof AppError && error.status < 500) {
      const details = (error.details ?? {}) as { reason?: string };
      return recordFailure(run, group, failed(details.reason ?? error.code, error.message));
    }
    return recordRetry(run, group, error);
  }
}

async function recordFailure(run: Run, group: ExecutionGroup, failure: Failure) {
  await fenced(run.db, run.lease, (tx) => failGroup(tx, run, group, failure));
  return 'failed' as const;
}

/** §7.7 可恢复失败：独立短事务累计次数；满 5 次记 EXECUTION_ERROR 并继续后续组，保证暂停能解除。 */
async function recordRetry(run: Run, group: ExecutionGroup, error: unknown) {
  const { tenantId } = run.lease;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const attempts = await fenced(run.db, run.lease, async (tx) => {
    const [row] = rowsOf<{ attempts: number }>(
      await tx.execute(sql`INSERT INTO org_adjustment_group_attempts
          (tenant_id, adjustment_id, group_item_id, attempts, last_error, updated_at)
        VALUES (${tenantId}, ${run.adjustment.id}::uuid, ${group.id}::uuid, 1, ${message},
          ${run.lease.clock().toISOString()})
        ON CONFLICT (tenant_id, adjustment_id, group_item_id) DO UPDATE
          SET attempts=org_adjustment_group_attempts.attempts+1, last_error=EXCLUDED.last_error,
            updated_at=EXCLUDED.updated_at
        RETURNING attempts`),
    );
    await audit(tx, run, 'group.retry', { groupItemId: group.id, attempts: row!.attempts });
    return row!.attempts;
  });
  if (attempts < MAX_GROUP_ATTEMPTS) return 'retry' as const;
  return recordFailure(run, group, failed('EXECUTION_ERROR', '多次执行出错，已停止重试'));
}

async function succeedGroup(tx: Tx, run: Run, group: ExecutionGroup) {
  // 执行器可先写逐行结果（如 EMPLOYMENT_PARTIAL，§7.5）；未写的行记成功。
  await tx.execute(sql`UPDATE org_adjustment_org_items SET execution_result=coalesce(execution_result, 1), exec_phase=2
    WHERE tenant_id=${run.lease.tenantId} AND id=ANY(${idsOf(group)}::uuid[])`);
  await audit(tx, run, 'group.succeeded', { groupItemId: group.id });
}

async function failGroup(tx: Tx, run: Run, group: ExecutionGroup, failure: Failure) {
  await tx.execute(sql`UPDATE org_adjustment_org_items SET execution_result=2, exec_phase=2,
      execution_reason=${failure.reason}, execution_message=${failure.message}
    WHERE tenant_id=${run.lease.tenantId} AND id=ANY(${idsOf(group)}::uuid[])`);
  await audit(tx, run, 'group.failed', { groupItemId: group.id, ...failure });
}

const idsOf = (group: ExecutionGroup) => `{${group.items.map((item) => item.id).join(',')}}`;

/** §7.8 收尾：N / M 按非暂存行计；删暂停、队列 done、站内消息通知申请人（模板 OrgAdjustmentExecuted）。 */
async function finalize(tx: Tx, run: Run) {
  const { tenantId, clock } = run.lease;
  const { id, createdBy } = run.adjustment;
  await tx.execute(sql`SELECT id FROM org_adjustments WHERE tenant_id=${tenantId} AND id=${id}::uuid FOR UPDATE`);
  await lockOrganizationSettings(tx, tenantId);
  const items = await loadExecutionItems(tx, tenantId, id);
  const success = items.filter((item) => item.executionResult === 1).length;
  const failure = items.length - success;
  const now = clock();
  await tx.execute(sql`UPDATE org_adjustments SET execution_status=2, success_count=${success},
      failure_count=${failure}, execution_note=${`成功执行${success}个调整，失败${failure}个调整`},
      executed_at=${now.toISOString()}, revision=revision+1, updated_at=${now.toISOString()}
    WHERE tenant_id=${tenantId} AND id=${id}::uuid`);
  await tx.execute(sql`DELETE FROM org_adjustment_pauses WHERE tenant_id=${tenantId} AND adjustment_id=${id}::uuid`);
  await tx.execute(sql`UPDATE org_adjustment_executions SET state='done', finished_at=${now.toISOString()}
    WHERE tenant_id=${tenantId} AND adjustment_id=${id}::uuid`);
  await tx.execute(sql`UPDATE org_adjustment_tenant_runners SET current_adjustment_id=NULL
    WHERE tenant_id=${tenantId}`);
  await audit(tx, run, 'completed', { successCount: success, failureCount: failure });
  const instance = await latestInstanceOf(tx, tenantId, 'org_adjustment', id);
  // 审批接入（BE-10c）前没有实例：消息须挂在实例上，无实例时不发（结果文件“未决 / 假设”）。
  if (instance) {
    const ctx = { tenantId, userId: SYSTEM_USER_ID, timezone: 'UTC', now, commandId: run.commandId };
    await notifyMessage(tx, schedulerAwareContext({ ...ctx, expectedRevision: 0 }), instance, {
      recipientUserId: createdBy,
      templateCode: 'OrgAdjustmentExecuted',
    });
  }
}

async function audit(tx: Tx, run: Run, action: string, after: Record<string, unknown>) {
  await recordAudit(tx, {
    tenantId: run.lease.tenantId,
    actorUserId: null,
    action: `org-adjustment.execution.${action}`,
    objectType: 'org-adjustment',
    objectId: run.adjustment.id,
    before: null,
    after: { trigger: run.commandId, fencingNo: run.lease.fencingNo, ...after },
    commandId: run.commandId,
    occurredAt: run.lease.clock(),
  });
}

/** 定时器每个时间槽调用一次（activation-scheduler.ts runSlot）；出错只上报，不影响其他租户与定时生效。 */
export async function runOrgAdjustmentSlot(
  db: Db,
  clock: () => Date,
  onError: (error: unknown) => void,
  options: RunnerOptions = {},
): Promise<void> {
  try {
    for await (const tenant of activeTenants(db, null))
      await runOrgAdjustmentTenant(db, tenant, clock, options).catch(onError);
  } catch (error) {
    onError(error);
  }
}
