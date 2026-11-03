/** 投影需要同员工的前序业务解析继承；候选先按员工的任一可见任职段收窄，贡献再逐段验权。 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { employmentCreator } from '../employment/context.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import type { EmploymentContext } from '../employment/types.js';

export function projectionEmployeeScope(ctx: EmploymentContext, employee: SQL): SQL {
  const creator = employmentCreator(ctx.tenantId, employee);
  const current = employmentVisibilitySql(ctx.scope, { employee, department: sql`NULL::uuid`, creator });
  const historical = employmentVisibilitySql(ctx.scope, {
    employee,
    department: sql`visible_p.department_id`,
    creator,
  });
  return sql`(${current} OR EXISTS (SELECT 1 FROM employment_payload_versions visible_p
    WHERE visible_p.tenant_id=${ctx.tenantId} AND visible_p.employee_id=${employee} AND ${historical}))`;
}
