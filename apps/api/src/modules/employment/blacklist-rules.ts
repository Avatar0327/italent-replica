/**
 * R2 BE-8a 离职自动加黑规则（B68 规则页；差距表“补证结论 R2f”）：规则增删改查与读取接口，挂在任职设置配置对象上
 * （tenant.employment.configuration.write，管理员 other_settings），审计 blacklist_rule.*（DEC-203 配置日志）。
 * 只实现条件“离职次数 大于等于 N 次”与期限“永久 / 离职当月”；其他条件字段、运算符与“指定期限”未验证，校验直接拒绝。
 * 接线点（BE-8b）：离职生效时 readAutoBlacklistEnabled 为 true 才调用 loadBlacklistRules + matchBlacklistRule
 * （@italent/domain），命中后 addBlacklistEntry(source = auto_rule)；开关关闭仍允许手动加黑。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import {
  AUTO_BLACKLIST_SETTING_KEY,
  BLACKLIST_REASON_CODES,
  BLACKLIST_RULE_CONDITION_LIMIT,
  BLACKLIST_RULE_LIMIT,
  BLACKLIST_RULE_TERM_CODES,
  BLACKLIST_RULE_TEXT_MAX,
  type BlacklistRuleFacts,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertRevision } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const BLACKLIST_RULE_AUDIT_TYPE = 'blacklist_rule';

export interface BlacklistRuleView extends BlacklistRuleFacts {
  readonly description: string | null;
  readonly revision: number;
}

const optionalText = z.string().trim().max(BLACKLIST_RULE_TEXT_MAX).nullable().optional();
const ruleInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  priority: z.int().min(0).max(9999),
  orgIds: z
    .array(
      z
        .string()
        .refine(isUuid, '组织标识必须为 UUID')
        .transform((value) => value.toLowerCase()),
    )
    .min(1)
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, '适用组织不能重复'),
  description: optionalText,
  conditions: z
    .array(
      z.strictObject({ field: z.literal('exitCount'), operator: z.literal('gte'), value: z.int().min(1).max(999) }),
    )
    .min(1)
    .max(BLACKLIST_RULE_CONDITION_LIMIT),
  term: z.enum(BLACKLIST_RULE_TERM_CODES),
  reason: z.enum(BLACKLIST_REASON_CODES),
  note: optionalText,
});
export type BlacklistRuleInput = z.infer<typeof ruleInput>;

export function parseBlacklistRule(raw: unknown): BlacklistRuleInput {
  const parsed = ruleInput.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '自动加黑规则字段不合法', parsed.error.issues);
  return parsed.data;
}

/** 规则按优先级再按创建顺序排列（与匹配时“同优先级取先登记者”一致）。 */
export async function listBlacklistRules(tx: Tx, tenantId: string, ruleId?: string): Promise<BlacklistRuleView[]> {
  const rules = rowsOf<Omit<BlacklistRuleView, 'conditions'>>(
    await tx.execute(sql`
      SELECT id, name, priority, org_ids AS "orgIds", description, term, reason, note, revision
      FROM employment_blacklist_rules WHERE tenant_id = ${tenantId}
        ${ruleId ? sql`AND id = ${ruleId}::uuid` : sql``}
      ORDER BY priority, created_at, id LIMIT ${BLACKLIST_RULE_LIMIT}`),
  );
  if (!rules.length) return [];
  const conditions = rowsOf<{ ruleId: string; field: 'exitCount'; operator: 'gte'; value: number }>(
    await tx.execute(sql`
      SELECT rule_id AS "ruleId", field, operator, value FROM employment_blacklist_rule_conditions
      WHERE tenant_id = ${tenantId} AND rule_id = ANY(${`{${rules.map((r) => r.id).join(',')}}`}::uuid[])
      ORDER BY rule_id, ordinal`),
  );
  return rules.map((rule) => ({
    ...rule,
    conditions: conditions
      .filter((condition) => condition.ruleId === rule.id)
      .map(({ field, operator, value }) => ({ field, operator, value })),
  }));
}

/** BE-8b 接线：读出全部规则交给 matchBlacklistRule。 */
export const loadBlacklistRules = (tx: Tx, tenantId: string): Promise<BlacklistRuleFacts[]> =>
  listBlacklistRules(tx, tenantId);

/** 总开关有效值（两层配置；系统值 false）。 */
export async function readAutoBlacklistEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  return (await readEffectiveSetting(tx, tenantId, AUTO_BLACKLIST_SETTING_KEY)).value === true;
}

async function lockRules(tx: Tx, tenantId: string) {
  await advisoryLock(tx, asUuid(tenantId), ':employment-blacklist-rules');
}

async function assertOrgsExist(tx: Tx, tenantId: string, orgIds: readonly string[]): Promise<void> {
  const [row] = rowsOf<{ found: number }>(
    await tx.execute(sql`SELECT count(DISTINCT org_id)::int AS found FROM org_versions
      WHERE tenant_id = ${tenantId} AND org_id = ANY(${`{${orgIds.join(',')}}`}::uuid[])`),
  );
  if (row?.found !== orgIds.length)
    throw new AppError('VALIDATION_FAILED', '适用组织包含不存在的组织', { reason: 'ORG_NOT_FOUND' });
}

async function writeConditions(tx: Tx, tenantId: string, ruleId: string, input: BlacklistRuleInput) {
  await tx.execute(
    sql`DELETE FROM employment_blacklist_rule_conditions WHERE tenant_id = ${tenantId} AND rule_id = ${ruleId}::uuid`,
  );
  for (const [ordinal, condition] of input.conditions.entries())
    await tx.execute(sql`INSERT INTO employment_blacklist_rule_conditions(tenant_id, rule_id, ordinal, field, operator,
      value) VALUES (${tenantId}, ${ruleId}::uuid, ${ordinal}, ${condition.field}, ${condition.operator},
      ${condition.value})`);
}

async function audit(tx: Tx, ctx: EmploymentContext, action: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `blacklist_rule.${action}`,
    objectType: BLACKLIST_RULE_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function lockedRule(tx: Tx, ctx: EmploymentContext, id: string) {
  const [before] = await listBlacklistRules(tx, ctx.tenantId, id);
  if (!before) throw new AppError('NOT_FOUND', '自动加黑规则不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

/** 新增（If-Match 0）或整份保存（If-Match = 当前 revision）一条规则；每租户最多 100 条。 */
export async function saveBlacklistRule(
  tx: Tx,
  ctx: EmploymentContext,
  input: BlacklistRuleInput,
  id?: string,
): Promise<BlacklistRuleView> {
  await lockRules(tx, ctx.tenantId);
  await assertOrgsExist(tx, ctx.tenantId, input.orgIds);
  const now = ctx.now.toISOString();
  const orgIds = `{${input.orgIds.join(',')}}`;
  const before = id ? await lockedRule(tx, ctx, id) : null;
  const ruleId = id ?? randomUUID();
  if (!before) {
    assertRevision(ctx.expectedRevision, 0);
    const [count] = rowsOf<{ n: number }>(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM employment_blacklist_rules WHERE tenant_id = ${ctx.tenantId}`,
      ),
    );
    if (count!.n >= BLACKLIST_RULE_LIMIT)
      throw new AppError('CONFLICT', '自动加黑规则已达上限', {
        reason: 'BLACKLIST_RULE_LIMIT_REACHED',
        limit: BLACKLIST_RULE_LIMIT,
      });
    await tx.execute(sql`INSERT INTO employment_blacklist_rules(id, tenant_id, name, priority, org_ids, description, term,
      reason, note, created_at, updated_at) VALUES (${ruleId}::uuid, ${ctx.tenantId}, ${input.name}, ${input.priority},
      ${orgIds}::uuid[], ${input.description || null}, ${input.term}, ${input.reason}, ${input.note || null},
      ${now}::timestamptz, ${now}::timestamptz)`);
  } else {
    await tx.execute(sql`UPDATE employment_blacklist_rules SET name = ${input.name}, priority = ${input.priority},
      org_ids = ${orgIds}::uuid[], description = ${input.description || null}, term = ${input.term},
      reason = ${input.reason}, note = ${input.note || null}, revision = revision + 1, updated_at = ${now}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${ruleId}::uuid`);
  }
  await writeConditions(tx, ctx.tenantId, ruleId, input);
  const [after] = await listBlacklistRules(tx, ctx.tenantId, ruleId);
  await audit(tx, ctx, before ? 'update' : 'create', ruleId, before, after);
  return after!;
}

export async function deleteBlacklistRule(tx: Tx, ctx: EmploymentContext, id: string) {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  await tx.execute(sql`DELETE FROM employment_blacklist_rules WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}
