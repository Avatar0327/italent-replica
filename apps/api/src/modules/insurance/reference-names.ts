/**
 * DEC-914：社保引用名随已获准披露的 ID 展示，不叠加候选对象权限；所有取名限定租户。
 * 方案取业务生效月有效版本（不受 enabled 影响），无匹配取最近版本；公司停用仍取名，缺失一律 null。
 * 用于读取出口与 F-476 标签捕获，不进入联动载荷、变化字段或审批版本。
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
  const names = { plans: new Map<string, string>(), companies: new Map<string, string>() };
  const plans = [...planIds].filter((id) => UUID.test(id));
  const companies = [...companyIds].filter((id) => UUID.test(id));
  if (!plans.length && !companies.length) return names;
  const month = effectiveDate ? `${effectiveDate.slice(0, 7)}-01` : null;
  // F-476 §4.3：同一条语句捕获四个标签，避免并发改名时多次 SELECT 混入不同时间点的名称。
  const rows = rowsOf<{ kind: 'plans' | 'companies'; id: string; name: string }>(
    await tx.execute(sql`SELECT 'plans' AS kind, ref.id::text AS id, v.name
      FROM unnest(${`{${plans.join(',')}}`}::uuid[]) AS ref(id)
      JOIN LATERAL (
        SELECT name FROM social_insurance_plan_versions
        WHERE tenant_id=${tenantId} AND plan_id=ref.id
        ORDER BY CASE WHEN effective_month <= ${month}::date
          AND (stop_month IS NULL OR stop_month > ${month}::date) THEN 0 ELSE 1 END,
          effective_month DESC LIMIT 1
      ) v ON true
      UNION ALL SELECT 'companies', id::text, name FROM contract_companies
      WHERE tenant_id=${tenantId} AND id=ANY(${`{${companies.join(',')}}`}::uuid[])`),
  );
  const byId = new Map(rows.map((row) => [`${row.kind}:${row.id}`, row.name]));
  for (const [kind, ids] of [
    ['plans', plans],
    ['companies', companies],
  ] as const)
    for (const id of ids) {
      const name = byId.get(`${kind}:${id.toLowerCase()}`);
      if (name !== undefined) names[kind].set(id, name);
    }
  return names;
}
