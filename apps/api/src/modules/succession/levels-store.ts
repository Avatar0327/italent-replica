/** #11 的读取在单条 SQL 中取头部与条件行，避免 READ COMMITTED 下拼接两个版本（同 B2a）。 */
import { sql, type Tx } from '@italent/db';
import {
  compileLevelComparisons,
  compileSuccessionLevel,
  type RuleFieldRef,
  type SuccessionLevelKind,
  type SuccessionLevelRules,
} from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { codeOf, type SuccessionContext } from './access.js';
import { configAccess, missing, projectConfig, type ConfigView } from './config-store.js';
import { rowsOf } from './read-sql.js';
import type { ResultAdapter } from './write-support.js';
export const levelSpec = (kind: SuccessionLevelKind) => ({
  object: kind === 'risk' ? ('riskLevel' as const) : ('healthLevel' as const),
  ruleKind: kind === 'risk' ? ('position_risk' as const) : ('org_health' as const),
  table: sql.identifier(`succession_${kind}_levels`),
  rows: sql.identifier(`succession_${kind}_level_rows`),
});
export interface LevelView extends ConfigView {
  rules: SuccessionLevelRules | null;
}
interface StoredLevelView extends LevelView {
  reviewFields: RuleFieldRef[];
}
// 字段元信息只供重建过滤警告；与头／条件行共用一个 MVCC 快照，assemble 后即移除，永不出站。
const reviewFieldsSql = (kind: SuccessionLevelKind) =>
  kind === 'risk'
    ? sql`'[]'::jsonb`
    : sql`
  COALESCE((SELECT jsonb_agg(jsonb_build_object('object', 'review_object', 'code', f.code,
    'path', 'review_object.' || f.code, 'kind', f.kind, 'optionDomain',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('value', o.value, 'label', o.label, 'enabled', o.enabled))
      FROM talent_review_field_options o WHERE o.tenant_id = f.tenant_id AND o.field_id = f.id), '[]'::jsonb)))
    FROM talent_review_fields f WHERE f.tenant_id = p.tenant_id AND f.code IN (
      SELECT r.field_code FROM succession_health_level_rows r WHERE r.tenant_id = p.tenant_id
        AND r.level_id = p.id AND r.field_source = 'review')), '[]'::jsonb)`;
const viewColumns = (kind: SuccessionLevelKind) => sql`p.id, p.code, p.name, p.color, p.description, p.enabled,
  p.display_order AS "displayOrder", p.revision, p.compile_error AS "compileError",
  CASE WHEN p.condition_expression IS NULL THEN NULL ELSE jsonb_build_object('expression', p.condition_expression,
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r) - 'tenant_id' - 'id' - 'level_id' ORDER BY r.row_no)
      FROM ${levelSpec(kind).rows} r WHERE r.tenant_id = p.tenant_id
        AND r.level_id = p.id), '[]'::jsonb)) END AS rules, ${reviewFieldsSql(kind)} AS "reviewFields"`;
function assemble(stored: StoredLevelView, kind: SuccessionLevelKind): LevelView {
  const { reviewFields, ...view } = stored;
  const result: LevelView = {
    ...view,
    rules:
      view.rules === null
        ? null
        : {
            ...view.rules,
            rows: view.rules.rows.map(
              (row) =>
                Object.fromEntries(
                  Object.entries(row).map(([key, value]) => [
                    key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()),
                    value,
                  ]),
                ) as unknown as SuccessionLevelRules['rows'][number],
            ),
          },
  };
  if (result.rules === null) return { ...result, warnings: [] };
  const compiled = compileSuccessionLevel(kind, result.rules, reviewFields);
  const compared = compileLevelComparisons(result.rules);
  let warnings = compared.ok ? compared.warnings : [];
  if (compiled.ok) warnings = compiled.warnings;
  return { ...result, warnings };
}
export async function levelViews(tx: Tx, tenantId: string, kind: SuccessionLevelKind, ids: readonly string[]) {
  if (!ids.length) return [];
  const views = rowsOf<StoredLevelView>(
    await tx.execute(sql`SELECT ${viewColumns(kind)} FROM ${levelSpec(kind).table} p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.id = ANY(${`{${ids.join(',')}}`}::uuid[])`),
  ).map((view) => assemble(view, kind));
  return ids.flatMap((id) => views.filter((view) => view.id === id));
}
export const collectionRevisionSql = (
  tenantId: string,
  kind: SuccessionLevelKind,
) => sql`COALESCE((SELECT levels_revision
  FROM succession_rule_settings WHERE tenant_id = ${tenantId}::uuid AND kind = ${levelSpec(kind).ruleKind}), 0)`;
export async function listLevels(
  tx: Tx,
  tenantId: string,
  kind: SuccessionLevelKind,
  page: { limit: number; offset: number },
) {
  const [found] = rowsOf<{ items: StoredLevelView[]; total: number; collectionRevision: number }>(
    await tx.execute(sql`
    SELECT ${collectionRevisionSql(tenantId, kind)} AS "collectionRevision",
      (SELECT count(*)::int FROM ${levelSpec(kind).table} WHERE tenant_id = ${tenantId}::uuid) AS total,
      COALESCE((SELECT jsonb_agg(x ORDER BY x."displayOrder", x.id) FROM
        (SELECT ${viewColumns(kind)} FROM ${levelSpec(kind).table} p WHERE p.tenant_id = ${tenantId}::uuid
          ORDER BY p.display_order, p.id LIMIT ${page.limit} OFFSET ${page.offset}) x), '[]'::jsonb) AS items`),
  );
  return { ...found!, items: found!.items.map((view) => assemble(view, kind)) };
}
export function levelResults(kind: SuccessionLevelKind): ResultAdapter<LevelView> {
  const object = levelSpec(kind).object;
  return {
    object,
    async load(tx, deps, ctx, ids, options) {
      await configAccess(tx, deps, ctx, object);
      const views = await levelViews(tx, ctx.tenantId, kind, ids);
      if (options.includeDeleted)
        for (const id of ids.filter((id) => !views.some((view) => view.id === id))) {
          const [audit] = rowsOf<{ snapshot: LevelView }>(
            await tx.execute(sql`SELECT "before" AS snapshot FROM audit_events
          WHERE tenant_id = ${ctx.tenantId}::uuid AND object_type = ${codeOf(object)} AND object_id = ${id}
            AND action = ${`succession.${kind}-level.delete`} ORDER BY occurred_at DESC LIMIT 1`),
          );
          if (audit) views.push(audit.snapshot);
        }
      if (views.length !== ids.length) throw missing();
      return { views, revisions: new Map(views.map((view) => [view.id, view.revision])) };
    },
    project: (deps: TenantRouteDeps, ctx: SuccessionContext, views) => projectConfig(deps, ctx, object, views),
  };
}
