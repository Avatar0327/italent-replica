import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

/** Latest immutable payload projected at the authorization date, not the requested historical date. */
export function currentPersons(tenantId: string, asOf: string): SQL {
  return sql`
    SELECT r.employee_id,r.service_type,r.kind,
      CASE WHEN p.id IS NULL THEN r.department_id ELSE p.department_id END AS department_id,
      CASE WHEN p.id IS NULL THEN r.direct_manager_id ELSE p.direct_manager_id END AS direct_manager_id,
      CASE WHEN p.id IS NULL THEN r.dotted_manager_id ELSE p.dotted_manager_id END AS dotted_manager_id
    FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT p.id,p.department_id,p.direct_manager_id,p.dotted_manager_id
      FROM employment_payload_versions p WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id
        AND p.employee_id=r.employee_id AND p.is_record_snapshot ORDER BY p.version_no DESC LIMIT 1) p ON true
    WHERE t.tenant_id=${tenantId} AND t.valid_during @> ${asOf}::date
  `;
}
export function managedPersonsSql(tenantId: string, asOf: string, orgIds: readonly string[], person: SQL): SQL {
  if (!orgIds.length) return sql`false`;
  // TODO(需取证 Q-M0-29): §14.3 高级管理人员条件对象未定位；首版仅从当前任职组织归属派生。
  return sql`EXISTS (SELECT 1 FROM (${currentPersons(tenantId, asOf)}) managed
    WHERE managed.employee_id=${person} AND managed.department_id=ANY(${`{${orgIds.join(',')}}`}::uuid[]))`;
}

export function reportingPersonsSql(
  tenantId: string,
  asOf: string,
  employeeId: string,
  mode: string,
  person: SQL,
): SQL {
  const direct = ['direct', 'all_direct', 'direct_mixed', 'part_time'].includes(mode);
  const dotted = ['dotted', 'dotted_mixed'].includes(mode);
  const recursive = ['all_direct', 'direct_mixed', 'dotted_mixed', 'part_time'].includes(mode);
  const mixed = ['direct_mixed', 'dotted_mixed'].includes(mode);
  // TODO(需取证 Q-M0-31): 任职当前仅支持 primary；副职关系未接入时 part_time 必须为空。
  return sql`${person} IN (WITH RECURSIVE people AS (${currentPersons(tenantId, asOf)}),
    reports(employee_id) AS (
      SELECT employee_id FROM people WHERE kind NOT IN ('leave','retirement')
        AND employee_id<>${employeeId}::uuid
        AND ((${direct} AND direct_manager_id=${employeeId}::uuid)
          OR (${dotted} AND dotted_manager_id=${employeeId}::uuid))
        AND (${mode !== 'part_time'} OR service_type<>'primary')
      UNION
      SELECT p.employee_id FROM people p JOIN reports r ON
        (${direct || mixed} AND p.direct_manager_id=r.employee_id)
        OR (${dotted || mixed} AND p.dotted_manager_id=r.employee_id)
      WHERE ${recursive} AND p.kind NOT IN ('leave','retirement') AND p.employee_id<>${employeeId}::uuid
        AND (${mode !== 'part_time'} OR p.service_type<>'primary')
    ) SELECT employee_id FROM reports WHERE employee_id<>${employeeId}::uuid)`;
}
