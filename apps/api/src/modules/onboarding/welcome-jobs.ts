/** 欢迎信作业（R2-T01 §8）：入职生效后入队，投递能力接入前只留队列状态，不把预览当发送。 */
import {
  and,
  asc,
  eq,
  inArray,
  lte,
  sql,
  onboardingEntryCases as cases,
  onboardingWelcomeJobs as jobs,
  onboardingWelcomeLetters as letters,
  withTenant,
  type Db,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { EMPLOYEE_STATUS, tenantLocalDate } from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { activeTenants } from '../employment/active-tenants.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import type { EntryLifecycleContext } from '../employment/onboarding-entry-port.js';

const unfinished = inArray(jobs.status, ['pending', 'failed']);
const jobKey = (tenantId: string, caseId: string) => and(eq(jobs.tenantId, tenantId), eq(jobs.caseId, caseId));
const BATCH_SIZE = 100;

/** 与「入职生效」同事务入队：回滚即无作业；同一入职阶段只入一次（主键 + onConflictDoNothing）。 */
export async function enqueueWelcomeLetter(tx: Tx, ctx: EntryLifecycleContext, stage: OnboardingEntryCase) {
  await tx
    .insert(jobs)
    .values({ tenantId: ctx.tenantId, caseId: stage.id, nextAttemptAt: ctx.now, updatedAt: ctx.now })
    .onConflictDoNothing();
}

function welcomeTargets(tx: Tx, tenantId: string, now: Date) {
  return tx
    .select({ id: jobs.caseId, employeeId: cases.employeeId })
    .from(jobs)
    .innerJoin(cases, and(eq(cases.tenantId, jobs.tenantId), eq(cases.id, jobs.caseId)))
    .where(and(eq(jobs.tenantId, tenantId), unfinished, lte(jobs.nextAttemptAt, now)))
    .orderBy(asc(jobs.nextAttemptAt), asc(jobs.caseId))
    .limit(BATCH_SIZE);
}

/**
 * §6.2：以租户业务日的当前任职复核原入职记录仍属当前有效周期。只看入职那条历史记录不够：离职 / 退休是
 * 时间线上追加的新版本，不会改动它；所以取业务日当天及以前最后一条，要求与入职记录同周期且状态仍在职。
 */
async function employmentStillCurrent(tx: Tx, ctx: EmploymentContext, employeeId: string, stage: OnboardingEntryCase) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const rows = await tx.execute(sql`
    SELECT 1 FROM employment_records hired,
      LATERAL (SELECT t.record_id, t.staff_id FROM employment_timeline t
        WHERE t.tenant_id = ${ctx.tenantId} AND t.employee_id = ${employeeId}::uuid AND t.start_date <= ${today}::date
        ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) cur,
      LATERAL employment_record_status(${ctx.tenantId}::uuid, cur.record_id) s
    WHERE hired.tenant_id = ${ctx.tenantId} AND hired.id = ${stage.hiredRecordId}::uuid
      AND hired.employee_id = ${employeeId}::uuid AND cur.staff_id = hired.staff_id
      AND s.employee_status IN (${EMPLOYEE_STATUS.probation}, ${EMPLOYEE_STATUS.regular})`);
  return rowsOf(rows).length > 0;
}

async function decide(tx: Tx, ctx: EmploymentContext, stage: OnboardingEntryCase | undefined) {
  if (!stage || stage.state !== 'hired' || !stage.hiredRecordId)
    return { status: 'skipped' as const, reason: 'ENTRY_CASE_CLOSED' };
  if (!(await employmentStillCurrent(tx, ctx, stage.employeeId, stage)))
    return { status: 'skipped' as const, reason: 'EMPLOYMENT_ENDED' };
  const [enabled] = await tx
    .select({ id: letters.id })
    .from(letters)
    .where(and(eq(letters.tenantId, ctx.tenantId), eq(letters.enabled, true), sql`${letters.archivedAt} IS NULL`));
  if (!enabled) return { status: 'skipped' as const, reason: 'WELCOME_NOT_CONFIGURED' };
  // 投递端口未接入：转内部待投递，退出定时扫描；绝不写 done，也不产生任何对外发送。
  return { status: 'awaiting_delivery' as const, reason: 'DELIVERY_ADAPTER_UNAVAILABLE' };
}

/** 员工锁与调度同强度（FOR NO KEY UPDATE），遇忙锁跳过而不等待：HR 事务持锁时不拖住共享调度。 */
async function tryLockEmployee(tx: Tx, tenantId: string, employeeId: string) {
  const rows = await tx.execute(sql`SELECT id FROM employment_employees
    WHERE tenant_id = ${tenantId} AND id = ${employeeId}::uuid FOR NO KEY UPDATE SKIP LOCKED`);
  return rowsOf(rows).length > 0;
}

async function consumeWelcome(tx: Tx, ctx: EmploymentContext, target: { id: string; employeeId: string }) {
  if (!(await tryLockEmployee(tx, ctx.tenantId, target.employeeId))) return;
  const key = jobKey(ctx.tenantId, target.id);
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(key, unfinished, lte(jobs.nextAttemptAt, ctx.now)))
    .for('update');
  if (!job) return;
  const [stage] = await tx
    .select()
    .from(cases)
    .where(and(eq(cases.tenantId, ctx.tenantId), eq(cases.id, target.id)));
  const outcome = await decide(tx, ctx, stage);
  await tx
    .update(jobs)
    .set({ ...outcome, attempts: job.attempts + 1, updatedAt: ctx.now })
    .where(key);
}

export async function runWelcomeLetterSlot(db: Db, clock: () => Date, onError: (error: unknown) => void) {
  for await (const tenant of activeTenants(db, null)) {
    const targets = await withTenant(db, tenant.id, (tx) => welcomeTargets(tx, tenant.id, clock()));
    for (const target of targets) {
      const ctx = {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        userId: SYSTEM_USER_ID,
        now: clock(),
        commandId: `be16-welcome:${target.id}`,
        expectedRevision: 0,
      };
      try {
        await withTenant(db, tenant.id, (tx) => consumeWelcome(tx, ctx, target));
      } catch {
        onError(new Error('欢迎信作业事务未确认，下一轮按队列状态恢复'));
      }
    }
  }
}
