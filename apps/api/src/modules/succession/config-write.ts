/** 人员范围、默认颜色与重编译：规则集合锁后重读，原始行与编译缓存、审计、命令台账同事务。 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import { compilePopulation, type RuleSet, type SuccessionRuleKind } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { codeOf, SUCCESSION_AUDIT_ACTIONS, type SuccessionContext } from './access.js';
import {
  configAccess,
  lockRuleSettings,
  missing,
  populationViews,
  requireRevision,
  settingsView,
  type ConfigObject,
  type ConfigView,
} from './config-store.js';
import { invalidRule, type PopulationBody } from './population-input.js';
import { rowsOf } from './read-sql.js';

export async function configAudit(
  tx: Tx,
  ctx: SuccessionContext,
  object: ConfigObject,
  operation: string,
  id: string,
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `${SUCCESSION_AUDIT_ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}
export async function saveRules(tx: Tx, tenantId: string, id: string, rules: RuleSet) {
  const result = compilePopulation(rules);
  if (!result.ok) invalidRule(result.errors);
  await tx.execute(sql`DELETE FROM succession_population_rows
    WHERE tenant_id = ${tenantId}::uuid AND population_id = ${id}::uuid`);
  for (const row of rules.rows) {
    await tx.execute(sql`INSERT INTO succession_population_rows
      (tenant_id, population_id, row_no, field_code, filter_operator, filter_values)
      VALUES (${tenantId}::uuid, ${id}::uuid, ${row.rowNo}, ${row.field!.code}, ${row.operator},
        ${JSON.stringify(row.values ?? [])}::jsonb)`);
  }
  await tx.execute(sql`UPDATE succession_populations SET condition_expression = ${rules.expression},
    compiled_formula = ${result.compiled.formula}, compiler_version = ${result.compiled.compilerVersion},
    compile_error = NULL WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`);
}
export async function mutatePopulation(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  operation: 'create' | 'update' | 'delete',
  id: string,
  body?: Partial<PopulationBody>,
) {
  await lockRuleSettings(tx, ctx.tenantId, 'org_health');
  await configAccess(tx, deps, ctx, 'population');
  await tx.execute(sql`SELECT id FROM succession_populations
    WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`);
  const [before] = await populationViews(tx, ctx.tenantId, [id]);
  if (operation !== 'create') {
    if (!before) throw missing();
    requireRevision(before, ctx.expectedRevision);
  }
  try {
    if (operation === 'delete') {
      // B2b 的同租户 RESTRICT 外键保证并发引用安全，不能用先查后删替代约束。
      await tx.execute(sql`DELETE FROM succession_populations
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
    } else if (operation === 'create') {
      await tx.execute(sql`INSERT INTO succession_populations(id, tenant_id, code, name,
        condition_expression, display_order) SELECT ${id}::uuid, ${ctx.tenantId}::uuid, ${body!.code},
        ${body!.name}, '', COALESCE(MAX(display_order), 0) + 1 FROM succession_populations
        WHERE tenant_id = ${ctx.tenantId}::uuid`);
    } else {
      await tx.execute(sql`UPDATE succession_populations SET code = ${body!.code ?? (before!.code as string)},
        name = ${body!.name ?? (before!.name as string)}, revision = revision + 1
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
    }
  } catch (error) {
    const code = pgErrorCode(error);
    if (code === '23505') throw new AppError('CONFLICT', '人员范围编码重复', { reason: 'POPULATION_CODE_DUPLICATE' });
    if (code === '23503' || code === '23001') {
      throw new AppError('CONFLICT', '人员范围已被引用', { reason: 'POPULATION_IN_USE' });
    }
    throw error;
  }
  if (body?.rules) await saveRules(tx, ctx.tenantId, id, body.rules);
  const after = operation === 'delete' ? null : (await populationViews(tx, ctx.tenantId, [id]))[0]!;
  await configAudit(tx, ctx, 'population', operation, id, before ?? null, after);
  return { kind: operation === 'delete' ? ('receipt' as const) : ('record' as const), ids: [id] };
}
export async function updateColor(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: SuccessionContext,
  kind: SuccessionRuleKind,
  defaultColor: string,
) {
  await lockRuleSettings(tx, ctx.tenantId, kind);
  await configAccess(tx, deps, ctx, 'ruleSettings');
  const before = await settingsView(tx, ctx.tenantId, kind);
  requireRevision(before, ctx.expectedRevision);
  await tx.execute(sql`UPDATE succession_rule_settings SET default_color = ${defaultColor.toUpperCase()},
    revision = revision + 1 WHERE tenant_id = ${ctx.tenantId}::uuid AND kind = ${kind}`);
  await configAudit(tx, ctx, 'ruleSettings', 'update', kind, before, await settingsView(tx, ctx.tenantId, kind));
  return { kind: 'record' as const, ids: [kind] };
}
/** 平台只改缓存，不反写原始条件行；逐对象升序取锁。失败留下安全错误码，使后续计算停止使用旧缓存。 */
export async function recompilePopulations(tx: Tx, ctx: SuccessionContext, cursor?: string): Promise<string[]> {
  await lockRuleSettings(tx, ctx.tenantId, 'org_health');
  const ids = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM succession_populations
    WHERE tenant_id = ${ctx.tenantId}::uuid ${cursor ? sql`AND id > ${cursor}::uuid` : sql``}
    ORDER BY id LIMIT 200 FOR UPDATE`),
  ).map((row) => row.id);
  for (const before of await populationViews(tx, ctx.tenantId, ids)) {
    const result = compilePopulation(before.rules as RuleSet);
    await tx.execute(sql`UPDATE succession_populations
      SET compiled_formula = ${result.ok ? result.compiled.formula : null},
      compiler_version = ${result.ok ? result.compiled.compilerVersion : null},
      compile_error = ${result.ok ? null : JSON.stringify(result.errors)}::jsonb, revision = revision + 1
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${before.id}::uuid`);
    const [after] = await populationViews(tx, ctx.tenantId, [before.id]);
    await configAudit(tx, ctx, 'population', 'recompile', before.id, before, after as ConfigView);
  }
  return ids;
}
