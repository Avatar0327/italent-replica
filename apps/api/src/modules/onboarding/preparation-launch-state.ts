import {
  and,
  eq,
  sql,
  type Tx,
  type OnboardingEntryCase,
  onboardingPreparationAssignees as assignees,
  onboardingPreparationTasks as tasks,
} from '@italent/db';
import { notInArray } from 'drizzle-orm';
import { addDays, evaluateCondition, tenantLocalDate } from '@italent/domain';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { recordAudit } from '../../audit/record.js';
import { adminAncestors } from '../approval/resolver.js';
import { isPendingEntryRecord } from '../employment/employee-status.js';
import { loadPendingContract } from '../employment/entry-pending-contract.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import type { EntryLifecycleContext } from '../employment/onboarding-entry-port.js';
import type { EmploymentRecord } from '../employment/types.js';
import { employeeSnapshot } from '../personnel/employee-write.js';
import { resolvePreparationAssignees } from './preparation-launch-assignees.js';

export type PreparationTask = typeof tasks.$inferSelect;
type RuleSnapshot = PreparationTask['ruleSnapshot'];
export const preparationDay = (ctx: EntryLifecycleContext) => tenantLocalDate(ctx.now, ctx.timezone);
export const plannedStart = (
  task: Pick<PreparationTask, 'startDaysBefore'>,
  stage: OnboardingEntryCase,
  day: string,
) => (task.startDaysBefore === null ? day : addDays(stage.pendingDate, -task.startDaysBefore));
export const plannedReminder = (
  task: Pick<PreparationTask, 'remindDaysBefore'>,
  stage: OnboardingEntryCase,
  day: string,
) =>
  task.remindDaysBefore !== null && day <= stage.pendingDate
    ? [day, addDays(stage.pendingDate, -task.remindDaysBefore)].sort()[1]!
    : null;

export async function preparationFacts(tx: Tx, ctx: EntryLifecycleContext, record: EmploymentRecord) {
  const org = record.fields.departmentId;
  const orgs = org ? await adminAncestors(tx, ctx.tenantId, preparationDay(ctx), org) : [];
  const read = { ...ctx, userId: ctx.userId ?? SYSTEM_USER_ID, expectedRevision: 0 };
  const employee = await employeeSnapshot(tx, read, record.employeeId);
  const contract = await loadPendingContract(tx, read, record.id);
  const values = {
    'employee.gender': employee?.gender,
    'employee.idType': employee?.idType,
    'record.employType': record.fields.employType,
    'record.changeType': record.changeType,
    'contract.companyId': contract?.companyId,
  };
  return { orgs, values };
}

export function matchesPreparationRule(
  rule: Pick<RuleSnapshot, 'orgIds' | 'conditions'>,
  facts: Awaited<ReturnType<typeof preparationFacts>>,
) {
  return (
    rule.orgIds.some((id) => facts.orgs.includes(id)) &&
    evaluateCondition(rule.conditions, { values: facts.values, orgAncestors: {} }).result
  );
}

export async function auditPreparationTask(
  tx: Tx,
  ctx: EntryLifecycleContext,
  before: PreparationTask | null,
  after: PreparationTask,
  action: 'schedule' | 'open' | 'rebase' | 'close',
  beforeAssignees: string[],
  afterAssignees: string[],
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    occurredAt: ctx.now,
    commandId: ctx.commandId,
    objectType: 'onboarding-preparation-task',
    objectId: after.id,
    action: `onboarding.preparation.${action}`,
    before: before && { ...before, assignees: beforeAssignees },
    after: { ...after, assignees: afterAssignees },
  });
}

export async function syncPreparationAssignees(tx: Tx, ctx: EntryLifecycleContext, taskId: string, users: string[]) {
  const open = and(eq(assignees.tenantId, ctx.tenantId), eq(assignees.taskId, taskId), eq(assignees.status, 'open'));
  const previous = await tx.select({ id: assignees.userId }).from(assignees).where(open);
  await tx
    .update(assignees)
    .set({ status: 'revoked', endedAt: ctx.now })
    .where(and(open, users.length ? notInArray(assignees.userId, users) : undefined));
  if (users.length)
    await tx
      .insert(assignees)
      .values(
        users.map((userId) => ({
          tenantId: ctx.tenantId,
          taskId,
          userId,
          status: 'open' as const,
        })),
      )
      .onConflictDoUpdate({
        target: [assignees.tenantId, assignees.taskId, assignees.userId],
        set: { status: 'open', endedAt: null },
      });
  return previous.map(({ id }) => id).sort();
}

export async function updatePreparationTask(
  tx: Tx,
  ctx: EntryLifecycleContext,
  stage: OnboardingEntryCase,
  task: PreparationTask,
  status: 'scheduled' | 'open' | 'closed',
  users: string[],
  action: 'open' | 'rebase' | 'close',
) {
  const day = preparationDay(ctx);
  const [next] = await tx
    .update(tasks)
    .set({
      status,
      caseRevision: stage.revision,
      revision: task.revision + 1,
      updatedBy: ctx.userId,
      updatedAt: ctx.now,
      nextDueOn: status === 'scheduled' ? plannedStart(task, stage, day) : null,
      nextRemindOn: status === 'open' ? plannedReminder(task, stage, day) : null,
    })
    .where(and(eq(tasks.tenantId, ctx.tenantId), eq(tasks.id, task.id)))
    .returning();
  const before = await syncPreparationAssignees(tx, ctx, task.id, users);
  await auditPreparationTask(tx, ctx, task, next!, action, before, users);
  return next!;
}

export async function rebaseEntryPreparations(tx: Tx, ctx: EntryLifecycleContext, stage: OnboardingEntryCase) {
  const current = await tx
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.tenantId, ctx.tenantId), eq(tasks.caseId, stage.id), sql`${tasks.status} IN ('scheduled', 'open')`),
    )
    .for('update');
  if (!current.length) return;
  const day = preparationDay(ctx);
  const record =
    stage.state === 'pending' ? await loadEmploymentRecord(tx, ctx.tenantId, stage.currentBusinessId, day) : null;
  const facts = record && isPendingEntryRecord(record) ? await preparationFacts(tx, ctx, record) : null;
  for (const task of current) {
    let users: string[] = [];
    let status = task.status;
    if (!record || !facts || !matchesPreparationRule(task.ruleSnapshot, facts)) status = 'closed';
    else if (status === 'open') {
      const resolved = await resolvePreparationAssignees(tx, record, day, task.ruleSnapshot.assignees);
      if (resolved.users) users = resolved.users;
      else status = 'closed';
    }
    if (status !== 'completed')
      await updatePreparationTask(tx, ctx, stage, task, status, users, status === 'closed' ? 'close' : 'rebase');
  }
}
