import { sql, type Tx } from '@italent/db';
import { buttonResource, tenantLocalDate } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { EMPLOYMENT_OBJECT, employmentCreator } from '../employment/context.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { scopeAllowsInTransaction, authorizeInTransaction } from '../permission/module-access.js';
import { currentPersons } from '../permission/scope-persons.js';
import { managerIdentity } from '../permission/manager-identity.js';

export type TransferInitiator = 'hr' | 'manager' | 'employee';
const ROLE_BUTTONS = { hr: 'Transfer.Hr', manager: 'Transfer.Manager', employee: 'Transfer.Self' } as const;

export async function requireTransferButton(ctx: EmploymentContext, initiator: TransferInitiator): Promise<void> {
  if (!ctx.authorize) throw new AppError('FORBIDDEN', '无权发起调动');
  await requirePermission(ctx.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(EMPLOYMENT_OBJECT, ROLE_BUTTONS[initiator], 'detail'),
  });
}

export async function transferDirectActions(ctx: EmploymentContext, allowed: boolean) {
  const check = async (code: string, level: 'list' | 'list_row') =>
    allowed &&
    !!ctx.authorize &&
    (await ctx.authorize({
      ...ctx,
      action: 'object.button',
      resource: buttonResource(EMPLOYMENT_OBJECT, code, level),
    }));
  return {
    directList: await check('Employment.Tranfer', 'list'),
    directRow: await check('EmploymentRecord.LineOp.Transfer', 'list_row'),
  };
}

/** Switch 31 只放宽目标组织；发起人关系和源员工范围始终按今天的授权重新判断。 */
export async function requireTransferSource(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  initiator: TransferInitiator,
): Promise<void> {
  employeeId = employeeId.toLowerCase();
  ctx = { ...ctx, authorize: ctx.authorize ? authorizeInTransaction(ctx.authorize, tx) : undefined };
  await requireTransferButton(ctx, initiator);
  const [binding] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
    SELECT employee_id AS "employeeId" FROM permission_user_person_links
    WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId}::uuid
  `),
  );
  if (initiator === 'employee' && binding?.employeeId !== employeeId)
    throw new AppError('FORBIDDEN', '只能为绑定的本人发起调动');
  if (initiator !== 'employee' && binding?.employeeId === employeeId)
    throw new AppError('FORBIDDEN', '不能通过他人调动入口为本人发起调动');
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const [source] = rowsOf<{ departmentId: string | null; creatorId: string | null; kind: string | null }>(
    await tx.execute(sql`
    SELECT p.department_id AS "departmentId", p.kind,
      ${employmentCreator(ctx.tenantId, sql`e.id`)} AS "creatorId"
    FROM employment_employees e
    LEFT JOIN (${currentPersons(ctx.tenantId, today)}) p ON p.employee_id=e.id
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=${employeeId}::uuid LIMIT 1
  `),
  );
  if (
    !source ||
    !ctx.scope ||
    !(await scopeAllowsInTransaction(tx, ctx.scope, {
      personId: employeeId,
      orgId: source.departmentId,
      creatorId: source.creatorId,
    }))
  )
    throw new AppError('NOT_FOUND', '员工不存在');
  if (
    initiator === 'manager' &&
    (!binding || !(await inTeam(tx, ctx, binding.employeeId, employeeId, source.departmentId, today)))
  )
    throw new AppError('FORBIDDEN', '只能为本人团队成员发起调动');
}

async function inTeam(
  tx: Tx,
  ctx: EmploymentContext,
  managerId: string,
  employeeId: string,
  departmentId: string | null,
  today: string,
): Promise<boolean> {
  const identity = await managerIdentity(tx, { ...ctx, asOf: today });
  if (!departmentId || !identity.orgIds.includes(departmentId)) return false;
  const [current] = rowsOf<{ kind: string }>(
    await tx.execute(sql`
    SELECT kind FROM (${currentPersons(ctx.tenantId, today)}) p
    WHERE p.employee_id=${employeeId}::uuid AND p.service_type='primary' LIMIT 1
  `),
  );
  return identity.employeeId === managerId && !!current && !['leave', 'retirement'].includes(current.kind);
}

/** 纯经理即使另有宽泛数据范围，同单写入仍须重验当前负责组织；HR / 本人入口保留既有规则。 */
export async function requireManagerBusinessSource(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  requireEntry: boolean,
) {
  if (!ctx.authorize) throw new AppError('FORBIDDEN', '无权操作调动');
  const authorize = authorizeInTransaction(ctx.authorize, tx);
  const allowed = (button: string) =>
    authorize({
      ...ctx,
      action: 'object.button',
      resource: buttonResource(EMPLOYMENT_OBJECT, button, 'detail'),
    });
  if (await allowed('Transfer.Hr')) return false;
  const identity = await managerIdentity(tx, { ...ctx, asOf: tenantLocalDate(ctx.now, ctx.timezone) });
  if (identity.employeeId === employeeId.toLowerCase() && (await allowed('Transfer.Self'))) return false;
  if (!identity.active) {
    if (requireEntry) throw new AppError('FORBIDDEN', '需要经理自助身份');
    // DEC-177：普通只读查询仍由任职读取范围裁剪，不要求调动发起入口。
    return false;
  }
  // 按真实身份进入经理限制；撤除入口按钮必须拒绝，不能退回无经理限制的通用任职路径。
  await requireTransferSource(tx, ctx, employeeId, 'manager');
  return true;
}
