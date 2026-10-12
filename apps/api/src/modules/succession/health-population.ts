/** §4.4：人口为本组织及行政下级的在职主职；自定义范围仍以 B1 的原始行编译求值。 */
import { sql, type Tx } from '@italent/db';
import {
  ageOn,
  decimalYears,
  type OrgId,
  type PlainValue,
  type RuleSet,
  POPULATION_FIELDS,
  compilePopulation,
  evaluateFormula,
  inMemorySubject,
  resolveObjectPermission,
  decide,
} from '@italent/domain';
import { listOrgDescendantsInTransaction } from '../org/hierarchy-reader.js';
import { loadSubject } from '../permission/subject.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { objectCatalog } from '../permission/catalog.js';
import { scopeAllows } from '../permission/module-access.js';
import { CalcObjectFailure, CalcBlocked } from './calc-contract.js';
import { INCUMBENT_EXCLUDED_STATUSES, rowsOf } from './read-sql.js';
import { populationViews } from './config-store.js';
export interface HealthPerson {
  id: string;
  orgId: string;
  fields: Record<string, PlainValue>;
}
export async function healthPeople(tx: Tx, tenantId: string, orgId: string, asOf: string): Promise<HealthPerson[]> {
  const descendants = await listOrgDescendantsInTransaction(
    tx,
    { tenantId, orgId: orgId as OrgId, dimension: 'admin', asOf },
    { includeDisabled: false },
  );
  // 任职接口 read-model 的同一来源规则：完整快照可保留显式 null，入职日期属于记录／任职周期。
  const department = sql`CASE WHEN p.body IS NULL THEN r.department_id::text ELSE p.body->>'department_id' END`;
  const people = rowsOf<{
    id: string;
    org_id: string;
    profile: Record<string, string | null>;
    entry_date: string;
    position_id: string | null;
    level_id: string | null;
    sequence_id: string | null;
    employee_status: number;
  }>(
    await tx.execute(sql`SELECT DISTINCT ON (e.id) e.id,${department} AS org_id,
    COALESCE(to_jsonb(v),'{}'::jsonb)||jsonb_build_object('name',COALESCE(v.name,e.name)) AS profile,
    r.entry_date::text AS entry_date,
    CASE WHEN p.body IS NULL THEN r.position_id::text ELSE p.body->>'position_id' END AS position_id,
    CASE WHEN p.body IS NULL THEN r.level_id::text ELSE p.body->>'level_id' END AS level_id,
    CASE WHEN p.body IS NULL THEN r.sequence_id::text ELSE p.body->>'sequence_id' END AS sequence_id,
    s.employee_status FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN employment_employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id
    LEFT JOIN LATERAL (SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL employment_record_status(t.tenant_id,r.id) s ON true
    LEFT JOIN LATERAL (SELECT * FROM personnel_employee_versions v WHERE v.tenant_id=e.tenant_id AND v.employee_id=e.id
      ORDER BY revision DESC LIMIT 1) v ON true
    WHERE t.tenant_id=${tenantId}::uuid AND t.valid_during @> ${asOf}::date AND r.service_type='primary'
    AND s.employee_status NOT IN (${INCUMBENT_EXCLUDED_STATUSES})
    AND NOT EXISTS (SELECT 1 FROM employment_record_tombstones d WHERE d.tenant_id=r.tenant_id AND d.record_id=r.id)
    AND (${department})::uuid=ANY(${`{${[orgId, ...descendants].join(',')}}`}::uuid[])
    ORDER BY e.id,t.start_date DESC,t.sort_order DESC`),
  );
  return people.map(({ id, org_id, profile: p, ...r }) => ({
    id,
    orgId: org_id,
    fields: {
      'employee.name': p.name,
      'employee.gender': p.gender,
      'employee.age': ageOn(p.birthday ?? null, asOf),
      'employee.entry_date': r.entry_date,
      'employee.work_years': p.work_date
        ? Number(decimalYears(Math.max(0, (Date.parse(asOf) - Date.parse(p.work_date)) / 86400000), 4))
        : null,
      'employment.org_id': org_id,
      'employment.position_id': r.position_id,
      'employment.job_level_id': r.level_id,
      'employment.job_sequence_id': r.sequence_id,
      'employment.employee_status': r.employee_status,
    },
  }));
}
const sourceField: Record<string, string> = {
  age: 'birthday',
  work_years: 'workDate',
  entry_date: 'entryDate',
  org_id: 'departmentId',
  position_id: 'positionId',
  job_level_id: 'levelId',
  job_sequence_id: 'sequenceId',
  employee_status: 'employeeStatus',
};
export async function customHealthPopulation(
  tx: Tx,
  tenantId: string,
  userId: string,
  today: string,
  asOf: string,
  timezone: string,
  populationId: string,
  people: readonly HealthPerson[],
) {
  const [population] = await populationViews(tx, tenantId, [populationId]);
  if (!population || population.compileError) throw new CalcBlocked('RULE_CACHE_STALE');
  const compiled = compilePopulation(population.rules as RuleSet);
  if (!compiled.ok) throw new CalcBlocked('RULE_CACHE_STALE');
  const objectCode = 'TenantBase.EmployeeInformation';
  const subject = await loadSubject(tx, userId, objectCode, { tenantId, userId, asOf: today });
  const permission = resolveObjectPermission(objectCode, subject.objectPermissions, objectCatalog);
  const scope = await resolveDataScope(tx, { tenantId, userId, appCode: 'TenantBase', objectCode, asOf: today });
  const fields = (population.rules as RuleSet).rows.flatMap((r) => (r.field ? [r.field] : []));
  if (
    !decide(subject, { action: 'object.view', resource: objectCode }, objectCatalog) ||
    !permission ||
    fields.some((f) => !permission.effective.viewableFields.has(sourceField[f.code] ?? f.code))
  )
    throw new CalcObjectFailure('FIELD_FORBIDDEN', true);
  return people.filter((p) => {
    if (!scopeAllows(scope, { orgId: p.orgId, personId: p.id })) throw new CalcObjectFailure('FIELD_FORBIDDEN', true);
    const result = evaluateFormula(compiled.compiled.formula, {
      calendar: { today: asOf, timeZone: timezone },
      subject: inMemorySubject(p.id, p.fields),
      fieldKind: (path) => {
        const kind = POPULATION_FIELDS.find((f) => f.path === path)?.kind;
        return kind === 'option' ? 'text' : kind;
      },
    });
    if (!result.ok) throw new CalcObjectFailure(result.failure.code, true);
    return result.value.kind === 'number' && result.value.value === 1;
  });
}
