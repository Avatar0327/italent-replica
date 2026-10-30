/** F-140b × F-261 × BE-8b：替代单确认时账号尚待恢复，保留发起意图；不在员工事务内改全局账号。 */
import { employmentOutbox, employmentOutboxAttempts, getTenant, sql, withTenant, type Db, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { userOfPerson } from '../approval/resolver.js';
import { lockEmploymentBusiness, lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { ExitConfirmedEvent } from './exit-confirmation.js';
import type { EmploymentContext } from './types.js';

const EVENT = 'employment.exit_handover.retry';
const BATCH = 100;
const unfinished = sql`NOT EXISTS (SELECT 1 FROM employment_outbox_attempts a
  WHERE a.tenant_id=o.tenant_id AND a.outbox_id=o.id AND a.state='sent')`;

/** 仅补偿本次替代与自动恢复相交的缺口；既有无账号审批不变，不扫描历史 skipped 审计（DEC-402）。 */
export async function queueExitHandoverRetry(tx: Tx, ctx: EmploymentContext, event: ExitConfirmedEvent) {
  // 自动停用凭据可能由另一租户持有；本单只声明恢复意图，恢复资格仍由 F-261 全局判定。
  const [source] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM exit_requests e
    JOIN exit_account_tasks a ON a.tenant_id=e.tenant_id AND a.business_id=e.supersedes_business_id
    WHERE e.tenant_id=${ctx.tenantId} AND e.business_id=${event.businessId}::uuid
      AND a.restore_requested`),
  );
  if (!source) return;
  const [existing] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_outbox
    WHERE tenant_id=${ctx.tenantId} AND business_id=${event.businessId}::uuid AND event_type=${EVENT}`),
  );
  if (existing) return;
  // 调用方已持员工锁，确认重入与消费均串行；outbox / attempts 都只追加。
  await tx.insert(employmentOutbox).values({
    tenantId: ctx.tenantId,
    employeeId: event.employeeId,
    businessId: event.businessId,
    objectType: 'exit-request',
    objectId: event.businessId,
    eventType: EVENT,
    payload: { approvedOn: tenantLocalDate(ctx.now, ctx.timezone) },
    commandId: ctx.commandId,
    createdAt: ctx.now,
  });
}

type Retry = { id: string; employeeId: string; businessId: string; approvedOn: string };
async function receipt(tx: Tx, ctx: EmploymentContext, id: string, state: 'sent' | 'failed', reason: string | null) {
  const [last] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT COALESCE(MAX(attempt_no),0)::int AS n
    FROM employment_outbox_attempts WHERE tenant_id=${ctx.tenantId} AND outbox_id=${id}::uuid`),
  );
  await tx.insert(employmentOutboxAttempts).values({
    tenantId: ctx.tenantId,
    outboxId: id,
    attemptNo: last!.n + 1,
    state,
    errorReason: reason,
    createdAt: ctx.now,
  });
}

async function consume(tx: Tx, ctx: EmploymentContext, item: Retry) {
  await lockEmploymentEmployee(tx, ctx, item.employeeId);
  const [pending] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM employment_outbox o
    WHERE o.tenant_id=${ctx.tenantId} AND o.id=${item.id}::uuid AND ${unfinished}`),
  );
  if (!pending) return;
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_business_objects
    WHERE tenant_id=${ctx.tenantId} AND id=${item.businessId}::uuid`),
  );
  const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: head!.revision }, item.businessId);
  if (
    !['approved', 'effective'].includes(business.state) ||
    business.payload.kind !== 'leave' ||
    business.payload.mode !== 'application'
  ) {
    await receipt(tx, ctx, item.id, 'sent', 'EXIT_NOT_CONFIRMED');
    return;
  }
  if (!(await userOfPerson(tx, ctx.tenantId, item.employeeId))) {
    await receipt(tx, ctx, item.id, 'failed', 'NO_INITIATOR_ACCOUNT');
    return;
  }
  // 当前账号/成员、当前开关/流程/交接处理人重新核对；“早于批准日”仍按原确认日判断，而非重试日。
  const { launchExitHandover } = await import('./exit-handover.js');
  const result = await launchExitHandover(
    tx,
    ctx,
    { businessId: item.businessId, employeeId: item.employeeId, kind: 'leave', mode: 'application', reEmployed: false },
    item.approvedOn,
  );
  const retry =
    result.outcome === 'failed' || (result.outcome === 'skipped' && result.reason === 'NO_INITIATOR_ACCOUNT');
  await receipt(tx, ctx, item.id, retry ? 'failed' : 'sent', 'reason' in result ? result.reason : null);
}

/** 账号消费者完成后再补发；进程中断仍由账号分钟调度/任职调度续跑。每页有界，待恢复项不挡住后页。 */
export async function drainExitHandoverRetries(db: Db, tenantId: string, now: Date) {
  const tenant = await getTenant(db, tenantId);
  if (!tenant || tenant.status !== 'active') return;
  let after: string | null = null;
  for (;;) {
    const items: Retry[] = await withTenant(db, tenantId, async (tx) =>
      rowsOf<Retry>(
        await tx.execute(sql`
      SELECT o.id, o.employee_id AS "employeeId", o.business_id AS "businessId",
        o.payload->>'approvedOn' AS "approvedOn"
      FROM employment_outbox o WHERE o.tenant_id=${tenantId} AND o.event_type=${EVENT} AND ${unfinished}
        AND (${after}::uuid IS NULL OR o.id>${after}::uuid) ORDER BY o.id LIMIT ${BATCH}`),
      ),
    );
    for (const item of items) {
      const ctx: EmploymentContext = {
        tenantId,
        timezone: tenant.timezone,
        now,
        userId: SYSTEM_USER_ID,
        expectedRevision: 0,
        commandId: `exit-handover-retry:${item.id}`,
      };
      try {
        await withTenant(db, tenantId, (tx) => consume(tx, ctx, item));
      } catch (error) {
        // 发起与成功回执同事务；失败回滚后另记次数/原因，单项失败不吞掉后页待办。
        await withTenant(db, tenantId, async (tx) => {
          await lockEmploymentEmployee(tx, ctx, item.employeeId);
          const [pending] = rowsOf(
            await tx.execute(sql`SELECT 1 FROM employment_outbox o
            WHERE o.tenant_id=${tenantId} AND o.id=${item.id}::uuid AND ${unfinished}`),
          );
          if (pending)
            await receipt(
              tx,
              ctx,
              item.id,
              'failed',
              error instanceof AppError ? error.code : 'EXIT_HANDOVER_RETRY_FAILED',
            );
        });
      }
    }
    if (items.length < BATCH) return;
    after = items.at(-1)!.id;
  }
}
