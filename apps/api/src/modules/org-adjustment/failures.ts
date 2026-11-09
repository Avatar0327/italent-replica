/**
 * 人员联动失败的逐人读取（R2-T08 §7.5“失败员工在详情逐人列出”；F-458，F-414 ③ 同源）。
 * 只列满足全部条件的行，其余一律不出现（不出现“有隐藏行”的计数，姓名 / 原因 / 说明也不经别处露出）：
 * ① 查看人走 HR 路径，且对任职记录对象有查看权（审批人路径没有员工范围，fail-closed 不列）；
 * ② 失败所属明细行对查看人可见（沿用 `visibleItems`，组织分区字段全不披露时整体不列）；
 * ③ 记录部门或员工当前任职部门在范围内（沿用 DEC-177 的 `visibleEmploymentRecords`，范围为空一律不可见）。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from '../org/read-model.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { visibleEmploymentRecords } from '../employment/visibility.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { orgSectionDisclosed, visibleItems, type Disclosure } from './disclosure.js';
import { loadItems } from './items-store.js';

interface FailureRow {
  readonly itemId: string;
  readonly employeeId: string;
  /** F-493 S1：历史离职人员可无工号。 */
  readonly employeeCode: string | null;
  readonly employeeName: string;
  readonly reason: string;
  readonly message: string;
}

type Deps = Pick<TenantRouteDeps, 'authorize' | 'clock'>;

/** 有工号在前、空工号排最后（与 SQL 升序 NULLS LAST 同向）。 */
function compareCodeNullsLast(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return a.localeCompare(b);
}

export async function readEmploymentFailures(
  tx: Tx,
  deps: Deps,
  ctx: TenantContext,
  disclosure: Disclosure,
): Promise<FailureRow[]> {
  if (disclosure.via !== 'hr' || !orgSectionDisclosed(disclosure)) return [];
  const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const allowed = await bound.authorize({ ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT, fields: [] });
  if (!allowed) return [];
  const adjustmentId = disclosure.view.id;
  const { items } = visibleItems(disclosure, await loadItems(tx, ctx.tenantId, adjustmentId));
  if (!items.length) return [];
  const seqOf = new Map(items.map((item) => [item.id, item.seq]));
  const departmentOf = new Map(items.map((item) => [item.id, item.targetOrgId]));
  const rows = rowsOf<FailureRow>(
    await tx.execute(sql`SELECT f.item_id AS "itemId", f.employee_id AS "employeeId", e.code AS "employeeCode",
        e.name AS "employeeName", f.reason, f.message
      FROM org_adjustment_employment_failures f
      JOIN employment_employees e ON e.tenant_id = f.tenant_id AND e.id = f.employee_id
      WHERE f.tenant_id = ${ctx.tenantId} AND f.adjustment_id = ${adjustmentId}::uuid
        AND f.item_id = ANY(${`{${[...seqOf.keys()].join(',')}}`}::uuid[])`),
  );
  if (!rows.length) return [];
  const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, EMPLOYMENT_OBJECT);
  const targets = rows.map((row) => ({
    employeeId: row.employeeId,
    departmentId: departmentOf.get(row.itemId) ?? null,
  }));
  const visible = await visibleEmploymentRecords(tx, ctx.tenantId, scope, targets);
  return rows
    .filter((_, index) => visible[index])
    .sort(
      (a, b) =>
        seqOf.get(a.itemId)! - seqOf.get(b.itemId)! ||
        compareCodeNullsLast(a.employeeCode, b.employeeCode) ||
        a.employeeId.localeCompare(b.employeeId),
    );
}
