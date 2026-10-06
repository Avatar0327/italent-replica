/**
 * DEC-197（PR #75 第二轮 P1-1）：审计查询按查看人**当前**的数据范围与字段权限裁剪，不设全量读取特权。
 * 「日志审计」能力只决定能不能进入查询；每条日志能否返回、返回哪些字段，取决于它的归属（迁移 0051 推导）：
 * - 有权限对象编码的（任职、员工、人员信息、合同、组织、编制、职务体系）：按该对象的当前数据范围判断——
 *   任职按 DEC-177（记录部门 ∪ 员工当前部门），人员类按所属人员，组织类按所属组织，无归属的按“有该对象数据权限”；
 *   字段按该对象的当前查看字段裁剪，至少有一个可见字段变化的日志才返回（隐藏字段不能被字段筛选探测出来）；
 * - 配置类对象（无人员 / 组织归属）：按管理该配置的企业设置能力判断（AUDIT_CONFIG_CAPABILITIES），未登记的不返回。
 * 行级判断全部在 SQL 里、分页之前完成；字段裁剪在返回前对差异、前后值、快照与任务错误报告逐项执行。
 * 创建人维度（使用用户）不参与审计可见判断（fail-closed）。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import { AUDIT_CONFIG_CAPABILITIES, auditFieldCode, type AuditFieldChange, MODULE_OBJECTS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import { employmentVisibilitySql } from '../modules/employment/visibility.js';
import {
  getModuleViewableFields,
  type ModuleScope,
  resolveModuleScope,
  scopeSql,
} from '../modules/permission/module-access.js';

const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;

interface ObjectAccess {
  readonly scope: ModuleScope;
  /** undefined = 不限字段（看全部 / 可信端口）。 */
  readonly fields: ReadonlySet<string> | undefined;
}

export interface AuditViewer {
  /** 数据变更日志的行级可见谓词（含字段筛选的可见性）。 */
  readonly dataChanges: SQL;
  /** 对象操作日志的行级可见谓词。 */
  readonly operationLogs: SQL;
  fieldsOf(scopeObject: string | null): ReadonlySet<string> | undefined;
}

/** 在查询事务之外解析（范围解析各自开租户事务）；返回的谓词放进查询的 WHERE，分页之前生效。 */
export async function auditViewer(
  deps: Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>,
  ctx: TenantContext,
  field?: string,
): Promise<AuditViewer> {
  const objects = await withTenant(deps.db, ctx.tenantId, (tx) => scopeObjectsIn(tx, ctx.tenantId));
  const access = new Map<string, ObjectAccess>();
  for (const code of objects) {
    const scope = await resolveModuleScope(deps, ctx, undefined, code);
    access.set(code, { scope, fields: await getModuleViewableFields(deps, ctx, code) });
  }
  const configTypes: string[] = [];
  const held = new Map<string, boolean>();
  for (const [objectType, capability] of Object.entries(AUDIT_CONFIG_CAPABILITIES)) {
    if (!held.has(capability)) {
      held.set(capability, await deps.authorize({ ...ctx, action: `admin.${capability}` }));
    }
    if (held.get(capability)) configTypes.push(objectType);
  }
  const config = configTypes.length
    ? sql`(scope_object IS NULL AND object_type = ANY(${`{${configTypes.map(quote).join(',')}}`}::text[]))`
    : sql`false`;
  const objectPredicates = (withFields: boolean) =>
    [...access].map(
      ([code, entry]) => sql`(scope_object = ${code} AND ${rowScope(code, entry.scope, withFields)}
      AND ${withFields ? fieldScope(entry.fields, field) : sql`true`})`,
    );
  return {
    dataChanges: sql`(${sql.join([...objectPredicates(true), config], sql` OR `)})`,
    operationLogs: sql`(${sql.join([...objectPredicates(false), config], sql` OR `)})`,
    fieldsOf: (scopeObject) => (scopeObject ? access.get(scopeObject)?.fields : undefined),
  };
}

function rowScope(code: string, scope: ModuleScope, withOrg: boolean): SQL {
  if (scope.all) return sql`true`;
  if (code === EMPLOYMENT && withOrg) {
    return employmentVisibilitySql(scope, { employee: sql`scope_employee_id`, department: sql`scope_org_id` });
  }
  const anyData = scope.hasDataPermission ? sql`true` : sql`false`;
  const person = scopeSql(scope, { person: sql`scope_employee_id` });
  const org = withOrg ? scopeSql(scope, { org: sql`scope_org_id` }) : sql`false`;
  const orgColumn = withOrg ? sql`scope_org_id` : sql`NULL::uuid`;
  return sql`((scope_employee_id IS NOT NULL AND ${person})
    OR (scope_employee_id IS NULL AND ${orgColumn} IS NOT NULL AND ${org})
    OR (scope_employee_id IS NULL AND ${orgColumn} IS NULL AND ${anyData}))`;
}

/** 至少一个可见字段发生变化；带字段筛选时该字段本身也必须可见。 */
function fieldScope(fields: ReadonlySet<string> | undefined, field: string | undefined): SQL {
  if (fields === undefined) return sql`true`;
  if (field !== undefined && !fields.has(auditFieldCode(field))) return sql`false`;
  const visible = `{${[...fields].map(quote).join(',')}}`;
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(changes, '[]'::jsonb)) visible_change
    WHERE (CASE WHEN visible_change->>'field' LIKE 'customFields.%'
      THEN 'custom:' || substr(visible_change->>'field', 14)
      ELSE regexp_replace(visible_change->>'field', '^.*\\.', '') END) = ANY(${visible}::text[]))`;
}

/** 本租户日志里出现过的权限对象编码（松散索引扫描，按 (tenant_id, scope_object) 索引逐个跳读）。 */
async function scopeObjectsIn(tx: Tx, tenantId: string): Promise<string[]> {
  const found = new Set<string>();
  for (const table of ['audit_events', 'audit_operation_logs']) {
    const name = sql.identifier(table);
    const result = await tx.execute(sql`WITH RECURSIVE found AS (
        (SELECT scope_object FROM ${name} WHERE tenant_id = ${tenantId} AND scope_object IS NOT NULL
          ORDER BY scope_object LIMIT 1)
        UNION ALL
        SELECT (SELECT n.scope_object FROM ${name} n WHERE n.tenant_id = ${tenantId}
                 AND n.scope_object > found.scope_object ORDER BY n.scope_object LIMIT 1)
          FROM found WHERE found.scope_object IS NOT NULL
      ) SELECT scope_object FROM found WHERE scope_object IS NOT NULL`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { scope_object: string }[];
    for (const row of rows) found.add(row.scope_object);
  }
  return [...found].sort();
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** 差异只留可见字段。 */
export function visibleChanges(
  changes: readonly AuditFieldChange[],
  fields: ReadonlySet<string> | undefined,
): AuditFieldChange[] {
  return fields === undefined ? [...changes] : changes.filter((change) => fields.has(auditFieldCode(change.field)));
}

/** 前后值 / 快照只留可见字段；嵌套的 fields / customFields 等容器逐层裁剪，空容器去掉。 */
export function visibleValue(value: unknown, fields: ReadonlySet<string> | undefined, prefix = ''): unknown {
  if (fields === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner) && !prefix) {
      const nested = visibleValue(inner, fields, path) as Record<string, unknown>;
      if (Object.keys(nested).length) kept[key] = nested;
    } else if (fields.has(auditFieldCode(path))) {
      kept[key] = inner;
    }
  }
  return kept;
}

/** 任务错误报告：行号、错误码、原因是任务协议信息，其余（来源编码、编码等）按字段权限裁剪。 */
export function visibleErrorReport(report: unknown, fields: ReadonlySet<string> | undefined): unknown {
  if (fields === undefined || !Array.isArray(report)) return report;
  const protocol = new Set(['rowIndex', 'errorCode', 'reason']);
  return report.map((entry) =>
    entry && typeof entry === 'object'
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).filter(([key]) => protocol.has(key) || fields.has(key)),
        )
      : entry,
  );
}
