import {
  and,
  asc,
  eq,
  inArray,
  lte,
  employmentBusinessObjects as businesses,
  onboardingCollectionJobs as jobs,
  onboardingEntryCases as cases,
  withTenant,
  type Db,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { activeTenants } from '../employment/active-tenants.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import type { EntryLifecycleContext } from '../employment/onboarding-entry-port.js';
import { startCollection } from './collection-tasks.js';

const unfinished = inArray(jobs.status, ['pending', 'failed']);
const jobKey = (tenantId: string, caseId: string) => and(eq(jobs.tenantId, tenantId), eq(jobs.caseId, caseId));
const BATCH_SIZE = 100;

export async function enqueueCollectionCreation(tx: Tx, ctx: EntryLifecycleContext, stage: OnboardingEntryCase) {
  await tx
    .insert(jobs)
    .values({
      tenantId: ctx.tenantId,
      caseId: stage.id,
      nextAttemptAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing();
}

export async function retireCollectionCreation(tx: Tx, ctx: EntryLifecycleContext, stage: OnboardingEntryCase) {
  await tx
    .update(jobs)
    .set({ status: 'skipped', reason: 'ENTRY_CASE_CLOSED', updatedAt: ctx.now })
    .where(and(jobKey(ctx.tenantId, stage.id), unfinished));
}

async function creationTargets(tx: Tx, tenantId: string, now: Date) {
  return tx
    .select({ id: jobs.caseId, employeeId: cases.employeeId })
    .from(jobs)
    .innerJoin(cases, and(eq(cases.tenantId, jobs.tenantId), eq(cases.id, jobs.caseId)))
    .where(and(eq(jobs.tenantId, tenantId), unfinished, lte(jobs.nextAttemptAt, now)))
    .orderBy(asc(jobs.nextAttemptAt), asc(jobs.caseId))
    .limit(BATCH_SIZE);
}

function jobFailure(error: unknown, ctx: EmploymentContext, attempts: number) {
  if (error instanceof AppError) {
    const reason = (error.details as { reason?: string } | undefined)?.reason;
    if (reason === 'NOT_PENDING_ENTRY' || reason === 'ENTRY_CANCELLED') return { status: 'skipped' as const, reason };
    if (reason === 'COLLECTION_RULE_AMBIGUOUS') return { status: 'skipped' as const, reason };
  }
  return {
    status: 'failed' as const,
    reason: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
    nextAttemptAt: new Date(ctx.now.getTime() + Math.min(60_000 * 2 ** (attempts - 1), 3_600_000)),
  };
}

async function consumeCreation(tx: Tx, ctx: EmploymentContext, target: { id: string; employeeId: string }) {
  // 领取之前先锁员工。取消、替换、完成与人工发起也在该锁下持有阶段。
  await lockEmploymentEmployee(tx, ctx, target.employeeId);
  const key = jobKey(ctx.tenantId, target.id);
  const [job] = await tx
    .select()
    .from(jobs)
    .where(and(key, unfinished, lte(jobs.nextAttemptAt, ctx.now)))
    .for('update');
  if (!job) return;
  const [stage] = await tx
    .select({
      caseId: cases.id,
      employeeId: cases.employeeId,
      businessId: cases.currentBusinessId,
      caseRevision: cases.revision,
      businessRevision: businesses.revision,
    })
    .from(cases)
    .innerJoin(
      businesses,
      and(
        eq(businesses.tenantId, cases.tenantId),
        eq(businesses.id, cases.currentBusinessId),
        eq(businesses.employeeId, cases.employeeId),
      ),
    )
    .where(and(eq(cases.tenantId, ctx.tenantId), eq(cases.id, target.id), eq(cases.state, 'pending')));
  const attempts = job.attempts + 1;
  const outcome = await tx
    .transaction(async (nested) => {
      if (!stage) return { status: 'skipped' as const, reason: 'ENTRY_CASE_CLOSED' };
      const result = await startCollection(nested, ctx, stage, 'auto');
      return result.status === 'skipped'
        ? { status: 'skipped' as const, reason: result.reason }
        : { status: 'done' as const, reason: null };
    })
    .catch((error: unknown) => jobFailure(error, ctx, attempts));
  await tx
    .update(jobs)
    .set({ ...outcome, attempts, updatedAt: ctx.now })
    .where(key);
}

export async function runCollectionCreationSlot(db: Db, clock: () => Date, onError: (error: unknown) => void) {
  for await (const tenant of activeTenants(db, null)) {
    const targets = await withTenant(db, tenant.id, (tx) => creationTargets(tx, tenant.id, clock()));
    for (const target of targets) {
      const ctx = {
        tenantId: tenant.id,
        timezone: tenant.timezone,
        userId: SYSTEM_USER_ID,
        now: clock(),
        commandId: `be16-collection:${target.id}`,
        expectedRevision: 0,
      };
      try {
        await withTenant(db, tenant.id, (tx) => consumeCreation(tx, ctx, target));
      } catch {
        onError(new Error('采集创建作业事务未确认，下一轮按队列状态恢复'));
      }
    }
  }
}
