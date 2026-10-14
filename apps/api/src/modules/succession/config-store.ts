/** B2a 配置读写共用的数据与投影；配置无组织字段，只认当前身份的看全部（设计 §8）。 */
import { sql, type Tx } from '@italent/db';
import {
  POPULATION_FIELDS,
  compilePopulation,
  SUCCESSION_DEFAULT_COLORS,
  type RuleCompileError,
  type RuleSet,
  type SuccessionRuleKind,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  getModuleViewableFields,
} from '../permission/module-access.js';
import { codeOf, type SuccessionContext } from './access.js';
import { rowsOf } from './read-sql.js';
import { ruleErrors } from './population-input.js';
import type { ResultAdapter } from './write-support.js';

export type ConfigObject = 'population' | 'ruleSettings' | 'riskLevel' | 'healthLevel';
export interface ConfigView {
  readonly id: string;
  readonly revision: number;
  readonly [key: string]: unknown;
}
export const missing = () => new AppError('NOT_FOUND', '配置不存在');
export async function configAccess(tx: Tx, deps: TenantRouteDeps, ctx: SuccessionContext, object: ConfigObject) {
  const scope = await resolveModuleScopeInTransaction(
    { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) },
    ctx,
    tx,
    codeOf(object),
  );
  if (!scope.all) throw new AppError('FORBIDDEN', '规则配置需要看全部权限');
}
export async function projectConfig(
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  object: ConfigObject,
  views: readonly ConfigView[],
) {
  const fields = await getModuleViewableFields(deps, ctx, codeOf(object));
  return views.map((view) =>
    fields === undefined
      ? view
      : Object.fromEntries(Object.entries(view).filter(([key]) => fields.has(key === 'warnings' ? 'rules' : key))),
  );
}
export async function settingsView(tx: Tx, tenantId: string, kind: SuccessionRuleKind): Promise<ConfigView> {
  const [row] = rowsOf<ConfigView>(
    await tx.execute(sql`SELECT kind AS id, kind,
    default_color AS "defaultColor", revision FROM succession_rule_settings
    WHERE tenant_id = ${tenantId}::uuid AND kind = ${kind}`),
  );
  return row ?? { id: kind, kind, defaultColor: SUCCESSION_DEFAULT_COLORS[kind], revision: 0 };
}
/** 规则集合锁 → 对象行锁；所有人群命令与重编译同序，B2b 等级集合复用同一行（设计 §7）。 */
export async function lockRuleSettings(tx: Tx, tenantId: string, kind: SuccessionRuleKind) {
  await tx.execute(sql`INSERT INTO succession_rule_settings(tenant_id, kind, default_color)
    VALUES (${tenantId}::uuid, ${kind}, ${SUCCESSION_DEFAULT_COLORS[kind]}) ON CONFLICT DO NOTHING`);
  await tx.execute(sql`SELECT kind FROM succession_rule_settings
    WHERE tenant_id = ${tenantId}::uuid AND kind = ${kind} FOR UPDATE`);
}
export function requireRevision(view: ConfigView, expected: number) {
  if (view.revision !== expected) throw new AppError('REVISION_CONFLICT', '配置已被修改，请刷新后重试');
}
export async function populationViews(tx: Tx, tenantId: string, ids: readonly string[]): Promise<ConfigView[]> {
  if (!ids.length) return [];
  const array = `{${ids.join(',')}}`;
  // 一条语句共用 MVCC 快照，避免并发保存把头部与条件行拼成从未提交过的规则。
  const parents = rowsOf<
    ConfigView & {
      expression: string;
      errors: RuleCompileError[] | null;
      rows: {
        row_no: number;
        field_code: string;
        filter_operator: RuleSet['rows'][number]['operator'];
        filter_values: (string | number | boolean)[];
      }[];
    }
  >(
    await tx.execute(sql`SELECT p.id, p.code, p.name, p.display_order AS "displayOrder", p.revision,
      p.condition_expression AS expression, p.compile_error AS errors,
      COALESCE((SELECT jsonb_agg(r ORDER BY r.row_no) FROM succession_population_rows r
        WHERE r.tenant_id = p.tenant_id AND r.population_id = p.id), '[]'::jsonb) AS rows
      FROM succession_populations p WHERE p.tenant_id = ${tenantId}::uuid AND p.id = ANY(${array}::uuid[])`),
  );
  const views = parents.map(({ expression, errors, rows, ...parent }) => ({
    ...parent,
    rules: {
      expression,
      rows: rows.map((row) => ({
        rowNo: row.row_no,
        kind: 'field',
        field: POPULATION_FIELDS.find((field) => field.code === row.field_code) ?? {
          object: 'employee',
          code: row.field_code,
          path: `employee.${row.field_code}`,
          kind: 'text',
        },
        operator: row.filter_operator,
        values: row.filter_values,
      })),
    },
    compileError: errors ? ruleErrors(errors) : null,
  }));
  return ids.flatMap((id) => {
    const view = views.find((view) => view.id === id);
    if (!view) return [];
    const result = compilePopulation(view.rules as RuleSet);
    return [{ ...view, warnings: result.ok ? result.warnings : [] }];
  });
}
export function configResults(object: 'population' | 'ruleSettings'): ResultAdapter<ConfigView> {
  return {
    object,
    async load(tx, deps, ctx, ids, options) {
      await configAccess(tx, deps, ctx, object);
      const views =
        object === 'ruleSettings'
          ? await Promise.all(ids.map((id) => settingsView(tx, ctx.tenantId, id as SuccessionRuleKind)))
          : await populationViews(tx, ctx.tenantId, ids);
      // 物理删除释放编码；同键删除重放按同事务留下的快照复核和返回回执。
      if (object === 'population' && options.includeDeleted) {
        for (const id of ids.filter((id) => !views.some((view) => view.id === id))) {
          const [audit] = rowsOf<{ snapshot: ConfigView }>(
            await tx.execute(sql`SELECT "before" AS snapshot
            FROM audit_events WHERE tenant_id = ${ctx.tenantId}::uuid AND object_type = ${codeOf(object)}
            AND object_id = ${id} AND action = 'succession.population.delete' ORDER BY occurred_at DESC LIMIT 1`),
          );
          if (audit) views.push(audit.snapshot);
        }
      }
      if (views.length !== ids.length) throw missing();
      return { views, revisions: new Map(views.map((view) => [view.id, view.revision])) };
    },
    project: (deps, ctx, views) => projectConfig(deps, ctx, object, views),
  };
}
