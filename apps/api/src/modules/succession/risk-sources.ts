/** §4.1：来源身份、字段与实际对象范围在同一入口判定，目标来源不依赖人口是否为空。 */
import type { Tx } from '@italent/db';
import { decide, resolveObjectPermission, PERSONNEL_OBJECT, type RiskSourceState } from '@italent/domain';
import { loadSubject } from '../permission/subject.js';
import { objectCatalog } from '../permission/catalog.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { scopeAllows } from '../permission/module-access.js';
import { loadJobObject } from '../job/read-model.js';

type ScopeTarget = Parameters<typeof scopeAllows>[1];
type ObjectContext = { kind: 'object'; target: ScopeTarget | null };
interface RiskSourceContext {
  position: ObjectContext;
  person: ObjectContext | { kind: 'population' };
}
interface SourcePermission {
  fields: ReadonlySet<string>;
  scope: Awaited<ReturnType<typeof resolveDataScope>>;
  view: boolean;
}
const fieldMap: Record<string, [string, string, keyof RiskSourceContext]> = {
  name: [PERSONNEL_OBJECT, 'name', 'person'],
  gender: [PERSONNEL_OBJECT, 'gender', 'person'],
  age: [PERSONNEL_OBJECT, 'age', 'person'],
  entry_date: [PERSONNEL_OBJECT, 'entryDate', 'person'],
  work_years: [PERSONNEL_OBJECT, 'workDate', 'person'],
  org_id: ['TenantBase.EmploymentRecord', 'departmentId', 'person'],
  position_id: ['TenantBase.EmploymentRecord', 'positionId', 'person'],
  job_level_id: ['TenantBase.EmploymentRecord', 'levelId', 'person'],
  job_sequence_id: ['TenantBase.EmploymentRecord', 'sequenceId', 'person'],
  employee_status: ['TenantBase.EmploymentRecord', 'employeeStatus', 'person'],
  readiness_id: ['Succession.Record', 'readinessId', 'position'],
};
function sourceState(
  field: string,
  permission: SourcePermission | undefined,
  fieldCode: string,
  context: RiskSourceContext[keyof RiskSourceContext],
): RiskSourceState {
  if (!permission?.view || !permission.fields.has(fieldCode)) return { status: 'forbidden' };
  if (context.kind === 'object') {
    if (!context.target) return { status: 'unavailable' };
    if (!scopeAllows(permission.scope, context.target)) return { status: 'forbidden' };
  } else if (!permission.scope.hasDataPermission) {
    // 仅人员人口预检使用“范围非空”；实际职位 / 人员授权必须走上方 scopeAllows。
    return { status: 'forbidden' };
  }
  // DEC-452 / F-100：累计工龄来源未接入，不能用空人口代替 unavailable。
  return { status: field === 'work_years' ? 'unavailable' : 'available' };
}
function riskSources(
  fields: readonly string[],
  permissions: ReadonlyMap<string, SourcePermission>,
  context: RiskSourceContext,
): Readonly<Record<string, RiskSourceState>> {
  return Object.fromEntries(
    fields.map((field) => {
      const binding = fieldMap[field];
      const state = binding
        ? sourceState(field, permissions.get(binding[0]), binding[1], context[binding[2]])
        : { status: 'unavailable' as const };
      return [field, state];
    }),
  );
}
export async function loadRiskSources(
  tx: Tx,
  input: { tenantId: string; userId: string; positionId: string; today: string },
  fields: readonly string[],
) {
  const permissions = new Map<string, SourcePermission>();
  for (const code of new Set(fields.map((field) => fieldMap[field]?.[0]).filter((code): code is string => !!code))) {
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
  const target = fields.some((field) => fieldMap[field]?.[2] === 'position')
    ? await loadJobObject(tx, input.tenantId, 'positions', input.positionId, input.today, true)
    : undefined;
  const position: ObjectContext = { kind: 'object', target: target?.orgId ? { orgId: target.orgId } : null };
  return {
    sources: riskSources(fields, permissions, { position, person: { kind: 'population' } }),
    forPerson: (person: ScopeTarget | null) =>
      riskSources(fields, permissions, { position, person: { kind: 'object', target: person } }),
  };
}
