/** §4.1：人口取当日有效链；读取规则字段时复核执行主体的当前来源权限。 */
import { sql, type Tx } from '@italent/db';
import { ageOn } from '@italent/domain';
import type { RiskPerson, RiskValue } from '@italent/domain';
import { loadRiskSources } from './risk-sources.js';
import { rowsOf, loadIncumbentIds } from './read-sql.js';
import { listActiveSuccessors, SUCCESSION_PORTS, type SuccessionReadContext } from './ports.js';
import { riskIncumbents } from '@italent/domain';
export type RiskPartTimeReader = (ctx: SuccessionReadContext, positionId: string) => Promise<readonly string[]>;
export async function riskPeople(
  tx: Tx,
  input: {
    tenantId: string;
    positionId: string;
    asOf: string;
    today: string;
    userId: string;
    partTime: boolean;
  },
  fields: readonly string[],
  partTimeReader?: RiskPartTimeReader,
) {
  const ctx = { tx, tenantId: input.tenantId, asOf: input.asOf };
  const access = await loadRiskSources(tx, input, fields);
  const primary =
    (await loadIncumbentIds(tx, input.tenantId, [input.positionId], input.asOf)).get(input.positionId) ?? [];
  // 兼职现任来自 R2-T05 端口（asOf 当日进行中）；开关仅控制计算，不复用卡片 showIncumbents。
  const part = input.partTime
    ? ((await (partTimeReader ?? SUCCESSION_PORTS.riskPartTimeIncumbents)?.(ctx, input.positionId)) ?? [])
    : [];
  const records = await listActiveSuccessors(ctx, {
    successionType: 'position',
    targetPositionIds: [input.positionId],
  });
  const ids = [...new Set([...primary, ...part, ...records.map((r) => r.successorEmployeeId)])];
  const people = new Map<string, RiskPerson>();
  for (const id of ids) {
    const [row] = await readRiskPerson(tx, input, id);
    const person: RiskPerson = { id };
    const states = access.forPerson(row ? { personId: id, orgId: row.currentOrgId ?? undefined } : null);
    for (const field of fields) {
      const state = states[field] ?? { status: 'unavailable' as const };
      if (state.status !== 'available') person[field] = state;
      else if (!row) person[field] = { status: 'unavailable' };
      else if (field === 'age') person[field] = ageOn(row.values.birthday as string | null, input.asOf);
      else if (field === 'readiness_id')
        person[field] = records.find((r) => r.successorEmployeeId === id)?.readinessId ?? null;
      else person[field] = row.values[field] ?? null;
    }
    people.set(id, person);
  }
  const from = (values: readonly string[]) => values.map((id) => people.get(id)!);
  return {
    sources: access.sources,
    incumbents: riskIncumbents(from(primary), from(part), input.partTime),
    successors: from([...new Set(records.map((r) => r.successorEmployeeId))]),
  };
}

// 入职日期属于任职周期；载荷快照不含此字段，必须从有效任职记录读取。
async function readRiskPerson(tx: Tx, input: Parameters<typeof riskPeople>[1], id: string) {
  return rowsOf<{ values: Record<string, RiskValue>; orgId: string | null; currentOrgId: string | null }>(
    await tx.execute(sql`
      SELECT jsonb_build_object('name',COALESCE(v.name,e.name),'gender',v.gender,'birthday',v.birthday,
      'entry_date',r.entry_date,'org_id',r.body->>'department_id','position_id',r.body->>'position_id',
      'job_level_id',r.body->>'level_id','job_sequence_id',r.body->>'sequence_id',
      'employee_status',r.employee_status) AS values,
      r.body->>'department_id' AS "orgId",cur.body->>'department_id' AS "currentOrgId"
      FROM employment_employees e LEFT JOIN LATERAL (SELECT * FROM personnel_employee_versions
        WHERE tenant_id=e.tenant_id AND employee_id=e.id ORDER BY revision DESC LIMIT 1) v ON true
      LEFT JOIN LATERAL (SELECT er.entry_date,COALESCE(p.body,to_jsonb(er)) AS body,s.employee_status
        FROM employment_timeline t JOIN employment_records er ON er.tenant_id=t.tenant_id AND er.id=t.record_id
        LEFT JOIN LATERAL (SELECT to_jsonb(pv) AS body FROM employment_payload_versions pv
          WHERE pv.tenant_id=er.tenant_id AND pv.business_id=er.id AND pv.is_record_snapshot
          ORDER BY version_no DESC LIMIT 1) p ON true
        JOIN LATERAL employment_record_status(t.tenant_id,er.id) s ON true
        WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.valid_during @> ${input.asOf}::date
          AND er.service_type='primary' LIMIT 1) r ON true
      LEFT JOIN LATERAL (SELECT COALESCE(p.body,to_jsonb(er)) AS body FROM employment_timeline t
        JOIN employment_records er ON er.tenant_id=t.tenant_id AND er.id=t.record_id
        LEFT JOIN LATERAL (SELECT to_jsonb(pv) AS body FROM employment_payload_versions pv
          WHERE pv.tenant_id=er.tenant_id
          AND pv.business_id=er.id AND pv.is_record_snapshot
          ORDER BY version_no DESC LIMIT 1) p ON true
        WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.valid_during @> ${input.today}::date
          AND er.service_type='primary' LIMIT 1) cur ON true
      WHERE e.tenant_id=${input.tenantId}::uuid AND e.id=${id}::uuid`),
  );
}
