/**
 * R2 BE-5c1a 预计退休日期规则（R2-T04 §2.4 / §9.1，DEC-640、DEC-636 c4）：规则增删改查、复制、单条启停，
 * 挂在任职设置配置对象上（tenant.employment.configuration.write，管理员 other_settings），审计 retirement_rule.save /
 * delete / enabled。首版只有 purpose = expected_date、rule_type = fixed_age；条件是四个固定槽位（性别、国籍、
 * 雇佣关系（必填）、个人身份），每槽至多一条、操作符只有 in。本批没有任何定时或立即执行入口，规则只能配置。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import {
  RETIREMENT_AGE_MONTHS,
  RETIREMENT_AGE_YEARS,
  RETIREMENT_CONDITION_FIELDS,
  RETIREMENT_CONDITION_VALUES_MAX,
  RETIREMENT_EMPLOY_TYPES,
  RETIREMENT_REQUIRED_CONDITION,
  RETIREMENT_RULE_LIMIT,
  RETIREMENT_RULE_PURPOSES,
  RETIREMENT_RULE_TYPES,
  type RetirementCondition,
  type RetirementRulePurpose,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { requireEnabledIdentityTypes } from '../personnel/identity-types.js';
import { assertOrgsExist } from './auto-regularization-rules.js';
import { assertRevision } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const RETIREMENT_RULE_AUDIT_TYPE = 'retirement_rule';
const NAME_MAX = 100;
const COPY_SUFFIX = '（复制）';

export interface RetirementRuleView {
  readonly id: string;
  readonly purpose: RetirementRulePurpose;
  readonly ruleType: (typeof RETIREMENT_RULE_TYPES)[number];
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly includeSubordinates: boolean;
  readonly retirementAgeYears: number;
  readonly retirementAgeMonths: number;
  readonly conditions: RetirementCondition[];
  readonly enabled: boolean;
  readonly revision: number;
}

const conditionInput = z.strictObject({
  fieldCode: z.enum(RETIREMENT_CONDITION_FIELDS),
  operator: z.literal('in'),
  values: z
    .array(z.string().trim().min(1).max(100))
    .min(1)
    .max(RETIREMENT_CONDITION_VALUES_MAX)
    .refine((values) => new Set(values).size === values.length, '条件取值不能重复'),
});

const ruleInput = z
  .strictObject({
    purpose: z.enum(RETIREMENT_RULE_PURPOSES).default('expected_date'),
    ruleType: z.enum(RETIREMENT_RULE_TYPES).default('fixed_age'),
    name: z.string().trim().min(1).max(NAME_MAX),
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
    includeSubordinates: z.boolean().default(true),
    retirementAgeYears: z.int().min(RETIREMENT_AGE_YEARS.min).max(RETIREMENT_AGE_YEARS.max),
    retirementAgeMonths: z.int().min(RETIREMENT_AGE_MONTHS.min).max(RETIREMENT_AGE_MONTHS.max).default(0),
    conditions: z.array(conditionInput).max(RETIREMENT_CONDITION_FIELDS.length),
    enabled: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    const slots = input.conditions.map((condition) => condition.fieldCode);
    if (new Set(slots).size !== slots.length)
      ctx.addIssue({ code: 'custom', message: '每个条件槽位至多一条', path: ['conditions'] });
    const employ = input.conditions.find((condition) => condition.fieldCode === RETIREMENT_REQUIRED_CONDITION);
    if (!employ) ctx.addIssue({ code: 'custom', message: '雇佣关系为必填条件', path: ['conditions'] });
    else if (employ.values.some((value) => !(RETIREMENT_EMPLOY_TYPES as readonly string[]).includes(value)))
      ctx.addIssue({ code: 'custom', message: '雇佣关系取值不合法', path: ['conditions'] });
  });
export type RetirementRuleInput = z.infer<typeof ruleInput>;

export function parseRetirementRule(raw: unknown): RetirementRuleInput {
  const parsed = ruleInput.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '退休规则字段不合法', parsed.error.issues);
  return parsed.data;
}

export function parseRuleEnabled(raw: unknown): boolean {
  const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '启停须为 { enabled: 布尔值 }', parsed.error.issues);
  return parsed.data.enabled;
}

/** GET ?purpose=：缺省 expected_date；其他取值（含 5c1b 才开放的 flexible_range）400。 */
export function parseRulePurpose(raw: string | undefined): RetirementRulePurpose {
  const parsed = z.enum(RETIREMENT_RULE_PURPOSES).default('expected_date').safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '规则用途不合法', parsed.error.issues);
  return parsed.data;
}

type RuleRow = Omit<RetirementRuleView, 'conditions'>;

/** 规则按优先级再按登记顺序号排列（与匹配时“同优先级取先登记者”一致）；条件按固定槽位顺序。 */
export async function listRetirementRules(
  tx: Tx,
  tenantId: string,
  purpose: RetirementRulePurpose,
  ruleId?: string,
): Promise<RetirementRuleView[]> {
  const rules = rowsOf<RuleRow>(
    await tx.execute(sql`
      SELECT id, purpose, rule_type AS "ruleType", name, priority, org_ids AS "orgIds",
        include_subordinates AS "includeSubordinates", retirement_age_years AS "retirementAgeYears",
        retirement_age_months AS "retirementAgeMonths", enabled, revision
      FROM retirement_rules WHERE tenant_id = ${tenantId} AND purpose = ${purpose}
        ${ruleId ? sql`AND id = ${ruleId}::uuid` : sql``}
      ORDER BY priority, sequence_no LIMIT ${RETIREMENT_RULE_LIMIT}`),
  );
  if (!rules.length) return [];
  const conditions = rowsOf<RetirementCondition & { ruleId: string }>(
    await tx.execute(sql`SELECT rule_id::text AS "ruleId", field_code AS "fieldCode", operator, "values"
      FROM retirement_rule_conditions WHERE tenant_id = ${tenantId}
        AND rule_id = ANY(${`{${rules.map((rule) => rule.id).join(',')}}`}::uuid[]) ORDER BY seq`),
  );
  return rules.map((rule) => ({
    ...rule,
    conditions: conditions
      .filter((condition) => condition.ruleId === rule.id)
      .map(({ fieldCode, operator, values }) => ({ fieldCode, operator, values })),
  }));
}

/** text[] 字面量：每个值整体加引号并转义。 */
const textArray = (values: readonly string[]) => `{${values.map((value) => JSON.stringify(value)).join(',')}}`;

async function lockRules(tx: Tx, tenantId: string) {
  await advisoryLock(tx, asUuid(tenantId), ':retirement-rules');
}

async function audit(tx: Tx, ctx: EmploymentContext, action: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${RETIREMENT_RULE_AUDIT_TYPE}.${action}`,
    objectType: RETIREMENT_RULE_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function lockedRule(tx: Tx, ctx: EmploymentContext, id: string) {
  const [before] = await listRetirementRules(tx, ctx.tenantId, 'expected_date', id);
  if (!before) throw new AppError('NOT_FOUND', '退休规则不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

async function replaceConditions(
  tx: Tx,
  ctx: EmploymentContext,
  ruleId: string,
  conditions: readonly RetirementCondition[],
) {
  await tx.execute(sql`DELETE FROM retirement_rule_conditions WHERE tenant_id = ${ctx.tenantId}
    AND rule_id = ${ruleId}::uuid`);
  for (const condition of conditions)
    await tx.execute(sql`INSERT INTO retirement_rule_conditions(tenant_id, rule_id, seq, field_code, operator, "values")
      VALUES (${ctx.tenantId}, ${ruleId}::uuid, ${RETIREMENT_CONDITION_FIELDS.indexOf(condition.fieldCode) + 1},
        ${condition.fieldCode}, ${condition.operator}, ${textArray(condition.values)}::text[])`);
}

/** 引用校验：适用组织存在；个人身份条件只能取字典启用编码（A-9）。 */
async function assertReferences(tx: Tx, tenantId: string, input: RetirementRuleInput) {
  await assertOrgsExist(tx, tenantId, input.orgIds);
  const identity = input.conditions.find((condition) => condition.fieldCode === 'identityType');
  if (identity) await requireEnabledIdentityTypes(tx, tenantId, identity.values);
}

async function insertRule(tx: Tx, ctx: EmploymentContext, input: RetirementRuleInput) {
  assertRevision(ctx.expectedRevision, 0);
  // 登记顺序号在规则锁内分配（max + 1）
  const [count] = rowsOf<{ n: number; next: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n, COALESCE(max(sequence_no), 0) + 1 AS next
      FROM retirement_rules WHERE tenant_id = ${ctx.tenantId} AND purpose = ${input.purpose}`),
  );
  if (count!.n >= RETIREMENT_RULE_LIMIT)
    throw new AppError('CONFLICT', '退休规则已达上限', {
      reason: 'RETIREMENT_RULE_LIMIT_REACHED',
      limit: RETIREMENT_RULE_LIMIT,
    });
  const id = randomUUID();
  const now = ctx.now.toISOString();
  await tx.execute(sql`INSERT INTO retirement_rules(id, tenant_id, purpose, rule_type, name, priority, sequence_no,
      org_ids, include_subordinates, retirement_age_years, retirement_age_months, enabled, created_at, updated_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${input.purpose}, ${input.ruleType}, ${input.name}, ${input.priority},
      ${count!.next}, ${`{${input.orgIds.join(',')}}`}::uuid[], ${input.includeSubordinates},
      ${input.retirementAgeYears}, ${input.retirementAgeMonths}, ${input.enabled}, ${now}::timestamptz,
      ${now}::timestamptz)`);
  await replaceConditions(tx, ctx, id, input.conditions);
  return id;
}

/** 新增（If-Match 0）或整份保存（If-Match = 当前 revision）一条规则，条件整份替换。 */
export async function saveRetirementRule(
  tx: Tx,
  ctx: EmploymentContext,
  input: RetirementRuleInput,
  id?: string,
): Promise<RetirementRuleView> {
  await lockRules(tx, ctx.tenantId);
  await assertReferences(tx, ctx.tenantId, input);
  const before = id ? await lockedRule(tx, ctx, id) : null;
  const ruleId = before ? before.id : await insertRule(tx, ctx, input);
  if (before) {
    await tx.execute(sql`UPDATE retirement_rules SET name = ${input.name}, priority = ${input.priority},
        org_ids = ${`{${input.orgIds.join(',')}}`}::uuid[], include_subordinates = ${input.includeSubordinates},
        retirement_age_years = ${input.retirementAgeYears}, retirement_age_months = ${input.retirementAgeMonths},
        enabled = ${input.enabled}, revision = revision + 1, updated_at = ${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${ruleId}::uuid`);
    await replaceConditions(tx, ctx, ruleId, input.conditions);
  }
  const [after] = await listRetirementRules(tx, ctx.tenantId, input.purpose, ruleId);
  await audit(tx, ctx, 'save', ruleId, before, after);
  return after!;
}

/** 行操作“复制”：照原规则另建一条（名称加“（复制）”），默认停用，管理员核对后再启用。 */
export async function copyRetirementRule(
  tx: Tx,
  ctx: EmploymentContext,
  sourceId: string,
): Promise<RetirementRuleView> {
  await lockRules(tx, ctx.tenantId);
  const [source] = await listRetirementRules(tx, ctx.tenantId, 'expected_date', sourceId);
  if (!source) throw new AppError('NOT_FOUND', '退休规则不存在');
  const name = `${source.name.slice(0, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  const conditions = source.conditions.map((condition) => ({ ...condition, values: [...condition.values] }));
  const id = await insertRule(tx, ctx, { ...source, name, conditions, enabled: false });
  const [after] = await listRetirementRules(tx, ctx.tenantId, source.purpose, id);
  await audit(tx, ctx, 'save', id, null, { ...after, copiedFrom: source.id });
  return after!;
}

/** 单条启停：只改启用状态。 */
export async function setRetirementRuleEnabled(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  enabled: boolean,
): Promise<RetirementRuleView> {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  await tx.execute(sql`UPDATE retirement_rules SET enabled = ${enabled}, revision = revision + 1,
      updated_at = ${ctx.now.toISOString()}::timestamptz WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  const [after] = await listRetirementRules(tx, ctx.tenantId, before.purpose, id);
  await audit(tx, ctx, 'enabled', id, before, after);
  return after!;
}

export async function deleteRetirementRule(tx: Tx, ctx: EmploymentContext, id: string) {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  // 条件行随规则级联删除
  await tx.execute(sql`DELETE FROM retirement_rules WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}
