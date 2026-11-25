import {
  and,
  eq,
  onboardingCollectionSubmissions as submissions,
  onboardingCollectionTasks as tasks,
  type CollectionSubmissionValues,
  type OnboardingCollectionSubmission,
  type OnboardingCollectionTask,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { tenantLocalDate } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { ApprovalContext } from '../approval/context.js';
import { startOrResume } from '../approval/engine.js';
import { lockPendingEntry } from '../employment/employee-status.js';
import type { EntryCaseWriteRef } from '../employment/onboarding-entry-port.js';
import { matchRehire, rehireMatchInput } from '../employment/rehire-match.js';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { COLLECTION, requireCollectionTarget, requireCollectionWrite } from './collection-access.js';
import { matchEntryCollection } from './collection-config-match.js';
import { checkCollectionValues, decodeCollectionValues, landCollectionValues } from './collection-submit-fields.js';
import { collectionBinding, staleCollection, taskFilter, updateCollectionLanding } from './collection-submit-store.js';
import { collectionReceipt, lockCollectionEntry } from './collection-tasks.js';

export interface CollectionSubmissionContext extends EmploymentContext {
  readonly authorize: Authorizer;
  readonly approvalFields?: ApprovalContext['fields'];
}

interface SubmissionRef extends EntryCaseWriteRef {
  readonly taskId: string;
}

type CurrentBinding = { stage: OnboardingEntryCase; task: OnboardingCollectionTask };

async function requireSubmitTarget(tx: Tx, ctx: CollectionSubmissionContext, businessId: string) {
  const authorize = authorizeInTransaction(ctx.authorize, tx);
  for (const objectCode of [EMPLOYMENT_OBJECT, COLLECTION]) {
    await requireObjectWrite(authorize, ctx, { objectCode, operation: 'update', payload: {} });
  }
  const target = await requireCollectionTarget(
    tx,
    { authorize: ctx.authorize, clock: () => ctx.now },
    ctx,
    businessId,
    'write',
  );
  if (!target.pending) return staleCollection();
}

async function inspectSubmission(
  tx: Tx,
  ctx: CollectionSubmissionContext,
  ref: EntryCaseWriteRef,
  task: OnboardingCollectionTask,
  values: CollectionSubmissionValues,
  submitting: boolean,
) {
  const { record, business } = await lockPendingEntry(
    tx,
    { ...ctx, expectedRevision: ref.businessRevision },
    ref.businessId,
  );
  const matched = await matchEntryCollection(tx, ctx, ref, 'manual');
  if (matched.status !== 'matched' || matched.rule.id !== task.ruleId || matched.template.id !== task.templateId)
    return staleCollection();
  const person = await checkCollectionValues(
    tx,
    ctx,
    ctx.authorize,
    ref.employeeId,
    business.employee.name,
    task,
    matched.fields,
    values,
    submitting,
  );
  return { departmentId: record.fields.departmentId!, person };
}

async function needsRehireReview(tx: Tx, ctx: EmploymentContext, person: Record<string, unknown>) {
  if (!person.idNumber) return false;
  if (!person.idType)
    throw new AppError('VALIDATION_FAILED', '采集证件号须有证件类型', { reason: 'COLLECTION_ID_TYPE_REQUIRED' });
  const keys = rehireMatchInput.safeParse({ idType: person.idType, idNumber: person.idNumber });
  if (!keys.success) throw new AppError('VALIDATION_FAILED', '采集证件信息不合法');
  try {
    return Boolean(await matchRehire(tx, ctx.tenantId, keys.data, tenantLocalDate(ctx.now, ctx.timezone)));
  } catch (error) {
    // 多人命中同样留人事复核。候选回执与待办都不透露离职档案标识或命中数。
    if (
      error instanceof AppError &&
      (error.details as { reason?: string } | undefined)?.reason === 'REHIRE_MATCH_AMBIGUOUS'
    )
      return true;
    throw error;
  }
}

async function launchCollectionApproval(tx: Tx, ctx: CollectionSubmissionContext, task: OnboardingCollectionTask) {
  const instance = await startOrResume(
    tx,
    {
      ...ctx,
      systemProxy: true,
      handlingAuthorize: ctx.authorize,
      ...(ctx.approvalFields ? { fields: ctx.approvalFields } : {}),
    },
    { businessType: 'entry_info_collection', businessId: task.id },
  );
  if (instance.status !== 'running')
    throw new AppError('CONFLICT', '采集审批需要有效的首节点办理人', { reason: 'COLLECTION_APPROVER_REQUIRED' });
  await tx.update(tasks).set({ approvalInstanceId: instance.id }).where(taskFilter(ctx.tenantId, task.id));
}

/** R2-T01 §4.1。仅由受信调用方在本租户命令事务内调用，失败须回滚整笔事务。 */
async function writeSubmission(
  tx: Tx,
  ctx: CollectionSubmissionContext,
  ref: SubmissionRef,
  raw: unknown,
  kind: 'draft' | 'submit',
) {
  await requireSubmitTarget(tx, ctx, ref.businessId);
  const stage = await lockCollectionEntry(tx, ctx, ref);
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(taskFilter(ctx.tenantId, ref.taskId), eq(tasks.caseId, stage.id)))
    .for('update');
  if (!task || task.revision !== ctx.expectedRevision) return staleCollection();
  if (!['ready', 'sent', 'draft', 'returned'].includes(task.status))
    throw new AppError('CONFLICT', '当前状态不能填写采集', { reason: 'COLLECTION_TASK_NOT_WRITABLE' });
  const values = decodeCollectionValues(raw);
  const { departmentId, person } = await inspectSubmission(tx, ctx, ref, task, values, kind === 'submit');
  const rehire = kind === 'submit' && (await needsRehireReview(tx, ctx, person));
  const status =
    kind === 'draft' ? 'draft' : rehire ? 'rehire_pending' : task.requiresApproval ? 'in_review' : 'completed';
  const [written] = await tx
    .insert(submissions)
    .values({
      tenantId: ctx.tenantId,
      taskId: task.id,
      departmentId,
      pendingDate: stage.pendingDate,
      kind,
      values,
      employeeId: stage.employeeId,
      businessId: ref.businessId,
      businessRevision: ref.businessRevision,
      caseRevision: ref.caseRevision,
      version: task.revision + 1,
      createdBy: ctx.userId,
      createdAt: ctx.now,
    })
    .returning({ id: submissions.id });
  const updated = await updateCollectionLanding(tx, ctx, stage, task, status, written!.id, kind);
  if (status === 'completed')
    await landCollectionValues(tx, { ...ctx, authorizer: ctx.authorize }, stage.employeeId, task.id, values);
  if (status === 'in_review') await launchCollectionApproval(tx, ctx, updated);
  return collectionReceipt(updated);
}

export function saveDraft(tx: Tx, ctx: CollectionSubmissionContext, ref: SubmissionRef, payload: unknown) {
  return writeSubmission(tx, ctx, ref, payload, 'draft');
}

export function submit(tx: Tx, ctx: CollectionSubmissionContext, ref: SubmissionRef, payload: unknown) {
  return writeSubmission(tx, ctx, ref, payload, 'submit');
}

export async function landApprovedSubmission(
  tx: Tx,
  reviewer: EmploymentContext,
  authorize: Authorizer,
  { stage, task }: CurrentBinding,
  submitted: OnboardingCollectionSubmission,
) {
  const ref = {
    employeeId: stage.employeeId,
    caseId: stage.id,
    businessId: submitted.businessId,
    caseRevision: submitted.caseRevision,
    businessRevision: submitted.businessRevision,
  };
  const submitter = { ...reviewer, userId: submitted.createdBy, authorize };
  await requireSubmitTarget(tx, submitter, ref.businessId);
  await lockCollectionEntry(tx, submitter, ref);
  const values = decodeCollectionValues(submitted.values);
  const { person } = await inspectSubmission(tx, submitter, ref, task, values, true);
  if (await needsRehireReview(tx, submitter, person)) {
    await updateCollectionLanding(tx, reviewer, stage, task, 'rehire_pending', submitted.id, 'rehire');
    return;
  }
  await landCollectionValues(tx, { ...reviewer, authorizer: authorize }, stage.employeeId, task.id, values);
  await updateCollectionLanding(tx, reviewer, stage, task, 'completed', submitted.id, 'approve');
}

/** 待确认状态就是持久待办。读取时用既有重聘按钮和双对象范围判定，不提前发给固定人或租户全员。 */
export async function readCollectionRehireTodo(tx: Tx, ctx: CollectionSubmissionContext, taskId: string) {
  const deps = { authorize: ctx.authorize, clock: () => ctx.now };
  await requireCollectionWrite(tx, deps, ctx, 'rehire');
  const { task, stage } = await collectionBinding(tx, ctx.tenantId, taskId);
  const { pending } = await requireCollectionTarget(tx, deps, ctx, stage.currentBusinessId, 'write', false);
  if (!pending || task.status !== 'rehire_pending') throw new AppError('NOT_FOUND', '重聘待办不存在');
  return { id: task.id, revision: task.revision, status: task.status };
}
