import { and, eq, onboardingEntryCases, type Tx } from '@italent/db';
import { buttonResource, EMPLOYEE_STATUS, ENTRY_STATUS, MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import type { CollectionAction } from './collection-tasks.js';

export const COLLECTION = MODULE_OBJECTS.onboardingCollection.code;
export const COLLECTION_BUTTONS = {
  start: { code: 'BE16.CollectionStart', level: 'detail' },
  remind: { code: 'BE16.CollectionRemind', level: 'detail' },
  comments: { code: 'BE16.CollectionComment', level: 'detail' },
  batch: { code: 'BE16.CollectionStartBatch', level: 'list' },
  rehire: { code: 'BE16.CollectionConfirmRehire', level: 'detail' },
} as const;
export type WriteAction = CollectionAction | 'batch' | 'rehire';
type AccessDeps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

export async function requireCollectionWrite(tx: Tx, deps: AccessDeps, ctx: EmploymentContext, action: WriteAction) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const button = COLLECTION_BUTTONS[action];
  await requireObjectWrite(authorize, ctx, { objectCode: EMPLOYMENT_OBJECT, operation: 'update', payload: {} });
  await requirePermission(authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_OBJECT, button.code, button.level),
  });
  await requireObjectWrite(authorize, ctx, {
    objectCode: COLLECTION,
    operation: action === 'start' || action === 'batch' ? 'create' : 'update',
    payload: action === 'comments' ? { comment: true } : {},
  });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: COLLECTION });
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, COLLECTION, tx);
  if (fields && !['id', 'revision', 'status'].every((field) => fields.has(field)))
    throw new AppError('FORBIDDEN', '没有查看采集任务回执的权限');
}

export async function requireCollectionTarget(
  tx: Tx,
  deps: AccessDeps,
  ctx: EmploymentContext,
  id: string,
  access: 'read' | 'write',
  lock = access === 'write',
) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT });
  await requirePermission(authorize, { ...ctx, action: 'object.view', resource: COLLECTION });
  const c = onboardingEntryCases;
  const [stage] = await tx
    .select()
    .from(c)
    .where(and(eq(c.tenantId, ctx.tenantId), eq(c.currentBusinessId, id)));
  if (!stage || stage.state === 'deleted') throw new AppError('NOT_FOUND', '待入职阶段不存在');
  if (lock) await lockEmploymentEmployee(tx, ctx, stage.employeeId);
  const [scope, collectionScope] = await Promise.all([
    resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYMENT_OBJECT),
    resolveModuleScopeInTransaction(deps, ctx, tx, COLLECTION),
  ]);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const record = await loadEmploymentBusiness(tx, ctx.tenantId, id, today, scope, access);
  const visible = record && (await loadEmploymentBusiness(tx, ctx.tenantId, id, today, collectionScope, access));
  if (!visible || visible.employeeId !== stage.employeeId || visible.status !== 'effective')
    throw new AppError('NOT_FOUND', '待入职阶段不存在');
  return {
    stage,
    scope,
    businessRevision: record.revision,
    pending:
      stage.state === 'pending' &&
      record.employeeStatus === EMPLOYEE_STATUS.pendingEntry &&
      record.entryStatus !== ENTRY_STATUS.cancelled,
  };
}
