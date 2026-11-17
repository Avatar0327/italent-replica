/** F-481 §10：所有者按当前人员范围；文件读权同时用于列表裁剪与下载。 */
import { and, eq, esignTasks, esignTaskFiles, sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { operatorNames } from '../../audit/query.js';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { rowsOf } from '../employment/record-store.js';
import type { SignTask } from './sign-events.js';

export const RECORD_OBJECT = MODULE_OBJECTS.eSignRecord.code;
// F-481 §10.1：按业务所有者解析管理单元，组织范围须转换为人员关联谓词。
registerPersonScopedObject(RECORD_OBJECT);
export const canRead = (fields: ReadonlySet<string> | undefined, field: string) =>
  fields === undefined || fields.has(field);
export function requireFiles(fields: ReadonlySet<string> | undefined) {
  if (!canRead(fields, 'files')) throw new AppError('FIELD_FORBIDDEN', '没有电子文件查看权限');
}
export const recordScope = (scope: ModuleScope) => scopeSql(scope, { person: sql`${esignTasks.employeeId}` });
export const signer = (ctx: ScopeBusinessContext) =>
  sql`(${esignTasks.employeeSignerUserId}=${ctx.userId}::uuid OR ${esignTasks.initiatorUserId}=${ctx.userId}::uuid)`;

export async function loadVisibleSignTask(
  tx: Tx,
  ctx: ScopeBusinessContext,
  id: string,
  scope: ModuleScope | 'own',
  lock = false,
) {
  const where = and(
    eq(esignTasks.tenantId, ctx.tenantId),
    eq(esignTasks.id, id),
    scope === 'own' ? signer(ctx) : recordScope(scope),
  );
  const query = tx.select().from(esignTasks).where(where);
  const [task] = await (lock ? query.for('update') : query);
  if (!task) throw new AppError('NOT_FOUND', '签署任务不存在');
  return task;
}
export const taskFiles = (tx: Tx, tenantId: string, taskId: string) =>
  tx
    .select()
    .from(esignTaskFiles)
    .where(and(eq(esignTaskFiles.tenantId, tenantId), eq(esignTaskFiles.taskId, taskId)))
    .orderBy(esignTaskFiles.seq);

export async function taskNames(tx: Tx, ctx: ScopeBusinessContext, task: SignTask) {
  const [employee] = rowsOf<{ name: string }>(
    await tx.execute(sql`
    SELECT ${personnelHooks.currentName(ctx.tenantId, sql`e.id`, sql`e.name`)} AS name
    FROM employment_employees e WHERE e.tenant_id=${ctx.tenantId} AND e.id=${task.employeeId}::uuid`),
  );
  const [department] = rowsOf<{ name: string }>(
    await tx.execute(sql`
    SELECT name FROM org_versions WHERE tenant_id=${ctx.tenantId} AND org_id=${task.ownerDepartmentId}::uuid
    AND start_date<=${tenantLocalDate(ctx.now, ctx.timezone)}::date ORDER BY start_date DESC,version_no DESC LIMIT 1`),
  );
  const operators = await operatorNames(tx, [{ actorUserId: task.initiatorUserId }]);
  return {
    owner: employee?.name ?? '--',
    department: department?.name ?? '--',
    initiator: operators({ actorUserId: task.initiatorUserId }).name,
  };
}
export async function presentRecord(
  tx: Tx,
  ctx: ScopeBusinessContext,
  task: SignTask,
  fields: ReadonlySet<string> | undefined,
) {
  const names = await taskNames(tx, ctx, task);
  const values = {
    initiator: { id: task.initiatorUserId, name: names.initiator },
    owner: { id: task.employeeId, name: names.owner },
    ownerDepartment: { id: task.ownerDepartmentId, name: names.department },
    scene: task.scene,
    initiatedAt: task.initiatedAt,
    completedAt: task.completedAt,
    status: task.status,
    ...(canRead(fields, 'files')
      ? { files: (await taskFiles(tx, ctx.tenantId, task.id)).map((f) => ({ seq: f.seq, name: f.templateName })) }
      : {}),
  };
  return {
    id: task.id,
    revision: task.revision,
    ...Object.fromEntries(Object.entries(values).filter(([field]) => canRead(fields, field))),
    ...(canRead(fields, 'status') ? { currentNode: task.currentNode, failureReason: task.failureReason } : {}),
  };
}
