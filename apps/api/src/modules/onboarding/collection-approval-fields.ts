import type { OnboardingCollectionSubmission, Tx } from '@italent/db';
import { PERSONNEL_OBJECT, SUBSETS } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { ForeignField } from '../approval/foreign-fields.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllowsInTransaction,
} from '../permission/module-access.js';
import { requirePerson } from '../personnel/access.js';
import type { PersonnelContext, Row } from '../personnel/store.js';
import { loadSubset } from '../personnel/subsets.js';
import { COLLECTION, requireCollectionTarget } from './collection-access.js';
import { collectionBinding } from './collection-submit-store.js';

export const COLLECTION_VALUES = 'collectionValues';

interface CollectionForeignField extends ForeignField {
  readonly collectionTaskId: string;
}

export async function collectionApprovalFields(
  tx: Tx,
  ctx: PersonnelContext,
  submission: OnboardingCollectionSubmission,
) {
  const { profile, subsets } = submission.values;
  const values: Row = {};
  const foreignFields: CollectionForeignField[] = [];
  const add = (prefix: string, objectCode: string, patch: Row, creatorId: string | null) => {
    for (const [field, value] of Object.entries(patch)) {
      const code = `${COLLECTION_VALUES}.${prefix}.${field}`;
      values[code] = value;
      foreignFields.push({
        code,
        container: COLLECTION_VALUES,
        collectionTaskId: submission.taskId,
        objectCode,
        field,
        employeeId: submission.employeeId,
        creatorId,
      });
    }
  };
  add('profile', PERSONNEL_OBJECT, profile, null);
  // 使用者范围按源记录创建人。已删行只提供历史冻结值，当前权限仍需覆盖人员。
  for (const [i, { kind, id, values: patch }] of subsets.entries()) {
    const row = id ? await loadSubset(tx, ctx, submission.employeeId, kind, id, true) : null;
    add(`${kind}.${i + 1}`, SUBSETS[kind].objectCode, patch, typeof row?.createdBy === 'string' ? row.createdBy : null);
  }
  return { values, foreignFields };
}

async function notVisible<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AppError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)) return null;
    throw error;
  }
}

export function collectionApprovalVisibility(
  tx: Tx,
  deps: { authorize: Authorizer; clock(): Date },
  ctx: TenantContext,
) {
  const context = { ...ctx, now: deps.clock(), expectedRevision: 0, commandId: '' };
  const authorize = authorizeInTransaction(deps.authorize, tx);

  async function collectionEmployee(taskId: string) {
    return notVisible(async () => {
      const { stage, task } = await collectionBinding(tx, ctx.tenantId, taskId);
      // 撤回后曾提交值不再对任何审批读披露（实时详情与冻结办理份同走这里）；版本行仍保留作受控历史（设计 §4.1 第 7 条）
      if (task.status === 'withdrawn') return null;
      await requireCollectionTarget(tx, deps, context, stage.currentBusinessId, 'read');
      const container = await getModuleViewableFieldsInTransaction(deps, ctx, COLLECTION, tx);
      return !container || container.has(COLLECTION_VALUES) ? stage.employeeId : null;
    });
  }
  async function objectAccess(code: string) {
    if (!(await authorize({ ...ctx, action: 'object.view', resource: code }))) return null;
    return {
      fields: await getModuleViewableFieldsInTransaction(deps, ctx, code, tx),
      scope: await resolveModuleScopeInTransaction(deps, ctx, tx, code),
    };
  }
  const tasks = new Map<string, ReturnType<typeof collectionEmployee>>();
  const objects = new Map<string, ReturnType<typeof objectAccess>>();
  return async (field: ForeignField) => {
    if (!('collectionTaskId' in field) || typeof field.collectionTaskId !== 'string') return false;
    const { collectionTaskId: taskId, employeeId, objectCode, creatorId } = field;
    if (!tasks.has(taskId)) tasks.set(taskId, collectionEmployee(taskId));
    if ((await tasks.get(taskId)) !== employeeId) return false;
    if (!objects.has(objectCode)) objects.set(objectCode, objectAccess(objectCode));
    const access = await objects.get(objectCode);
    if (!access || (access.fields && !access.fields.has(field.field))) return false;
    if (objectCode !== PERSONNEL_OBJECT)
      return scopeAllowsInTransaction(tx, access.scope, { personId: employeeId, creatorId });
    return Boolean(
      await notVisible(async () => {
        await requirePerson(tx, { ...context, scope: access.scope, objectCode }, employeeId);
        return true;
      }),
    );
  };
}
