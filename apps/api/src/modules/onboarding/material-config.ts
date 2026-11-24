import {
  and,
  asc,
  eq,
  inArray,
  onboardingMaterialRuleItems as definitions,
  onboardingMaterialRules as rules,
  onboardingMaterialScopeOrgs as scopeOrgs,
  orgObjects,
  sql,
  type Tx,
} from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { z } from 'zod';
import { asUuid, lockKey } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { assertRevision } from '../employment/context.js';
import { rowsOf } from '../employment/read-model.js';
import type { BusinessContext } from '../job/context.js';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(200);
const definition = z.strictObject({ id: uuid.optional(), name, required: z.boolean(), allowSupplement: z.boolean() });
const ruleShape = {
  name,
  orgIds: z.array(uuid).min(1).max(100),
  priority: z.number().int().min(0).max(2147483647),
  enabled: z.boolean(),
  remindAfterHire: z.boolean(),
  remindDays: z.number().int().min(1).max(2147483647).nullable(),
  items: z.array(definition).min(1).max(100),
};
export const materialRuleBody = z.strictObject({
  ...ruleShape,
  enabled: ruleShape.enabled.default(true),
  remindAfterHire: ruleShape.remindAfterHire.default(false),
  remindDays: ruleShape.remindDays.default(null),
});
export const materialRulePatch = z
  .strictObject(ruleShape)
  .partial()
  .refine((value) => Object.keys(value).length > 0);

type Rule = typeof rules.$inferSelect;
type Input = z.infer<typeof materialRuleBody>;
type Change = Input | z.infer<typeof materialRulePatch> | null;
type Definition = z.infer<typeof definition>;

export function materialConfigMissing(): never {
  throw new AppError('NOT_FOUND', '材料规则不存在');
}

const ruleKey = (tenantId: string, id: string) => and(eq(rules.tenantId, tenantId), eq(rules.id, id));
const scopeKey = (tenantId: string, ruleId: string) =>
  and(eq(scopeOrgs.tenantId, tenantId), eq(scopeOrgs.ruleId, ruleId));

/** 租户材料配置锁键：租户 UUID 走公共函数转规范文本，大小写变体取同一把锁（F-491，DEC-374）。 */
const materialGate = (tenantId: string) => lockKey('onboarding:material:', asUuid(tenantId));

/** 同一租户的规则写入串行，阶段生成取共享锁读取同一配置版本。 */
export async function lockMaterialConfig(tx: Tx, tenantId: string, write: boolean) {
  if (write) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${materialGate(tenantId)})`);
    return;
  }
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${materialGate(tenantId)})`);
}

type OrgContext = Pick<BusinessContext, 'tenantId' | 'timezone' | 'now'>;
function region(ctx: OrgContext, roots: SQL) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`
    WITH RECURSIVE current_versions AS (
      SELECT DISTINCT ON (org_id) id, org_id, stop_date FROM org_versions
      WHERE tenant_id = ${ctx.tenantId} AND start_date <= ${today}::date
      ORDER BY org_id, start_date DESC, version_no DESC
    ), region(org_id) AS (
      ${roots}
      UNION
      SELECT v.org_id FROM region r
      JOIN org_hierarchy_links h ON h.tenant_id = ${ctx.tenantId} AND h.dimension = 'admin'
        AND h.parent_org_id = r.org_id
      JOIN current_versions v ON v.id = h.version_id AND v.stop_date >= ${today}::date
    ) SELECT region.org_id FROM region
  `;
}

function visibleRegion(ctx: BusinessContext, scope: ModuleScope, roots: SQL) {
  return sql`NOT EXISTS (SELECT 1 FROM (${region(ctx, roots)}) material_region
    WHERE NOT ${scopeSql(scope, { org: sql`material_region.org_id` })})`;
}

function ruleRoots(tenantId: string) {
  return sql`SELECT s.org_id FROM onboarding_material_scope_orgs s
    WHERE s.tenant_id = ${tenantId} AND s.rule_id = ${rules.id}`;
}

export function materialRuleCoversOrg(ctx: OrgContext, orgId: string) {
  return sql`EXISTS (SELECT 1 FROM (${region(ctx, ruleRoots(ctx.tenantId))}) material_region
    WHERE material_region.org_id = ${orgId}::uuid)`;
}

export function materialRuleScope(ctx: BusinessContext, scope: ModuleScope) {
  const roots = ruleRoots(ctx.tenantId);
  return sql`(EXISTS (${roots}) AND ${visibleRegion(ctx, scope, roots)})`;
}

async function requireMaterialOrgScope(tx: Tx, ctx: BusinessContext, scope: ModuleScope, orgIds: string[]) {
  const roots = tx
    .select({ orgId: orgObjects.id })
    .from(orgObjects)
    .where(and(eq(orgObjects.tenantId, ctx.tenantId), inArray(orgObjects.id, orgIds)));
  const [row] = rowsOf<{ allowed: boolean }>(
    await tx.execute(sql`SELECT (
      (SELECT count(*) FROM (${roots.getSQL()}) roots) = ${orgIds.length} AND
      ${visibleRegion(ctx, scope, roots.getSQL())}) AS allowed`),
  );
  if (!row?.allowed) materialConfigMissing();
}

async function requireUniquePriority(tx: Tx, ctx: BusinessContext, scope: ModuleScope, input: Input, id?: string) {
  const orgs = sql`SELECT unnest(ARRAY[${sql.join(
    input.orgIds.map((orgId) => sql`${orgId}::uuid`),
    sql`, `,
  )}])`;
  const [result] = rowsOf<{ hidden: boolean; duplicate: boolean }>(
    await tx.execute(sql`
      WITH candidate AS (${region(ctx, orgs)}), overlapping AS (
        SELECT ${rules.enabled} AS enabled, ${rules.priority} AS priority, ${materialRuleScope(ctx, scope)} AS visible
        FROM ${rules}
        WHERE ${rules.tenantId} = ${ctx.tenantId} AND NOT ${rules.archived}
          AND ${rules.id} IS DISTINCT FROM ${id ?? null}::uuid
          AND EXISTS (
            SELECT org_id FROM candidate
            INTERSECT SELECT org_id FROM (${region(ctx, ruleRoots(ctx.tenantId))}) existing
          )
      )
      SELECT coalesce(bool_or(NOT visible), false) AS hidden,
        coalesce(bool_or(visible AND enabled AND priority = ${input.priority}), false) AS duplicate
      FROM overlapping
    `),
  );
  // 发布时先拒绝所有不可见的重叠配置，避免回执随隐藏规则的优先级或启用状态变化。
  if (result?.hidden) materialConfigMissing();
  if (result?.duplicate)
    throw new AppError('CONFLICT', '材料规则同优先级范围重叠', { reason: 'MATERIAL_RULE_PRIORITY_CONFLICT' });
}

export async function materialDefinitions(tx: Tx, tenantId: string, ruleId: string) {
  return tx
    .select({
      id: definitions.id,
      revision: definitions.revision,
      name: definitions.name,
      required: definitions.required,
      allowSupplement: definitions.allowSupplement,
      position: definitions.position,
    })
    .from(definitions)
    .where(and(eq(definitions.tenantId, tenantId), eq(definitions.ruleId, ruleId), eq(definitions.archived, false)))
    .orderBy(asc(definitions.position), asc(definitions.id));
}

async function ruleDetail(tx: Tx, row: Rule) {
  const { id, tenantId, revision, name, enabled, priority, remindAfterHire, remindDays, createdAt, updatedAt } = row;
  const orgs = await tx
    .select({ orgId: scopeOrgs.orgId })
    .from(scopeOrgs)
    .where(scopeKey(tenantId, id))
    .orderBy(asc(scopeOrgs.orgId));
  const definitions = await materialDefinitions(tx, tenantId, id);
  return {
    id,
    revision,
    name,
    enabled,
    priority,
    remindAfterHire,
    remindDays,
    createdAt,
    updatedAt,
    orgIds: orgs.map(({ orgId }) => orgId),
    items: definitions.map(({ id, name, required, allowSupplement }) => ({ id, name, required, allowSupplement })),
  };
}

export async function readMaterialRules(
  tx: Tx,
  ctx: BusinessContext,
  scope: ModuleScope,
  page: { limit: number; offset: number },
  id?: string,
) {
  const rows = await tx
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.tenantId, ctx.tenantId),
        eq(rules.archived, false),
        materialRuleScope(ctx, scope),
        id === undefined ? undefined : eq(rules.id, id),
      ),
    )
    .orderBy(asc(rules.id))
    .limit(id ? 1 : page.limit)
    .offset(id ? 0 : page.offset);
  if (id) return rows[0] ? ruleDetail(tx, rows[0]) : materialConfigMissing();
  return { items: await Promise.all(rows.map((row) => ruleDetail(tx, row))) };
}

/** 已归档规则仍可定位，供 ledgerExit 复核重放当前范围。 */
export async function materialWriteTarget(tx: Tx, ctx: BusinessContext, scope: ModuleScope, id: string) {
  const [row] = await tx
    .select()
    .from(rules)
    .where(and(ruleKey(ctx.tenantId, id), materialRuleScope(ctx, scope)));
  return row ?? materialConfigMissing();
}

async function saveDefinitions(
  tx: Tx,
  ctx: BusinessContext,
  ruleId: string,
  input: Definition[],
  previous: Definition[],
) {
  const existing = new Set(previous.map(({ id }) => id));
  const retained = new Set(input.flatMap(({ id }) => (id ? [id] : [])));
  if ([...retained].some((id) => !existing.has(id))) materialConfigMissing();
  for (const [position, { id, ...fields }] of input.entries()) {
    if (id) {
      await tx
        .update(definitions)
        .set({ ...fields, position, revision: sql`${definitions.revision} + 1` })
        .where(and(eq(definitions.tenantId, ctx.tenantId), eq(definitions.ruleId, ruleId), eq(definitions.id, id)));
    } else {
      await tx.insert(definitions).values({ ...fields, tenantId: ctx.tenantId, ruleId, position });
    }
  }
  const removed = previous.flatMap(({ id }) => (id && !retained.has(id) ? [id] : []));
  if (removed.length)
    await tx
      .update(definitions)
      .set({ archived: true, revision: sql`${definitions.revision} + 1` })
      .where(
        and(eq(definitions.tenantId, ctx.tenantId), eq(definitions.ruleId, ruleId), inArray(definitions.id, removed)),
      );
}

function validateMaterialRule(input: Input) {
  const ids = input.items.flatMap(({ id }) => (id ? [id] : []));
  if (
    new Set(input.orgIds).size !== input.orgIds.length ||
    new Set(ids).size !== ids.length ||
    new Set(input.items.map(({ name }) => name)).size !== input.items.length ||
    (input.remindAfterHire && input.remindDays === null)
  )
    throw new AppError('VALIDATION_FAILED', '材料规则存在重复项或缺少催办期限');
}

export async function writeMaterialRule(
  tx: Tx,
  ctx: BusinessContext,
  scope: ModuleScope,
  change: Change,
  target?: Rule,
) {
  if (target?.archived) materialConfigMissing();
  assertRevision(ctx.expectedRevision, target?.revision ?? 0);
  const before = target ? await ruleDetail(tx, target) : null;
  const updated = { updatedAt: ctx.now, updatedBy: ctx.userId, revision: ctx.expectedRevision + 1 };
  const row =
    change === null && target
      ? (
          await tx
            .update(rules)
            .set({ ...updated, archived: true, enabled: false })
            .where(ruleKey(ctx.tenantId, target.id))
            .returning()
        )[0]!
      : await saveMaterialRule(tx, ctx, scope, change, before, updated);
  const after = await ruleDetail(tx, row);
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `onboarding.materialRules.${row.archived ? 'archive' : target ? 'update' : 'create'}`,
    // 通用审计入口没有此聚合的多组织复核，独立对象类型走默认拒绝。
    objectType: 'onboarding-material-config',
    objectId: row.id,
    before,
    after: { ...after, archived: row.archived },
    occurredAt: ctx.now,
    commandId: ctx.commandId,
  });
  return { id: row.id, revision: row.revision, status: row.archived ? 'archived' : 'saved' };
}

function ruleInput({
  id: _id,
  revision: _revision,
  createdAt: _created,
  updatedAt: _updated,
  ...input
}: Awaited<ReturnType<typeof ruleDetail>>): Input {
  return input;
}

async function saveMaterialRule(
  tx: Tx,
  ctx: BusinessContext,
  scope: ModuleScope,
  change: Change,
  before: Awaited<ReturnType<typeof ruleDetail>> | null,
  updated: { updatedAt: Date; updatedBy: string; revision: number },
) {
  const input = before ? { ...ruleInput(before), ...change } : materialRuleBody.parse(change);
  validateMaterialRule(input);
  await requireMaterialOrgScope(tx, ctx, scope, input.orgIds);
  if (input.enabled) await requireUniquePriority(tx, ctx, scope, input, before?.id);
  const { orgIds, items, ...values } = input;
  const row = before
    ? (
        await tx
          .update(rules)
          .set({ ...values, ...updated })
          .where(ruleKey(ctx.tenantId, before.id))
          .returning()
      )[0]!
    : (
        await tx
          .insert(rules)
          .values({ ...values, ...updated, tenantId: ctx.tenantId, createdAt: ctx.now, createdBy: ctx.userId })
          .returning()
      )[0]!;
  if (!before || change?.orgIds) {
    if (before) await tx.delete(scopeOrgs).where(scopeKey(ctx.tenantId, row.id));
    await tx.insert(scopeOrgs).values(orgIds.map((orgId) => ({ tenantId: ctx.tenantId, ruleId: row.id, orgId })));
  }
  if (!before || change?.items) await saveDefinitions(tx, ctx, row.id, items, before?.items ?? []);
  return row;
}
