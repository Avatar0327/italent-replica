import {
  and,
  asc,
  eq,
  inArray,
  sql,
  type OnboardingEntryCase,
  type Tx,
  onboardingPreparationItems as items,
  onboardingPreparationRules as rules,
  onboardingPreparationScopeOrgs as roots,
  onboardingPreparationTasks as tasks,
} from '@italent/db';
import { ENTRY_STATUS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { lockPendingEntry } from '../employment/employee-status.js';
import { entryCaseContext } from '../employment/entry-case.js';
import {
  entryLifecyclePort,
  type EntryCaseWriteRef,
  type EntryLifecycleContext,
} from '../employment/onboarding-entry-port.js';
import type { EmploymentContext, EmploymentRecord } from '../employment/types.js';
import { lockPreparationConfig, preparationRuleChildren } from './preparation-config.js';
import { resolvePreparationAssignees } from './preparation-launch-assignees.js';
import {
  auditPreparationTask,
  matchesPreparationRule,
  plannedReminder,
  plannedStart,
  preparationDay,
  preparationFacts,
  syncPreparationAssignees,
  updatePreparationTask,
  type PreparationTask,
} from './preparation-launch-state.js';

type LaunchReceipt =
  | { itemId: string; taskId: string; revision: number; status: PreparationTask['status'] }
  | { itemId: string; status: 'failed'; code: string };
const receipt = ({ id, itemId, status, revision }: PreparationTask): LaunchReceipt => ({
  itemId,
  taskId: id,
  revision,
  status,
});
const fail = (itemId: string, code: string): LaunchReceipt => ({ itemId, status: 'failed', code });

async function matchingRules(
  tx: Tx,
  ctx: EntryLifecycleContext,
  facts: Awaited<ReturnType<typeof preparationFacts>>,
  itemIds: string[] | undefined,
) {
  if (!facts.orgs.length || itemIds?.length === 0) return [];
  const rows = await tx
    .select({ rule: rules, item: items })
    .from(rules)
    .innerJoin(items, and(eq(items.tenantId, rules.tenantId), eq(items.id, rules.itemId), eq(items.enabled, true)))
    .where(
      and(
        eq(rules.tenantId, ctx.tenantId),
        eq(rules.enabled, true),
        itemIds ? inArray(rules.itemId, itemIds) : undefined,
        sql`EXISTS (SELECT 1 FROM ${roots} WHERE ${roots.tenantId}=${rules.tenantId}
        AND ${roots.ruleId}=${rules.id} AND ${inArray(roots.orgId, facts.orgs)})`,
      ),
    )
    .orderBy(asc(rules.priority), asc(rules.id));
  const selected = new Map<string, (typeof rows)[number] & { ambiguous: boolean }>();
  for (const hit of rows) {
    if (!matchesPreparationRule({ orgIds: facts.orgs, conditions: hit.rule.conditions }, facts)) continue;
    const previous = selected.get(hit.item.id);
    if (!previous) selected.set(hit.item.id, { ...hit, ambiguous: false });
    else if (previous.rule.priority === hit.rule.priority) previous.ambiguous = true;
  }
  return [...selected.values()];
}

async function createTask(
  tx: Tx,
  ctx: EntryLifecycleContext,
  stage: OnboardingEntryCase,
  record: EmploymentRecord,
  { rule, item, ambiguous }: Awaited<ReturnType<typeof matchingRules>>[number],
  force: boolean,
): Promise<LaunchReceipt> {
  if (ambiguous) return fail(item.id, 'PREPARATION_RULE_AMBIGUOUS');
  const day = preparationDay(ctx);
  const due = plannedStart(rule, stage, day);
  const open = force || due <= day;
  const children = await preparationRuleChildren(tx, ctx.tenantId, rule.id);
  const resolved = open ? await resolvePreparationAssignees(tx, record, day, children.assignees) : { users: [] };
  if (!resolved.users) return fail(item.id, resolved.code);
  const [task] = await tx
    .insert(tasks)
    .values({
      tenantId: ctx.tenantId,
      caseId: stage.id,
      caseRevision: stage.revision,
      itemId: item.id,
      ruleId: rule.id,
      status: open ? 'open' : 'scheduled',
      nextDueOn: open ? null : due,
      nextRemindOn: open ? plannedReminder(rule, stage, day) : null,
      startDaysBefore: rule.startDaysBefore,
      remindDaysBefore: rule.remindDaysBefore,
      ruleSnapshot: { revision: rule.revision, conditions: rule.conditions, ...children },
      formSnapshot: { revision: item.revision, category: item.category, name: item.name, fields: item.fields },
      createdAt: ctx.now,
      updatedAt: ctx.now,
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
    })
    .returning();
  await syncPreparationAssignees(tx, ctx, task!.id, resolved.users);
  await auditPreparationTask(tx, ctx, null, task!, open ? 'open' : 'schedule', [], resolved.users);
  return receipt(task!);
}

async function openScheduled(
  tx: Tx,
  ctx: EntryLifecycleContext,
  stage: OnboardingEntryCase,
  record: EmploymentRecord,
  facts: Awaited<ReturnType<typeof preparationFacts>>,
  task: PreparationTask,
  force: boolean,
) {
  const day = preparationDay(ctx);
  if (task.status !== 'scheduled' || (!force && task.nextDueOn! > day)) return receipt(task);
  if (task.caseRevision !== stage.revision || !matchesPreparationRule(task.ruleSnapshot, facts)) {
    await updatePreparationTask(tx, ctx, stage, task, 'closed', [], 'close');
    return fail(task.itemId, 'PREPARATION_SCOPE_CHANGED');
  }
  const resolved = await resolvePreparationAssignees(tx, record, day, task.ruleSnapshot.assignees);
  if (!resolved.users) return fail(task.itemId, resolved.code);
  return receipt(await updatePreparationTask(tx, ctx, stage, task, 'open', resolved.users, 'open'));
}

/**
 * 可信调用方先验动作权限。按员工、业务头、阶段、任务顺序取锁。
 * 生产触发和逐项命令由 16a-3b 接入。
 */
export async function launchEntryPreparations(
  tx: Tx,
  ctx: EmploymentContext,
  ref: EntryCaseWriteRef,
  mode: 'auto' | 'manual',
  itemIds?: readonly string[],
) {
  const { record } = await lockPendingEntry(tx, { ...ctx, expectedRevision: ref.businessRevision }, ref.businessId);
  const actor = entryCaseContext(ctx);
  const stage = await entryLifecyclePort().lockForWrite(tx, actor, ref, ['pending']);
  if (record.entryStatus === ENTRY_STATUS.cancelled || record.employeeId !== stage.employeeId)
    throw new AppError('CONFLICT', '待入职阶段不可发起准备', { reason: 'ENTRY_CASE_NOT_CURRENT' });
  if (itemIds?.length === 0) return [];
  await lockPreparationConfig(tx, ctx.tenantId, 'read');
  const current = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, ctx.tenantId),
        eq(tasks.caseId, stage.id),
        sql`${tasks.status}<>'closed'`,
        itemIds ? inArray(tasks.itemId, [...itemIds]) : undefined,
      ),
    )
    .orderBy(asc(tasks.itemId))
    .for('update');
  const facts = await preparationFacts(tx, actor, record);
  const results = new Map<string, LaunchReceipt>();
  for (const task of current)
    results.set(task.itemId, await openScheduled(tx, actor, stage, record, facts, task, mode === 'manual'));
  const missing = itemIds ? [...new Set(itemIds)].filter((id) => !results.has(id)) : undefined;
  for (const hit of await matchingRules(tx, actor, facts, missing)) {
    if (!results.has(hit.item.id))
      results.set(hit.item.id, await createTask(tx, actor, stage, record, hit, mode === 'manual'));
  }
  return itemIds
    ? [...new Set(itemIds)].map((id) => results.get(id) ?? fail(id, 'PREPARATION_RULE_NOT_MATCHED'))
    : [...results.values()];
}
