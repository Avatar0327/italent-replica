import { createHash } from 'node:crypto';
import {
  and,
  auditEvents,
  eq,
  inArray,
  onboardingIntegrationSchemes as schemes,
  onboardingIntegrationScopeOrgs as scopeOrgs,
  onboardingIntegrationStages as stages,
  onboardingIntegrationStageTasks as tasks,
  pgErrorCode,
  sql,
  type Tx,
} from '@italent/db';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { assertRevision } from '../employment/context.js';
import type { BusinessContext } from '../job/context.js';
import type { ModuleScope } from '../permission/module-access.js';
import { requireSchemeOrgs, schemeMissing } from './integration-schemes-access.js';
import { type SchemeInput, type StageTaskInput, validateSchemeStages } from './integration-schemes-input.js';
import { INTEGRATION_SCHEME_AUDIT, readScheme, type SchemeView } from './integration-schemes-read.js';
import { validateSchemeReferences } from './integration-schemes-references.js';

function dateColumns({ start, due }: Pick<StageTaskInput, 'start' | 'due'>) {
  return { startUnit: start.unit, startOrdinal: start.ordinal, dueUnit: due.unit, dueOrdinal: due.ordinal };
}

function taskColumns(task: StageTaskInput, sequence: number) {
  const { assignee, poolTaskId, employeeVisible, reminder } = task;
  return {
    ...dateColumns(task),
    sequence,
    poolTaskId,
    employeeVisible,
    reminderDays: reminder.mode === 'on' ? reminder.days : reminder.mode === 'off' ? 0 : null,
    assigneeType: assignee.type,
    assigneeRole: assignee.type === 'role' ? assignee.role : null,
    assigneeUserId: assignee.type === 'member' ? assignee.id : null,
    assigneePositionId: assignee.type === 'position' ? assignee.id : null,
    assigneePostId: assignee.type === 'post' ? assignee.id : null,
    assigneeProfileId: assignee.type === 'identity' ? assignee.id : null,
  };
}

function removed<T extends { id?: string | undefined }>(before: T[], after: T[]) {
  const keep = new Set(after.map(({ id }) => id));
  return before.flatMap(({ id }) => (id && !keep.has(id) ? [id] : []));
}

function checkChildIds(before: SchemeInput['stages'], after: SchemeInput['stages']) {
  const validIds = (previous: { id?: string | undefined }[], next: { id?: string | undefined }[]) => {
    const available = new Set(previous.map(({ id }) => id));
    for (const { id } of next) if (id && !available.delete(id)) throw schemeMissing();
  };
  validIds(before, after);
  for (const stage of after) {
    const previous = stage.id ? before.find(({ id }) => id === stage.id) : undefined;
    validIds(previous?.tasks ?? [], stage.tasks);
  }
}

async function saveStage(
  tx: Tx,
  tenantId: string,
  schemeId: string,
  stage: SchemeInput['stages'][number],
  sequence: number,
  oldTasks: StageTaskInput[],
) {
  const values = { ...dateColumns(stage), name: stage.name, sequence };
  const [saved] = await (stage.id
    ? tx
        .update(stages)
        .set(values)
        .where(and(eq(stages.tenantId, tenantId), eq(stages.id, stage.id)))
        .returning()
    : tx
        .insert(stages)
        .values({ tenantId, schemeId, ...values })
        .returning());
  const stageId = saved!.id;
  const dropped = removed(oldTasks, stage.tasks);
  if (dropped.length) await tx.delete(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.id, dropped)));
  const created: (typeof tasks.$inferInsert)[] = [];
  for (const [sequence, task] of stage.tasks.entries()) {
    const fields = taskColumns(task, sequence);
    if (task.id) {
      await tx
        .update(tasks)
        .set(fields)
        .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, task.id)));
    } else {
      created.push({ tenantId, stageId, ...fields });
    }
  }
  if (created.length) await tx.insert(tasks).values(created);
}

async function saveStages(
  tx: Tx,
  tenantId: string,
  schemeId: string,
  before: SchemeInput['stages'],
  after: SchemeInput['stages'],
) {
  const dropped = removed(before, after);
  if (dropped.length) await tx.delete(stages).where(and(eq(stages.tenantId, tenantId), inArray(stages.id, dropped)));
  for (const [sequence, stage] of after.entries()) {
    const oldTasks = stage.id ? (before.find(({ id }) => id === stage.id)?.tasks ?? []) : [];
    await saveStage(tx, tenantId, schemeId, stage, sequence, oldTasks);
  }
}

function conditionsOf(conditions: SchemeInput['conditions']) {
  return Object.fromEntries(
    Object.entries(conditions)
      .filter(([, values]) => values?.length)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function auditScheme(
  tx: Tx,
  ctx: BusinessContext,
  action: 'create' | 'update' | 'delete',
  before: SchemeView | null,
  after: SchemeView | null,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    action: `onboarding.integration_scheme.${action}`,
    objectType: INTEGRATION_SCHEME_AUDIT,
    objectId: (after ?? before)!.id,
    before,
    after,
  });
}

async function saveHead(tx: Tx, ctx: BusinessContext, id: string | undefined, input: SchemeInput) {
  const { tenantId, userId, now, expectedRevision } = ctx;
  const { name, description, priority, failureRecipientId, orgIds, reminder } = input;
  const conditions = conditionsOf(input.conditions);
  const scopeKey = createHash('sha256').update(JSON.stringify({ orgIds, conditions })).digest('hex');
  const fields = {
    name,
    description,
    priority,
    failureRecipientId,
    conditions,
    scopeKey,
    updatedBy: userId,
    updatedAt: now,
    revision: expectedRevision + 1,
    reminderDays: reminder.mode === 'on' ? reminder.days : null,
  };
  await advisoryLock(tx, asUuid(tenantId), ':integration-scheme-priority:', String(priority));
  try {
    const [saved] = await (id
      ? tx
          .update(schemes)
          .set(fields)
          .where(and(eq(schemes.tenantId, tenantId), eq(schemes.id, id)))
          .returning()
      : tx
          .insert(schemes)
          .values({ ...fields, tenantId, createdBy: userId, createdAt: now })
          .returning());
    return saved!;
  } catch (error) {
    if (pgErrorCode(error) !== '23505') throw error;
    throw new AppError('CONFLICT', '同优先级的融入方案已使用相同范围', {
      reason: 'INTEGRATION_SCHEME_SCOPE_DUPLICATE',
    });
  }
}

type SchemeChange = { [K in keyof SchemeInput]?: SchemeInput[K] | undefined };
type SaveRequest = { input: SchemeInput } | { id: string; patch: SchemeChange };

export async function saveIntegrationScheme(tx: Tx, ctx: BusinessContext, scope: ModuleScope, request: SaveRequest) {
  const { tenantId } = ctx;
  const before = 'id' in request ? await readScheme(tx, tenantId, scope, request.id, true) : null;
  assertRevision(ctx.expectedRevision, before?.revision ?? 0);
  const input = 'input' in request ? request.input : ({ ...before!, ...request.patch } as SchemeInput);
  requireSchemeOrgs(scope, input.orgIds);
  checkChildIds(before?.stages ?? [], input.stages);
  validateSchemeStages(input.stages);
  await validateSchemeReferences(tx, ctx, scope, input);

  const saved = await saveHead(tx, ctx, before?.id, input);
  const previousOrgs = before?.orgIds ?? [];
  if (input.orgIds.join(',') !== previousOrgs.join(',')) {
    await tx.delete(scopeOrgs).where(and(eq(scopeOrgs.tenantId, tenantId), eq(scopeOrgs.schemeId, saved.id)));
    await tx.insert(scopeOrgs).values(input.orgIds.map((orgId) => ({ tenantId, schemeId: saved.id, orgId })));
  }
  if ('input' in request || request.patch.stages !== undefined)
    await saveStages(tx, tenantId, saved.id, before?.stages ?? [], input.stages);
  const after = await readScheme(tx, tenantId, scope, saved.id);
  await auditScheme(tx, ctx, before ? 'update' : 'create', before, after);
  return { id: saved.id, revision: saved.revision, status: 'saved' };
}

export async function deleteIntegrationScheme(tx: Tx, ctx: BusinessContext, scope: ModuleScope, id: string) {
  const before = await readScheme(tx, ctx.tenantId, scope, id, true);
  assertRevision(ctx.expectedRevision, before.revision);
  try {
    await tx.delete(schemes).where(and(eq(schemes.tenantId, ctx.tenantId), eq(schemes.id, id)));
  } catch (error) {
    if (!['23503', '23001'].includes(pgErrorCode(error) ?? '')) throw error;
    throw new AppError('CONFLICT', '融入方案已被引用，不能删除');
  }
  await auditScheme(tx, ctx, 'delete', before, null);
  return { id, revision: before.revision, status: 'deleted' };
}

export async function requireDeletedSchemeScope(tx: Tx, tenantId: string, scope: ModuleScope, id: string) {
  const [snapshot] = await tx
    .select({ before: auditEvents.before })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, tenantId),
        eq(auditEvents.objectType, INTEGRATION_SCHEME_AUDIT),
        eq(auditEvents.objectId, id),
        sql`${auditEvents.action} = 'onboarding.integration_scheme.delete'`,
      ),
    )
    .limit(1);
  const orgIds = (snapshot?.before as Pick<SchemeView, 'orgIds'> | null)?.orgIds;
  requireSchemeOrgs(scope, orgIds ?? []);
}
