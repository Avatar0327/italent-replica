/**
 * 待入职阶段的“是否有试用期”（F-188，DEC-546② R2e8；表 employment_pending_entry_probation）：
 * 跟随待入职记录保存，办理入职时才决定人员状态（employee-status.ts）。改期 / 编辑换日期会替换记录（任职记录不可原地改日期），
 * 所以值要在同事务内搬到新记录；办理入职、删除后清除。没填过 = 没有行 = 读出 null（DEC-402 不回填存量）。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export async function savePendingProbation(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  businessId: string,
  probation: boolean,
): Promise<void> {
  await tx.execute(sql`INSERT INTO employment_pending_entry_probation(tenant_id, employee_id, business_id,
      probation, updated_at)
    VALUES (${ctx.tenantId}, ${employeeId}::uuid, ${businessId}::uuid, ${probation},
      ${ctx.now.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id, business_id) DO UPDATE SET probation=EXCLUDED.probation, updated_at=EXCLUDED.updated_at`);
}

export async function loadPendingProbation(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
): Promise<boolean | null> {
  const [row] = rowsOf<{ probation: boolean }>(
    await tx.execute(sql`SELECT probation FROM employment_pending_entry_probation
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`),
  );
  return row ? row.probation : null;
}

export async function clearPendingProbation(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM employment_pending_entry_probation
    WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid`);
}
