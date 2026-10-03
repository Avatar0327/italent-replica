import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

/** The T05 head remains immutable; current person attributes come from the T12 version chain. */
export function currentPersonName(tenantId: string, employee: SQL, originalName: SQL) {
  return sql`COALESCE((SELECT p.name FROM personnel_employee_versions p
    WHERE p.tenant_id=${tenantId} AND p.employee_id=${employee}
    ORDER BY p.revision DESC LIMIT 1),${originalName})`;
}
