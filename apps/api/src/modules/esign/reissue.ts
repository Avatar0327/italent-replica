/** F-481 §4.3：按任职业务写范围逐条回执；无联动执行行也可能已生效。 */
import { and, eq, esignTasks, sql, type Tx } from '@italent/db';
import { buttonResource, tenantLocalDate } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { lockEmploymentEmployee, rowsOf } from '../employment/record-store.js';
import { loadEmploymentBusiness } from '../employment/read-model.js';
import type { EmploymentContext } from '../employment/types.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { initiateTransferSign } from './transfer-sign.js';
import { isTransferInForce } from './transfer-in-force.js';
import { validateSignTemplates } from './transfer-input.js';

export const REISSUE_BUTTON = 'MulLaunchESignTranfer';
export interface ReissueInput {
  items: { businessId: string }[];
  templateIds: string[];
}
interface Receipt {
  id: string;
  ok: boolean;
  code?: string;
  taskId?: string;
  status?: string;
  failureReason?: string | null;
}

export async function authorizeReissue(tx: Tx, deps: TenantRouteDeps, ctx: EmploymentContext) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  await requirePermission(authorize, { ...ctx, action: 'object.update', resource: EMPLOYMENT_OBJECT, fields: [] });
  await requirePermission(authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_OBJECT, REISSUE_BUTTON, 'list'),
  });
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, EMPLOYMENT_OBJECT);
  return { ...ctx, scope };
}

async function visibleTransfer(tx: Tx, ctx: EmploymentContext, id: string) {
  const business = await loadEmploymentBusiness(
    tx,
    ctx.tenantId,
    id,
    tenantLocalDate(ctx.now, ctx.timezone),
    ctx.scope,
    'write',
  );
  return business?.kind === 'transfer' && business.status !== 'deleted' ? business : null;
}

/** 首次与幂等重放均复核非 NOT_FOUND 回执；不让旧错误码泄露已撤出范围的调动状态。 */
export async function recheckReissueReceipt(tx: Tx, ctx: EmploymentContext, body: unknown) {
  for (const item of (body as { items: Receipt[] }).items) {
    if (item.code !== 'NOT_FOUND' && !(await visibleTransfer(tx, ctx, item.id)))
      throw new AppError('NOT_FOUND', '任职数据不存在');
  }
}

export async function reissueTransfers(tx: Tx, ctx: EmploymentContext, input: ReissueInput) {
  await validateSignTemplates(tx, ctx.tenantId, input.templateIds);
  // 先按员工 ID 排序取锁，与任职/删除路径相同，避免两批交叉选择造成员工锁倒序。
  const owners = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT DISTINCT employee_id AS id FROM employment_business_objects
    WHERE tenant_id=${ctx.tenantId} AND id IN (${sql.join(
      input.items.map((i) => sql`${i.businessId}::uuid`),
      sql`,`,
    )})
    ORDER BY employee_id`),
  );
  for (const owner of owners) await lockEmploymentEmployee(tx, ctx, owner.id);
  const items: Receipt[] = [];
  for (const { businessId } of input.items) {
    const business = await visibleTransfer(tx, ctx, businessId);
    let code: string | undefined;
    if (!business) code = 'NOT_FOUND';
    else if (!(await isTransferInForce(tx, ctx, businessId))) code = 'ESIGN_TRANSFER_NOT_ACTIVE';
    else {
      const [active] = await tx
        .select({ id: esignTasks.id })
        .from(esignTasks)
        .where(
          and(
            eq(esignTasks.tenantId, ctx.tenantId),
            eq(esignTasks.businessId, businessId),
            eq(esignTasks.status, 'signing'),
          ),
        )
        .limit(1);
      if (active) code = 'ESIGN_TASK_IN_PROGRESS';
    }
    if (code) {
      items.push({ id: businessId, ok: false, code });
      continue;
    }
    const task = await initiateTransferSign(tx, ctx, {
      businessId,
      templateIds: input.templateIds,
      initiatorUserId: ctx.userId,
      origin: 'manual',
    });
    items.push({ id: businessId, ok: true, taskId: task.id, status: task.status, failureReason: task.failureReason });
  }
  return { items };
}
