import {
  and,
  employmentEmployees,
  eq,
  type OnboardingCollectionTask,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { PERSONNEL_OBJECT, SUBSETS, type SubsetKind } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { EmploymentContext } from '../employment/types.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { requirePerson } from '../personnel/access.js';
import { employeeSnapshot } from '../personnel/employee-write.js';
import {
  COLLECTION,
  COLLECTION_BUTTONS,
  requireCollectionTarget,
  requireCollectionWrite,
} from './collection-access.js';
import { readCollectionComments } from './collection-tasks.js';

const preview = {
  title: '入职前信息采集',
  body: '请填写入职前采集信息，专属链接只可本人使用、不可转发。',
  notificationStatus: 'unavailable',
};

async function visibleForm(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  stage: OnboardingEntryCase,
  task: OnboardingCollectionTask,
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const fieldSets = new Map<string, ReadonlySet<string> | undefined>();
  for (const object of new Set(task.fields.map(({ objectCode }) => objectCode))) {
    if (!(await authorize({ ...ctx, action: 'object.view', resource: object }))) continue;
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, object);
    try {
      await requirePerson(tx, { ...ctx, scope, objectCode: object }, stage.employeeId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') continue;
      throw error;
    }
    fieldSets.set(object, await getModuleViewableFieldsInTransaction(deps, ctx, object, tx));
  }
  const fields = task.fields.filter(
    ({ objectCode, fieldCode }) => fieldSets.has(objectCode) && (fieldSets.get(objectCode)?.has(fieldCode) ?? true),
  );
  const allowedPrefill = fields.filter(
    ({ objectCode, fieldCode }) => objectCode === PERSONNEL_OBJECT && ['name', 'email', 'idType'].includes(fieldCode),
  );
  const person = allowedPrefill.length ? await employeeSnapshot(tx, ctx, stage.employeeId) : null;
  const [employee] =
    person?.name == null && allowedPrefill.some(({ fieldCode }) => fieldCode === 'name')
      ? await tx
          .select({ name: employmentEmployees.name })
          .from(employmentEmployees)
          .where(and(eq(employmentEmployees.tenantId, ctx.tenantId), eq(employmentEmployees.id, stage.employeeId)))
      : [];
  const values: Readonly<Record<string, unknown>> = { ...person, name: person?.name ?? employee?.name };
  return {
    fields,
    prefill: Object.fromEntries(allowedPrefill.map(({ fieldCode }) => [fieldCode, values[fieldCode] ?? null])),
    requiredSubsets: task.requiredSubsets.filter((code) =>
      fields.some(({ objectCode }) => SUBSETS[code as SubsetKind]?.objectCode === objectCode),
    ),
    verificationMode: task.verificationMode,
    requiresApproval: task.requiresApproval,
  };
}

async function collectionActions(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  stage: OnboardingEntryCase,
  task?: OnboardingCollectionTask,
) {
  if (stage.state !== 'pending' || (task && task.status !== 'ready' && task.status !== 'closed')) return [];
  const action = task?.status === 'ready' ? 'comments' : 'start';
  try {
    await requireCollectionWrite(tx, deps, ctx, action);
    await requireCollectionTarget(tx, deps, ctx, stage.currentBusinessId, 'write', false);
    return [COLLECTION_BUTTONS[action].code];
  } catch (error) {
    if (error instanceof AppError && [403, 404].includes(error.status)) return [];
    throw error;
  }
}

export async function projectCollectionTask(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  stage: OnboardingEntryCase,
  task: OnboardingCollectionTask | undefined,
  page: { limit: number; offset: number },
  pending: boolean,
) {
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, COLLECTION, tx);
  const shown = (key: string) => fields?.has(key) ?? true;
  const actions = pending ? await collectionActions(tx, deps, ctx, stage, task) : [];
  if (!task) return { ...(shown('status') ? { task: null } : {}), availableActions: actions };
  const selected = {
    id: task.id,
    revision: task.revision,
    status: task.status,
    ruleId: task.ruleId,
    templateId: task.templateId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  const taskDto = Object.fromEntries(Object.entries(selected).filter(([field]) => shown(field)));
  const comments = shown('comment') ? await readCollectionComments(tx, ctx.tenantId, task.id, page) : undefined;
  return {
    ...(Object.keys(taskDto).length ? { task: taskDto } : {}),
    ...(shown('collectionValues') ? { form: await visibleForm(tx, deps, ctx, stage, task), preview } : {}),
    ...(comments
      ? {
          comments: comments.map(({ id, text, authorId, createdAt }) => ({
            id,
            text,
            ...(shown('createdBy') ? { authorId } : {}),
            ...(shown('createdAt') ? { createdAt } : {}),
          })),
        }
      : {}),
    availableActions: actions,
  };
}
