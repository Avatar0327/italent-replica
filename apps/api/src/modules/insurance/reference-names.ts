/**
 * DEC-914：社保引用名随已获准披露的 ID 展示，不叠加候选对象权限；所有取名限定租户。
 * 方案取业务生效月有效版本（不受 enabled 影响），无匹配取最近版本；公司停用仍取名，缺失一律 null。
 * 只供读取出口使用，不进入联动载荷、变化字段或审批版本。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from '../employment/record-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function insuranceReferenceNames(
  tx: Tx,
  tenantId: string,
  effectiveDate: string | undefined,
  planIds: ReadonlySet<string>,
  companyIds: ReadonlySet<string>,
) {
  const plans = new Map<string, string>();
  const companies = new Map<string, string>();
  const month = effectiveDate ? `${effectiveDate.slice(0, 7)}-01` : null;
  for (const id of planIds) {
    if (!UUID.test(id)) continue;
    const [row] = rowsOf<{ name: string }>(
      await tx.execute(sql`SELECT name FROM social_insurance_plan_versions
        WHERE tenant_id=${tenantId} AND plan_id=${id}::uuid
        ORDER BY CASE WHEN effective_month <= ${month}::date
          AND (stop_month IS NULL OR stop_month > ${month}::date) THEN 0 ELSE 1 END,
          effective_month DESC LIMIT 1`),
    );
    if (row) plans.set(id, row.name);
  }
  for (const id of companyIds) {
    if (!UUID.test(id)) continue;
    const [row] = rowsOf<{ name: string }>(
      await tx.execute(sql`SELECT name FROM contract_companies
        WHERE tenant_id=${tenantId} AND id=${id}::uuid LIMIT 1`),
    );
    if (row) companies.set(id, row.name);
  }
  return { plans, companies };
}
