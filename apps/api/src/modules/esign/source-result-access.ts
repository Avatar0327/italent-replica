import { and, eq, esignTasks, type Tx } from '@italent/db';
import type { ESignSourceKind } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { EMPLOYEE_OBJECT, requireEmployeeInScope } from '../employment/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import type { PersonVariableField } from './initiation.js';

/** F-505 §5：回查和同键重放共用任务绑定与历史变量的当前授权。 */
export async function authorizeSourceSignTask(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize' | 'clock'>,
  ctx: ScopeBusinessContext,
  scene: ESignSourceKind,
  sourceId: string,
  taskId: string,
) {
  const [task] = await tx
    .select({ employeeId: esignTasks.employeeId, variableReadFields: esignTasks.variableReadFields })
    .from(esignTasks)
    .where(
      and(
        eq(esignTasks.tenantId, ctx.tenantId),
        eq(esignTasks.scene, scene),
        eq(scene === 'offer' ? esignTasks.offerId : esignTasks.businessId, sourceId),
        eq(esignTasks.id, taskId),
        eq(esignTasks.initiatorUserId, ctx.userId),
      ),
    );
  if (!task) throw new AppError('NOT_FOUND', '签署任务不存在');
  const fields = task.variableReadFields.filter((field) => field === 'name' || field === 'code');
  await authorizeSignVariables(tx, deps, ctx, task.employeeId, fields);
}

/** §3.3：仅当实际变量需要人员字段时，独立校验员工对象、现行范围和字段。 */
export async function authorizeSignVariables(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize' | 'clock'>,
  ctx: ScopeBusinessContext,
  employeeId: string,
  fields: readonly PersonVariableField[],
) {
  if (!fields.length) return;
  const forbidden = () => new AppError('FIELD_FORBIDDEN', '没有签署模板所需的人员字段读取权限');
  try {
    await requirePermission(authorizeInTransaction(deps.authorize, tx), {
      ...ctx,
      action: 'object.view',
      resource: EMPLOYEE_OBJECT,
    });
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYEE_OBJECT, `${EMPLOYEE_OBJECT}.detail`);
    await requireEmployeeInScope(tx, { ...ctx, scope }, employeeId);
  } catch (error) {
    if (error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) throw forbidden();
    throw error;
  }
  const viewable = await getModuleViewableFieldsInTransaction(deps, ctx, EMPLOYEE_OBJECT, tx);
  if (viewable && fields.some((field) => !viewable.has(field))) throw forbidden();
}
