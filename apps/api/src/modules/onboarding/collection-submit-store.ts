import {
  and,
  desc,
  employmentBusinessObjects as businesses,
  eq,
  onboardingCollectionSubmissions as submissions,
  onboardingCollectionTasks as tasks,
  onboardingEntryCases as cases,
  type OnboardingCollectionTask,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { entryCaseContext } from '../employment/entry-case.js';
import { lockEmploymentBusiness, lockEmploymentEmployee } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { auditTask } from './collection-tasks.js';

export const taskFilter = (tenantId: string, taskId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId));

export function staleCollection(): never {
  throw new AppError('REVISION_CONFLICT', '采集任务或待入职资料已变更，请刷新后重提', {
    reason: 'COLLECTION_BASELINE_CHANGED',
  });
}

export async function collectionBinding(tx: Tx, tenantId: string, taskId: string) {
  const [binding] = await tx
    .select({ task: tasks, stage: cases, businessRevision: businesses.revision })
    .from(tasks)
    .innerJoin(cases, and(eq(cases.tenantId, tasks.tenantId), eq(cases.id, tasks.caseId)))
    .innerJoin(businesses, and(eq(businesses.tenantId, cases.tenantId), eq(businesses.id, cases.currentBusinessId)))
    .where(taskFilter(tenantId, taskId));
  if (!binding) throw new AppError('NOT_FOUND', '采集任务不存在');
  return binding;
}

/** 审批入口先锁当前同人业务与阶段，再锁任务。历史详情只需 collectionBinding。 */
export async function lockCollectionBinding(tx: Tx, ctx: EmploymentContext, taskId: string) {
  const peek = await collectionBinding(tx, ctx.tenantId, taskId);
  await lockEmploymentEmployee(tx, ctx, peek.stage.employeeId);
  const current = await collectionBinding(tx, ctx.tenantId, taskId);
  const business = await lockEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: current.businessRevision },
    current.stage.currentBusinessId,
  );
  const [stage] = await tx
    .select()
    .from(cases)
    .where(and(eq(cases.tenantId, ctx.tenantId), eq(cases.id, peek.stage.id)))
    .for('update');
  if (!stage || stage.currentBusinessId !== business.id) return staleCollection();
  const [task] = await tx.select().from(tasks).where(taskFilter(ctx.tenantId, taskId)).for('update');
  if (!task) return staleCollection();
  return { stage, task, business };
}

export async function latestCollectionSubmission(tx: Tx, tenantId: string, taskId: string) {
  const [submitted] = await tx
    .select()
    .from(submissions)
    .where(and(eq(submissions.tenantId, tenantId), eq(submissions.taskId, taskId), eq(submissions.kind, 'submit')))
    .orderBy(desc(submissions.version))
    .limit(1);
  if (!submitted) throw new AppError('NOT_FOUND', '采集提交不存在');
  return submitted;
}

export async function updateCollectionLanding(
  tx: Tx,
  ctx: EmploymentContext,
  stage: OnboardingEntryCase,
  task: OnboardingCollectionTask,
  status: OnboardingCollectionTask['status'],
  submissionId: string,
  action: string,
) {
  const [updated] = await tx
    .update(tasks)
    .set({
      status,
      revision: task.revision + 1,
      updatedAt: ctx.now,
      updatedBy: auditActor(ctx.userId),
      ...(action === 'submit' ? { submittedAt: ctx.now } : {}),
      ...(status === 'completed' ? { completedAt: ctx.now, nextRemindOn: null } : {}),
    })
    .where(taskFilter(ctx.tenantId, task.id))
    .returning();
  if (!updated) return staleCollection();
  await auditTask(
    tx,
    entryCaseContext(ctx),
    stage,
    action,
    task,
    { status: task.status, revision: task.revision },
    { status, revision: updated.revision, submissionId },
  );
  return updated;
}
