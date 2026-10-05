import { isUuid, sql, withTenant } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { EmploymentContext } from '../employment/types.js';
import { scopeSql } from '../permission/module-access.js';
import { creatorSql } from '../permission/scope-audit.js';
import { currentPersons } from '../permission/scope-persons.js';

const MANAGERS = new Set(['directManagerId', 'dottedManagerId']);
const managerCode = (code: unknown) => typeof code === 'string' && MANAGERS.has(code.replace(/^preset:/, ''));

/** 遍历响应副本：除了任职字段，也覆盖向后更新提醒中的经理 before/after。 */
function mapManagerReferences(value: unknown, map: (id: string) => string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => mapManagerReferences(item, map));
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const change = managerCode(source.field);
  return Object.fromEntries(
    Object.entries(source).map(([key, field]) => [
      key,
      key === 'addedSubordinateIds' && Array.isArray(field)
        ? field
            .filter((id): id is string => typeof id === 'string' && isUuid(id))
            .map(map)
            .filter(Boolean)
        : (MANAGERS.has(key) || (change && (key === 'before' || key === 'after'))) &&
            typeof field === 'string' &&
            isUuid(field)
          ? map(field)
          : mapManagerReferences(field, map),
    ]),
  );
}

/**
 * PR #63 P3-3：Switch 31只放宽目标部门，不授权其负责人。当前人员范围同样用于历史原经理。
 * 只处理事务结束后的响应副本；不改继承快照、业务载荷、审计或自动带出/手选的保存规则。
 */
export async function trimEmploymentManagerReferences(
  deps: Pick<TenantRouteDeps, 'db'>,
  ctx: EmploymentContext,
  value: unknown,
): Promise<unknown> {
  if (!ctx.scope || ctx.scope.all) return value;
  const scope = ctx.scope;
  const ids = new Set<string>();
  mapManagerReferences(value, (id) => {
    ids.add(id.toLowerCase());
    return id;
  });
  if (!ids.size) return value;
  const allowed = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const result = await tx.execute(sql`
      SELECT e.id FROM employment_employees e
      LEFT JOIN (${currentPersons(ctx.tenantId, tenantLocalDate(ctx.now, ctx.timezone))}) p ON p.employee_id=e.id
      WHERE e.tenant_id=${ctx.tenantId} AND e.id=ANY(${`{${[...ids].join(',')}}`}::uuid[])
        AND ${scopeSql(scope, {
          person: sql`e.id`,
          org: sql`p.department_id`,
          creator: creatorSql(ctx.tenantId, sql`e.id`, 'employment.employee.create', 'employment_employee'),
        })}
    `);
    const rows = (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[];
    return new Set(rows.map((row) => row.id));
  });
  return mapManagerReferences(value, (id) => (allowed.has(id.toLowerCase()) ? id : null));
}
