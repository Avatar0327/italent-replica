import { sql, type Tx } from '@italent/db';
import { buttonResource, tenantLocalDate } from '@italent/domain';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { EMPLOYMENT_OBJECT, employmentCreator } from '../employment/context.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { scopeAllowsInTransaction, authorizeInTransaction } from '../permission/module-access.js';
import { currentPersons, reportingPersonsSql } from '../permission/scope-persons.js';
import { loadOrgSnapshot } from '../org/read-model.js';

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
  const [source] = rowsOf<{ departmentId: string | null; creatorId: string | null }>(
    await tx.execute(sql`
    SELECT p.department_id AS "departmentId",
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
  const [report] = rowsOf<{ allowed: boolean }>(
    await tx.execute(sql`
    SELECT ${reportingPersonsSql(ctx.tenantId, today, managerId, 'all_direct', sql`${employeeId}::uuid`)} AS allowed
  `),
  );
  if (report?.allowed) return true;
  const visited = new Set<string>();
  while (departmentId && !visited.has(departmentId) && visited.size < 100) {
    visited.add(departmentId);
    const [org] = await loadOrgSnapshot(tx, ctx.tenantId, today, undefined, {
      id: departmentId,
      includeDisabled: false,
    });
    if (!org) return false;
    if (org.personInChargeId === managerId) return true;
    departmentId = org.parents.admin?.parentId ?? null;
  }
  return false;
}
