/** §4.1：人口取当日有效链；读取规则字段时复核执行主体的当前来源权限。 */
import { sql, type Tx } from '@italent/db';
import { ageOn, decide, resolveObjectPermission, PERSONNEL_OBJECT } from '@italent/domain';
import type { RiskPerson, RiskValue } from '@italent/domain';
import { loadSubject } from '../permission/subject.js';
import { objectCatalog } from '../permission/catalog.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { scopeAllows } from '../permission/module-access.js';
import { loadJobObject } from '../job/read-model.js';
import { rowsOf, loadIncumbentIds } from './read-sql.js';
import { listActiveSuccessors, SUCCESSION_PORTS, type SuccessionReadContext } from './ports.js';
import { riskIncumbents } from '@italent/domain';
const fieldMap: Record<string, [string, string]> = {
  name: [PERSONNEL_OBJECT, 'name'],
  gender: [PERSONNEL_OBJECT, 'gender'],
  age: [PERSONNEL_OBJECT, 'age'],
  entry_date: [PERSONNEL_OBJECT, 'entryDate'],
  work_years: [PERSONNEL_OBJECT, 'workDate'],
  org_id: ['TenantBase.EmploymentRecord', 'departmentId'],
  position_id: ['TenantBase.EmploymentRecord', 'positionId'],
  job_level_id: ['TenantBase.EmploymentRecord', 'levelId'],
  job_sequence_id: ['TenantBase.EmploymentRecord', 'sequenceId'],
  employee_status: ['TenantBase.EmploymentRecord', 'employeeStatus'],
  readiness_id: ['Succession.Record', 'readinessId'],
};
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
  const primary =
    (await loadIncumbentIds(tx, input.tenantId, [input.positionId], input.asOf)).get(input.positionId) ?? [];
  // R2-T05 前兼职端口为空；开关仅控制计算，不复用卡片 showIncumbents。
  const part = input.partTime
    ? ((await (partTimeReader ?? SUCCESSION_PORTS.riskPartTimeIncumbents)?.(ctx, input.positionId)) ?? [])
    : [];
  const records = await listActiveSuccessors(ctx, {
    successionType: 'position',
    targetPositionIds: [input.positionId],
  });
  const ids = [...new Set([...primary, ...part, ...records.map((r) => r.successorEmployeeId)])];
  const permissions = new Map<
    string,
    { fields: ReadonlySet<string>; scope: Awaited<ReturnType<typeof resolveDataScope>>; view: boolean }
  >();
  for (const code of new Set(fields.map((f) => fieldMap[f]?.[0]).filter((c): c is string => !!c))) {
    const subject = await loadSubject(tx, input.userId, code, { ...input, asOf: input.today });
    permissions.set(code, {
      fields:
        resolveObjectPermission(code, subject.objectPermissions, objectCatalog)?.effective.viewableFields ?? new Set(),
      view: decide(subject, { action: 'object.view', resource: code }, objectCatalog),
      scope: await resolveDataScope(tx, {
        ...input,
        asOf: input.today,
        appCode: objectCatalog.get(code)!.application!,
        objectCode: code,
      }),
    });
  }
  const people = new Map<string, RiskPerson>();
  const target = fields.includes('readiness_id')
    ? await loadJobObject(tx, input.tenantId, 'positions', input.positionId, input.today, true)
    : undefined;
  for (const id of ids) {
    const [row] = await readRiskPerson(tx, input, id);
    const person: RiskPerson = { id };
    for (const field of fields) {
      const mapping = fieldMap[field];
      const auth = mapping && permissions.get(mapping[0]);
      if (
        !auth?.view ||
        !auth.fields.has(mapping![1]) ||
        !scopeAllows(auth.scope, {
          orgId: field === 'readiness_id' ? (target?.orgId ?? undefined) : (row?.currentOrgId ?? undefined),
          personId: field === 'readiness_id' ? undefined : id,
        })
      )
        person[field] = { status: 'forbidden' };
      else if (!row || field === 'work_years')
        person[field] = { status: 'unavailable' }; // DEC-452 / F-100：累计工龄等待权威读源，不能按入职日臆算。
      else if (field === 'age') person[field] = ageOn(row.values.birthday as string | null, input.asOf);
      else if (field === 'readiness_id')
        person[field] = records.find((r) => r.successorEmployeeId === id)?.readinessId ?? null;
      else person[field] = row.values[field] ?? null;
    }
    people.set(id, person);
  }
  const from = (values: readonly string[]) => values.map((id) => people.get(id)!);
  return {
    incumbents: riskIncumbents(from(primary), from(part), input.partTime),
    successors: from([...new Set(records.map((r) => r.successorEmployeeId))]),
  };
}

async function readRiskPerson(tx: Tx, input: Parameters<typeof riskPeople>[1], id: string) {
  return rowsOf<{ values: Record<string, RiskValue>; orgId: string | null; currentOrgId: string | null }>(
    await tx.execute(sql`
      SELECT jsonb_build_object('name',COALESCE(v.name,e.name),'gender',v.gender,'birthday',v.birthday,
      'entry_date',r.body->>'entry_date','org_id',r.body->>'department_id','position_id',r.body->>'position_id',
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
