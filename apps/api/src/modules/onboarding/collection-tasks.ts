import {
  ACTIVE_COLLECTION_TASK_STATES,
  and,
  desc,
  eq,
  inArray,
  onboardingCollectionComments as comments,
  onboardingCollectionTasks as tasks,
  type OnboardingCollectionTask,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { ENTRY_STATUS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { lockPendingEntry } from '../employment/employee-status.js';
import { entryCaseContext } from '../employment/entry-case.js';
import {
  entryLifecyclePort,
  type EntryCaseWriteRef,
  type EntryLifecycleContext,
} from '../employment/onboarding-entry-port.js';
import type { EmploymentContext } from '../employment/types.js';
import { matchEntryCollection } from './collection-config-match.js';

export type CollectionAction = 'start' | 'remind' | 'comments';

const taskByCase = (tenantId: string, caseId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.caseId, caseId));
const taskById = (tenantId: string, id: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.id, id));

export async function loadCollectionTask(tx: Tx, tenantId: string, caseId: string) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(taskByCase(tenantId, caseId))
    .orderBy(desc(inArray(tasks.status, ACTIVE_COLLECTION_TASK_STATES)), desc(tasks.createdAt), desc(tasks.id))
    .limit(1);
  return task;
}

export async function readCollectionComments(
  tx: Tx,
  tenantId: string,
  taskId: string,
  page: {
    limit: number;
    offset: number;
  },
) {
  return tx
    .select({ id: comments.id, text: comments.text, authorId: comments.authorId, createdAt: comments.createdAt })
    .from(comments)
    .where(and(eq(comments.tenantId, tenantId), eq(comments.taskId, taskId)))
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(page.limit)
    .offset(page.offset);
}

export async function auditTask(
  tx: Tx,
  ctx: EntryLifecycleContext,
  stage: OnboardingEntryCase,
  action: string,
  task: OnboardingCollectionTask,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.collection_task.${action}`,
    objectType: 'onboarding-collection-task',
    objectId: task.id,
    scope: { employeeId: stage.employeeId },
    before,
    after,
    occurredAt: ctx.now,
    commandId: ctx.commandId,
  });
}

export async function lockCollectionEntry(tx: Tx, ctx: EmploymentContext, ref: EntryCaseWriteRef) {
  const { record } = await lockPendingEntry(tx, { ...ctx, expectedRevision: ref.businessRevision }, ref.businessId);
  const stage = await entryLifecyclePort().lockForWrite(tx, entryCaseContext(ctx), ref, ['pending']);
  if (record.entryStatus === ENTRY_STATUS.cancelled)
    throw new AppError('CONFLICT', '已取消的待入职不能操作采集任务', { reason: 'ENTRY_CANCELLED' });
  return stage;
}

export function collectionReceipt(task: OnboardingCollectionTask) {
  return { id: task.id, revision: task.revision, status: task.status, notificationStatus: 'unavailable' as const };
}

/** 锁内读取当前任职、阶段、规则。人工和创建作业共享这条任务创建路径。 */
export async function startCollection(tx: Tx, ctx: EmploymentContext, ref: EntryCaseWriteRef, mode: 'auto' | 'manual') {
  const stage = await lockCollectionEntry(tx, ctx, ref);
  const previous = await loadCollectionTask(tx, ctx.tenantId, stage.id);
  if (previous && previous.status !== 'closed' && previous.status !== 'withdrawn') {
    if (mode === 'manual' && ctx.expectedRevision !== previous.revision)
      throw new AppError('REVISION_CONFLICT', '已存在采集任务，请刷新后重提');
    return { status: 'existing' as const, task: previous };
  }
  if (mode === 'manual' && ctx.expectedRevision !== 0)
    throw new AppError('REVISION_CONFLICT', '采集任务已变更，请刷新后重提');
  const matched = await matchEntryCollection(tx, ctx, ref, mode);
  if (matched.status === 'skipped') return matched;
  const actor = auditActor(ctx.userId);
  const [task] = await tx
    .insert(tasks)
    .values({
      tenantId: ctx.tenantId,
      caseId: stage.id,
      templateId: matched.template.id,
      ruleId: matched.rule.id,
      templateRevision: matched.template.revision,
      ruleRevision: matched.rule.revision,
      fields: matched.fields.map((field, position) => ({ ...field, position })),
      requiredSubsets: matched.requiredSubsets,
      verificationMode: matched.rule.verificationMode,
      requiresApproval: matched.rule.requiresApproval,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      createdBy: actor,
      updatedBy: actor,
    })
    .returning();
  await auditTask(tx, entryCaseContext(ctx), stage, 'start', task!, null, {
    status: task!.status,
    ruleId: task!.ruleId,
    templateId: task!.templateId,
    revision: task!.revision,
  });
  return { status: 'created' as const, task: task! };
}

export async function changeCollectionTask(
  tx: Tx,
  ctx: EmploymentContext,
  ref: EntryCaseWriteRef,
  action: 'remind' | 'comments',
  text: string,
) {
  const stage = await lockCollectionEntry(tx, ctx, ref);
  const task = await loadCollectionTask(tx, ctx.tenantId, stage.id);
  if (!task || !ACTIVE_COLLECTION_TASK_STATES.some((status) => status === task.status))
    throw new AppError('CONFLICT', '没有可操作的采集任务', { reason: 'COLLECTION_TASK_NOT_ACTIVE' });
  if (task.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '采集任务已变更，请刷新后重提');
  if (action === 'remind')
    throw new AppError('CONFLICT', '候选人采集通知通道尚未开放', { reason: 'COLLECTION_CHANNEL_UNAVAILABLE' });
  await tx
    .insert(comments)
    .values({ tenantId: ctx.tenantId, taskId: task.id, authorId: ctx.userId, text, createdAt: ctx.now });
  const [updated] = await tx
    .update(tasks)
    .set({ revision: task.revision + 1, updatedAt: ctx.now, updatedBy: ctx.userId })
    .where(taskById(ctx.tenantId, task.id))
    .returning();
  await auditTask(
    tx,
    entryCaseContext(ctx),
    stage,
    'comment',
    task,
    { revision: task.revision },
    { comment: text, revision: updated!.revision },
  );
  return collectionReceipt(updated!);
}

export async function closeCollectionTasks(tx: Tx, ctx: EntryLifecycleContext, stage: OnboardingEntryCase) {
  const task = await loadCollectionTask(tx, ctx.tenantId, stage.id);
  if (!task || !ACTIVE_COLLECTION_TASK_STATES.some((status) => status === task.status)) return;
  const revision = task.revision + 1;
  await tx
    .update(tasks)
    .set({
      status: 'closed',
      revision,
      nextRemindOn: null,
      updatedAt: ctx.now,
      updatedBy: ctx.userId,
    })
    .where(taskById(ctx.tenantId, task.id));
  await auditTask(
    tx,
    ctx,
    stage,
    'close',
    task,
    { status: task.status, revision: task.revision },
    { status: 'closed', revision },
  );
}
