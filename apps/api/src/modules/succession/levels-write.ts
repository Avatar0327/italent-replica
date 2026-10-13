/** 设计 §7：规则集合行 → 等级行；健康度与人员范围共用 org_health 锁，RESTRICT 外键兜底。 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import { compileSuccessionLevel, type SuccessionLevelKind, type SuccessionLevelRules } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { AppError } from '../../errors.js';
import type { SuccessionContext } from './access.js';
import { configAccess, lockRuleSettings, missing, requireRevision } from './config-store.js';
import { applyLevelChanges } from './levels-changes.js';
import { lockLevelReviewFields } from './levels-references.js';
import { invalidRule } from './population-input.js';
import { collectionRevisionSql, levelSpec, levelViews } from './levels-store.js';
import { requireSupportedHealthChange } from './health-rule-support.js';
import { rowsOf } from './read-sql.js';
import { lockHealthRules, requireHealthLevelUnplanned } from './health-references.js';

interface LevelBody {
  code?: string;
  name?: string;
  color?: string;
  description?: string | null;
  enabled?: boolean;
  rules?: SuccessionLevelRules | null;
}
async function saveLevelRules(
  tx: Tx,
  tenantId: string,
  kind: SuccessionLevelKind,
  id: string,
  rules: SuccessionLevelRules | null,
) {
  const spec = levelSpec(kind);
  let compiled: ReturnType<typeof compileSuccessionLevel> | null = null;
  if (rules !== null) {
    const fields = await lockLevelReviewFields(tx, tenantId, rules);
    compiled = compileSuccessionLevel(kind, rules, fields);
  }
  if (compiled && !compiled.ok) invalidRule(compiled.errors);
  if (rules)
    for (const row of rules.rows)
      if (row.populationId) {
        const [population] = rowsOf(
          await tx.execute(sql`SELECT id FROM succession_populations
      WHERE tenant_id = ${tenantId}::uuid AND id = ${row.populationId}::uuid FOR KEY SHARE`),
        );
        if (!population) throw missing();
      }
  await tx.execute(sql`DELETE FROM ${spec.rows} WHERE tenant_id = ${tenantId}::uuid AND level_id = ${id}::uuid`);
  if (rules)
    for (const row of rules.rows) {
      const extraColumns = kind === 'risk' ? sql`subject` : sql`population, population_id, field_source`;
      const extraValues =
        kind === 'risk' ? sql`${row.subject}` : sql`${row.population}, ${row.populationId}::uuid, ${row.fieldSource}`;
      await tx.execute(sql`INSERT INTO ${spec.rows} (tenant_id, level_id, row_no, field_code, filter_operator,
      filter_values, measure, comparator, threshold, threshold_high, is_percent, ${extraColumns})
      VALUES (${tenantId}::uuid, ${id}::uuid, ${row.rowNo}, ${row.fieldCode}, ${row.filterOperator},
        ${JSON.stringify(row.filterValues)}::jsonb, ${row.measure}, ${row.comparator}, ${row.threshold},
        ${row.thresholdHigh}, ${row.isPercent}, ${extraValues})`);
    }
  await tx.execute(sql`UPDATE ${spec.table} SET condition_expression = ${rules?.expression ?? null},
    compiled_formula = ${compiled?.ok ? compiled.compiled.formula : null},
    compiler_version = ${compiled?.ok ? compiled.compiled.compilerVersion : null}, compile_error = NULL
    WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`);
}
export async function mutateLevel(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  kind: SuccessionLevelKind,
  operation: 'create' | 'update' | 'delete',
  id: string,
  body?: LevelBody,
) {
  const spec = levelSpec(kind);
  if (kind === 'health') await lockHealthRules(tx, ctx.tenantId);
  else await lockRuleSettings(tx, ctx.tenantId, spec.ruleKind);
  await configAccess(tx, deps, ctx, spec.object);
  await tx.execute(
    sql`SELECT id FROM ${spec.table} WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
  );
  const [before] = await levelViews(tx, ctx.tenantId, kind, [id]);
  if (operation !== 'create') {
    if (!before) throw missing();
    requireRevision(before, ctx.expectedRevision);
  }
  // 先校验再判断内容有无变化；旧禁用规则的原样保存也不能绕过 DEC-460。
  if (kind === 'health') requireSupportedHealthChange(body, before?.rules);
  await applyLevelChanges(tx, ctx, kind, operation, [
    {
      id,
      before: before ?? null,
      after: operation === 'delete' ? null : { ...before, ...body },
      write: async () => {
        try {
          if (operation === 'delete') {
            if (kind === 'health') await requireHealthLevelUnplanned(tx, ctx.tenantId, id);
            await tx.execute(
              sql`DELETE FROM ${spec.table} WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`,
            );
          } else if (operation === 'create') {
            await tx.execute(sql`INSERT INTO ${spec.table}(id, tenant_id, code, name, color, description, enabled,
        display_order)
        SELECT ${id}::uuid, ${ctx.tenantId}::uuid, ${body!.code}, ${body!.name}, ${body!.color}, ${body!.description},
          ${body!.enabled}, COALESCE(MAX(display_order), 0) + 1 FROM ${spec.table}
          WHERE tenant_id = ${ctx.tenantId}::uuid`);
          } else {
            const changes = Object.entries(body!)
              .filter(([key]) => key !== 'rules')
              .map(([key, value]) => sql`${sql.identifier(key)} = ${value}`);
            if (changes.length)
              await tx.execute(sql`UPDATE ${spec.table} SET ${sql.join(changes, sql`, `)}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
          }
        } catch (error) {
          if (pgErrorCode(error) === '23505')
            throw new AppError('CONFLICT', '等级编码或名称重复', { reason: 'LEVEL_DUPLICATE' });
          if (['23503', '23001'].includes(pgErrorCode(error) ?? ''))
            throw new AppError('CONFLICT', '等级已被引用', { reason: 'LEVEL_IN_USE' });
          throw error;
        }
        if (body?.rules !== undefined) await saveLevelRules(tx, ctx.tenantId, kind, id, body.rules);
      },
    },
  ]);
  return { kind: operation === 'delete' ? ('receipt' as const) : ('record' as const), ids: [id] };
}
export async function reorderLevels(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  kind: SuccessionLevelKind,
  ids: readonly string[],
) {
  const spec = levelSpec(kind);
  if (kind === 'health') await lockHealthRules(tx, ctx.tenantId);
  else await lockRuleSettings(tx, ctx.tenantId, spec.ruleKind);
  await configAccess(tx, deps, ctx, spec.object);
  const [collection] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT ${collectionRevisionSql(ctx.tenantId, kind)} AS revision`),
  );
  requireRevision({ id: spec.ruleKind, revision: collection!.revision }, ctx.expectedRevision);
  const current = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM ${spec.table}
    WHERE tenant_id = ${ctx.tenantId}::uuid ORDER BY id FOR UPDATE`),
  );
  if (ids.length !== current.length || new Set(ids).size !== ids.length || current.some((row) => !ids.includes(row.id)))
    throw new AppError('VALIDATION_FAILED', '重排必须包含完整且无重复的等级集合', { reason: 'LEVEL_ORDER_INVALID' });
  const before = await levelViews(tx, ctx.tenantId, kind, ids);
  await applyLevelChanges(
    tx,
    ctx,
    kind,
    'reorder',
    before.map((view, index) => ({
      id: view.id,
      before: view,
      after: { ...view, displayOrder: index + 1 },
      write: async () => {
        await tx.execute(sql`UPDATE ${spec.table} SET display_order = ${index + 1}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${view.id}::uuid`);
      },
    })),
  );
  return { kind: 'records' as const, ids };
}
