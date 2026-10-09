/**
 * 任职资格审计里的“带出值”（R3-T02 设计 §5.2 #2 / #3、§8；第 2 轮 P2-05）：日志按写入时的完整内容保存（删除快照、
 * 覆盖前后值都要能还原，DEC-019），查询出口再按查看人**当前**对源对象的读取范围与源字段查看权裁剪，与业务接口一致：
 * - 标准的能力标准里来源为通用指标覆盖（`source = common_overwrite`）的内容 = 指标说明：查看人须有 Target 的查看权、
 *   description 字段查看权，且该指标在其读取范围内；否则去掉内容，只留 `projectionHidden` 标记；
 * - 指标等级描述首次手改时的 before 是等级明细描述的投影（`projected: true`，带来源方案）：查看人须对等级方案有查看权、
 *   details 字段查看权，且该方案在其读取范围内（字典：看全部 ∪ 创建人）；否则去掉该描述。
 * 前后值、快照、差异（含展示文本）都经过这里；字段级裁剪仍由 visibleValue / visibleChanges 做。
 */
import { QUALIFICATION_OBJECTS, type AuditFieldChange } from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import { getModuleViewableFields, type ModuleScope, resolveModuleScope } from '../modules/permission/module-access.js';
import { accessSql, qlReadable } from '../modules/qualification/access.js';

const STANDARD = QUALIFICATION_OBJECTS.standard.code;
const GRADE_DESCRIPTION = QUALIFICATION_OBJECTS.targetGradeDescription.code;

interface SourceRow {
  readonly objectType: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly changes: unknown;
}

/** 查看人对一类源对象的当前权限：null = 没有查看权或看不到该字段（一律隐藏）。 */
async function sourceScope(deps: TenantRouteDeps, ctx: TenantContext, code: string, field: string) {
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] }))) return null;
  const fields = await getModuleViewableFields(deps, ctx, code);
  if (fields !== undefined && !fields.has(field)) return null;
  return resolveModuleScope(deps, ctx, undefined, code);
}

export interface SourceRedactor {
  redact<T extends SourceRow>(tx: Tx, rows: readonly T[]): Promise<T[]>;
}

export async function qualificationSources(deps: TenantRouteDeps, ctx: TenantContext): Promise<SourceRedactor> {
  const targetScope = await sourceScope(deps, ctx, QUALIFICATION_OBJECTS.target.code, 'description');
  const schemeScope = await sourceScope(deps, ctx, QUALIFICATION_OBJECTS.gradeScheme.code, 'details');
  const scoped = { tenantId: ctx.tenantId, now: deps.clock(), timezone: ctx.timezone };
  return {
    async redact(tx, rows) {
      const targets = new Set<string>();
      const schemes = new Set<string>();
      for (const row of rows) {
        if (row.objectType === STANDARD) collectTargets([row.before, row.after, row.changes], targets);
        if (row.objectType === GRADE_DESCRIPTION) {
          const scheme = projectedScheme(row.before);
          if (scheme) schemes.add(scheme);
        }
      }
      if (!targets.size && !schemes.size) return [...rows];
      const readableTargets = await readable(tx, ctx.tenantId, 'ql_targets', [...targets], targetScope, (scope) =>
        qlReadable(scoped, scope, 't'),
      );
      const readableSchemes = await readable(
        tx,
        ctx.tenantId,
        'ql_grade_schemes',
        [...schemes],
        schemeScope,
        (scope) => accessSql(scoped, scope, 'dictionary', 't').readable,
      );
      return rows.map((row) => {
        if (row.objectType === STANDARD) return redactStandard(row, readableTargets);
        if (row.objectType === GRADE_DESCRIPTION) return redactProjection(row, readableSchemes);
        return row;
      });
    },
  };
}

async function readable(
  tx: Tx,
  tenantId: string,
  table: string,
  ids: readonly string[],
  scope: ModuleScope | null,
  predicate: (scope: ModuleScope) => ReturnType<typeof sql>,
): Promise<ReadonlySet<string>> {
  const valid = ids.filter((id) => UUID.test(id));
  if (!scope || !valid.length) return new Set();
  const result = await tx.execute(sql`SELECT t.id FROM ${sql.identifier(table)} t
    WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ANY(${`{${valid.join(',')}}`}::uuid[]) AND ${predicate(scope)}`);
  const rows = (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isOverwritten = (value: Record<string, unknown>) =>
  value.source === 'common_overwrite' && typeof value.sourceTargetId === 'string';

function collectTargets(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) return value.forEach((item) => collectTargets(item, into));
  if (!isObject(value)) return;
  if (isOverwritten(value)) into.add(value.sourceTargetId as string);
  for (const inner of Object.values(value)) collectTargets(inner, into);
}

/** 深拷贝时去掉看不到的通用指标覆盖内容。 */
function hideOverwritten(value: unknown, allowed: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => hideOverwritten(item, allowed));
  if (!isObject(value)) return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, hideOverwritten(inner, allowed)]));
  if (!isOverwritten(value) || allowed.has(value.sourceTargetId as string)) return copy;
  const { content: _hidden, ...rest } = copy;
  return { ...rest, projectionHidden: true };
}

function redactStandard<T extends SourceRow>(row: T, allowed: ReadonlySet<string>): T {
  return {
    ...row,
    before: hideOverwritten(row.before, allowed),
    after: hideOverwritten(row.after, allowed),
    changes: Array.isArray(row.changes)
      ? (row.changes as AuditFieldChange[]).map(({ fromText: _f, toText: _t, ...change }) => ({
          ...change,
          from: hideOverwritten(change.from, allowed),
          to: hideOverwritten(change.to, allowed),
        }))
      : row.changes,
  };
}

function projectedScheme(before: unknown): string | null {
  return isObject(before) && before.projected === true && typeof before.gradeSchemeId === 'string'
    ? before.gradeSchemeId
    : null;
}

/** 等级描述的投影值（首次手改的 before）：看不到来源方案时去掉，差异里的“从”同样去掉。 */
function redactProjection<T extends SourceRow>(row: T, allowed: ReadonlySet<string>): T {
  const scheme = projectedScheme(row.before);
  if (!scheme || allowed.has(scheme)) return row;
  const { description: _hidden, ...before } = row.before as Record<string, unknown>;
  return {
    ...row,
    before,
    changes: Array.isArray(row.changes)
      ? (row.changes as AuditFieldChange[]).map(({ fromText: _f, toText: _t, ...change }) =>
          change.field === 'description' ? { ...change, from: null } : change,
        )
      : row.changes,
  };
}
