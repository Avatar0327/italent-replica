/**
 * R2 BE-5c1a / 5c1b 预计退休日期与弹性范围规则（R2-T04 §2.4 / §9.1 / §9.1A，DEC-640、DEC-641、DEC-636 c4）：
 * 规则增删改查、复制、单条启停，挂在任职设置配置对象上（tenant.employment.configuration.write，管理员 other_settings），
 * 审计 retirement_rule.save / delete / enabled。purpose = expected_date | flexible_range；rule_type = fixed_age（仅预计日期）
 * | builtin（选用内置法定函数）；条件是四个固定槽位（性别、国籍、雇佣关系（必填）、个人身份），每槽至多一条、操作符只有 in。
 * 预置法定规则（preset，覆盖全公司）不可编辑 / 删除，可启停、可复制。本批没有任何定时或立即执行入口，规则只能配置；
 * loadRetirementRulesForRun 把启用规则展开成纯函数入参，留给 5c2。
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
  STATUTORY_FUNCTIONS,
  type RetirementCondition,
  type RetirementRule,
  type RetirementRulePurpose,
  type RetirementRuleType,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { requireEnabledIdentityTypes } from '../personnel/identity-types.js';
import { assertOrgsExist, expandRuleScopes } from './auto-regularization-rules.js';
import { assertRevision } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const RETIREMENT_RULE_AUDIT_TYPE = 'retirement_rule';
const NAME_MAX = 100;
const COPY_SUFFIX = '（复制）';

export interface RetirementRuleView {
  readonly id: string;
  readonly purpose: RetirementRulePurpose;
  readonly ruleType: RetirementRuleType;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  /** 适用全公司（预置规则及其未改范围的复制件）：orgIds 为空。 */
  readonly allOrgs: boolean;
  /** 预置法定规则：不可编辑 / 删除，可启停、可复制。 */
  readonly preset: boolean;
  readonly includeSubordinates: boolean;
  readonly retirementAgeYears: number | null;
  readonly retirementAgeMonths: number | null;
  readonly expectedFunction: string | null;
  readonly earliestFunction: string | null;
  readonly latestFunction: string | null;
  readonly conditions: RetirementCondition[];
  readonly enabled: boolean;
  readonly revision: number;
}

const conditionInput = z.strictObject({
  fieldCode: z.enum(RETIREMENT_CONDITION_FIELDS),
  operator: z.literal('in'),
  values: z
    .array(
      z
        .string()
        .max(100)
        .refine((value) => value.trim() !== '', '条件取值不能为空'),
    )
    .min(1)
    .max(RETIREMENT_CONDITION_VALUES_MAX)
    .refine((values) => new Set(values).size === values.length, '条件取值不能重复'),
});

const functionInput = (code: string) => z.literal(code, '内置函数不合法').optional();
const FUNCTION_KEYS = ['expectedFunction', 'earliestFunction', 'latestFunction'] as const;
const AGE_KEYS = ['retirementAgeYears', 'retirementAgeMonths'] as const;
type InputKey = (typeof FUNCTION_KEYS)[number] | (typeof AGE_KEYS)[number];

/** 规则类型缺省：预计日期 → 固定年龄；弹性范围只能选内置函数（DEC-640①）。 */
const defaultRuleType = (purpose: RetirementRulePurpose): RetirementRuleType =>
  purpose === 'flexible_range' ? 'builtin' : 'fixed_age';

const ruleInput = z
  .strictObject({
    purpose: z.enum(RETIREMENT_RULE_PURPOSES).default('expected_date'),
    ruleType: z.enum(RETIREMENT_RULE_TYPES).optional(),
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
    retirementAgeYears: z.int().min(RETIREMENT_AGE_YEARS.min).max(RETIREMENT_AGE_YEARS.max).optional(),
    retirementAgeMonths: z.int().min(RETIREMENT_AGE_MONTHS.min).max(RETIREMENT_AGE_MONTHS.max).optional(),
    expectedFunction: functionInput(STATUTORY_FUNCTIONS.expectedDate),
    earliestFunction: functionInput(STATUTORY_FUNCTIONS.earliest),
    latestFunction: functionInput(STATUTORY_FUNCTIONS.latest),
    conditions: z.array(conditionInput).max(RETIREMENT_CONDITION_FIELDS.length),
    enabled: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    const ruleType = input.ruleType ?? defaultRuleType(input.purpose);
    const issue = (message: string, path: string) => ctx.addIssue({ code: 'custom', message, path: [path] });
    const forbid = (keys: readonly InputKey[], why: string) =>
      keys.forEach((key) => input[key] !== undefined && issue(why, key));
    if (ruleType === 'fixed_age') {
      if (input.purpose !== 'expected_date') issue('弹性范围规则只能选用内置函数', 'ruleType');
      if (input.retirementAgeYears === undefined) issue('固定年龄规则须填写退休年龄', 'retirementAgeYears');
      forbid(FUNCTION_KEYS, '固定年龄规则不能选用内置函数');
    } else {
      forbid(AGE_KEYS, '内置函数规则不填退休年龄');
      const expected = input.purpose === 'expected_date';
      const wanted: readonly (typeof FUNCTION_KEYS)[number][] = expected
        ? ['expectedFunction']
        : ['earliestFunction', 'latestFunction'];
      for (const key of FUNCTION_KEYS)
        if ((input[key] === undefined) === wanted.includes(key))
          issue(wanted.includes(key) ? '须选用内置函数' : '该用途不能选用此内置函数', key);
    }
    const slots = input.conditions.map((condition) => condition.fieldCode);
    if (new Set(slots).size !== slots.length)
      ctx.addIssue({ code: 'custom', message: '每个条件槽位至多一条', path: ['conditions'] });
    const employ = input.conditions.find((condition) => condition.fieldCode === RETIREMENT_REQUIRED_CONDITION);
    if (!employ) ctx.addIssue({ code: 'custom', message: '雇佣关系为必填条件', path: ['conditions'] });
    else if (employ.values.some((value) => !(RETIREMENT_EMPLOY_TYPES as readonly string[]).includes(value)))
      ctx.addIssue({ code: 'custom', message: '雇佣关系取值不合法', path: ['conditions'] });
  })
  .transform((input) => ({
    ...input,
    ruleType: input.ruleType ?? defaultRuleType(input.purpose),
    retirementAgeYears: input.retirementAgeYears ?? null,
    retirementAgeMonths: input.retirementAgeYears === undefined ? null : (input.retirementAgeMonths ?? 0),
    expectedFunction: input.expectedFunction ?? null,
    earliestFunction: input.earliestFunction ?? null,
    latestFunction: input.latestFunction ?? null,
  }));
export type RetirementRuleInput = z.output<typeof ruleInput>;

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

/** GET ?purpose=：缺省 expected_date；其他取值 400。 */
export function parseRulePurpose(raw: string | undefined): RetirementRulePurpose {
  const parsed = z.enum(RETIREMENT_RULE_PURPOSES).default('expected_date').safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '规则用途不合法', parsed.error.issues);
  return parsed.data;
}

type RuleRow = Omit<RetirementRuleView, 'conditions'> & { readonly sequenceNo: number };

/** 每个用途一条预置法定规则（retirement-rule-presets.ts）；不占自建规则的 100 条名额。 */
const PRESET_RULE_COUNT = 1;

interface RuleFilter {
  readonly purpose?: RetirementRulePurpose;
  readonly id?: string;
  readonly enabledOnly?: boolean;
}

/** 数组一律逐项参数绑定（ARRAY[$1, $2]）：不手拼 PostgreSQL 数组字面量，取值里的制表符、换行、引号、反斜杠原样入库。 */
const arrayOf = (values: readonly string[], type: 'text' | 'uuid') =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::${sql.raw(type)}[]`;

/** 自建规则先于预置规则，其内按优先级再按登记顺序号（与匹配时“同优先级取先登记者”一致）；条件按固定槽位顺序。 */
async function selectRules(tx: Tx, tenantId: string, filter: RuleFilter) {
  const rules = rowsOf<RuleRow>(
    await tx.execute(sql`
      SELECT id, purpose, rule_type AS "ruleType", name, priority, sequence_no AS "sequenceNo", org_ids AS "orgIds",
        all_orgs AS "allOrgs", preset_code IS NOT NULL AS preset, include_subordinates AS "includeSubordinates",
        retirement_age_years AS "retirementAgeYears", retirement_age_months AS "retirementAgeMonths",
        expected_function AS "expectedFunction", earliest_function AS "earliestFunction",
        latest_function AS "latestFunction", enabled, revision
      FROM retirement_rules WHERE tenant_id = ${tenantId}
        ${filter.purpose ? sql`AND purpose = ${filter.purpose}` : sql``}
        ${filter.id ? sql`AND id = ${filter.id}::uuid` : sql``}
        ${filter.enabledOnly ? sql`AND enabled` : sql``}
      ORDER BY (preset_code IS NOT NULL), priority, sequence_no LIMIT ${RETIREMENT_RULE_LIMIT + PRESET_RULE_COUNT}`),
  );
  if (!rules.length) return [];
  const conditions = rowsOf<RetirementCondition & { ruleId: string }>(
    await tx.execute(sql`SELECT rule_id::text AS "ruleId", field_code AS "fieldCode", operator, "values"
      FROM retirement_rule_conditions WHERE tenant_id = ${tenantId}
        AND rule_id = ANY(${arrayOf(
          rules.map((rule) => rule.id),
          'uuid',
        )}) ORDER BY seq`),
  );
  return rules.map((rule) => ({
    ...rule,
    conditions: conditions
      .filter((condition) => condition.ruleId === rule.id)
      .map(({ fieldCode, operator, values }) => ({ fieldCode, operator, values })),
  }));
}

export async function listRetirementRules(
  tx: Tx,
  tenantId: string,
  purpose?: RetirementRulePurpose,
  ruleId?: string,
): Promise<RetirementRuleView[]> {
  const rules = await selectRules(tx, tenantId, { purpose, id: ruleId });
  return rules.map(({ sequenceNo: _sequenceNo, ...view }) => view);
}

/**
 * 5c2 批次与立即执行用：取启用的规则，适用组织已按“包含下级”展开（行政维度、按计算当天的组织版本），
 * 排序交给 matchRule（自建先于预置、优先级、序号）。预置规则 scopeAllOrgs = true，不看组织。
 */
export async function loadRetirementRulesForRun(
  tx: Tx,
  tenantId: string,
  purpose: RetirementRulePurpose,
  today: string,
): Promise<RetirementRule[]> {
  const rules = await selectRules(tx, tenantId, { purpose, enabledOnly: true });
  const expanded = await expandRuleScopes(tx, tenantId, rules, today);
  return expanded.map((rule) => ({
    id: rule.id,
    purpose: rule.purpose,
    enabled: rule.enabled,
    priority: rule.priority,
    sequenceNo: rule.sequenceNo,
    ruleType: rule.ruleType,
    preset: rule.preset,
    scopeOrgIds: rule.scopeOrgIds,
    scopeAllOrgs: rule.allOrgs,
    retirementAgeYears: rule.retirementAgeYears,
    retirementAgeMonths: rule.retirementAgeMonths,
    expectedFunction: rule.expectedFunction,
    earliestFunction: rule.earliestFunction,
    latestFunction: rule.latestFunction,
    conditions: rule.conditions,
  }));
}

export async function lockRetirementRules(tx: Tx, tenantId: string) {
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

/** 取规则并校验版本；mutate = 改内容 / 删除，预置规则一律拒绝（409 RETIREMENT_RULE_PRESET，惯例同预置字段 / 九宫格）。 */
async function lockedRule(tx: Tx, ctx: EmploymentContext, id: string, mutate: boolean) {
  const [before] = await listRetirementRules(tx, ctx.tenantId, undefined, id);
  if (!before) throw new AppError('NOT_FOUND', '退休规则不存在');
  if (mutate && before.preset)
    throw new AppError('CONFLICT', '预置法定规则不能修改或删除，可以停用或复制', { reason: 'RETIREMENT_RULE_PRESET' });
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

async function replaceConditions(tx: Tx, tenantId: string, ruleId: string, conditions: readonly RetirementCondition[]) {
  await tx.execute(sql`DELETE FROM retirement_rule_conditions WHERE tenant_id = ${tenantId}
    AND rule_id = ${ruleId}::uuid`);
  for (const condition of conditions)
    await tx.execute(sql`INSERT INTO retirement_rule_conditions(tenant_id, rule_id, seq, field_code, operator, "values")
      VALUES (${tenantId}, ${ruleId}::uuid, ${RETIREMENT_CONDITION_FIELDS.indexOf(condition.fieldCode) + 1},
        ${condition.fieldCode}, ${condition.operator}, ${arrayOf(condition.values, 'text')})`);
}

/** 引用校验：适用组织存在；个人身份条件只能取字典启用编码（A-9）。 */
async function assertReferences(tx: Tx, tenantId: string, input: RetirementRuleInput) {
  await assertOrgsExist(tx, tenantId, input.orgIds);
  const identity = input.conditions.find((condition) => condition.fieldCode === 'identityType');
  if (identity) await requireEnabledIdentityTypes(tx, tenantId, identity.values);
}

export interface RuleInsertExtra {
  /** 适用全公司：org_ids 写空（预置规则、预置规则的复制件）。 */
  readonly allOrgs?: boolean;
  /** 预置法定规则的稳定编码；自建规则不填。 */
  readonly presetCode?: string;
}

/** 新增一条规则（调用方已持规则锁、已核对版本 0）；登记顺序号在锁内分配（max + 1）。返回新规则 ID。 */
export async function insertRetirementRule(
  tx: Tx,
  scope: { readonly tenantId: string; readonly now: Date },
  input: RetirementRuleInput,
  extra: RuleInsertExtra = {},
) {
  const [count] = rowsOf<{ n: number; next: number }>(
    await tx.execute(sql`SELECT count(*) FILTER (WHERE preset_code IS NULL)::int AS n,
        COALESCE(max(sequence_no), 0) + 1 AS next
      FROM retirement_rules WHERE tenant_id = ${scope.tenantId} AND purpose = ${input.purpose}`),
  );
  if (!extra.presetCode && count!.n >= RETIREMENT_RULE_LIMIT)
    throw new AppError('CONFLICT', '退休规则已达上限', {
      reason: 'RETIREMENT_RULE_LIMIT_REACHED',
      limit: RETIREMENT_RULE_LIMIT,
    });
  const id = randomUUID();
  const now = scope.now.toISOString();
  const orgIds = extra.allOrgs ? [] : input.orgIds;
  await tx.execute(sql`INSERT INTO retirement_rules(id, tenant_id, purpose, rule_type, name, priority, sequence_no,
      org_ids, all_orgs, preset_code, include_subordinates, retirement_age_years, retirement_age_months,
      expected_function, earliest_function, latest_function, enabled, created_at, updated_at)
    VALUES (${id}::uuid, ${scope.tenantId}, ${input.purpose}, ${input.ruleType}, ${input.name}, ${input.priority},
      ${count!.next}, ${arrayOf(orgIds, 'uuid')}, ${extra.allOrgs ?? false}, ${extra.presetCode ?? null},
      ${input.includeSubordinates}, ${input.retirementAgeYears}, ${input.retirementAgeMonths},
      ${input.expectedFunction}, ${input.earliestFunction}, ${input.latestFunction}, ${input.enabled},
      ${now}::timestamptz, ${now}::timestamptz)`);
  await replaceConditions(tx, scope.tenantId, id, input.conditions);
  return id;
}

/** 新增（If-Match 0）或整份保存（If-Match = 当前 revision）一条规则，条件整份替换；用途与类型创建后不可改。 */
export async function saveRetirementRule(
  tx: Tx,
  ctx: EmploymentContext,
  input: RetirementRuleInput,
  id?: string,
): Promise<RetirementRuleView> {
  await lockRetirementRules(tx, ctx.tenantId);
  await assertReferences(tx, ctx.tenantId, input);
  const before = id ? await lockedRule(tx, ctx, id, true) : null;
  if (before && (before.purpose !== input.purpose || before.ruleType !== input.ruleType))
    throw new AppError('VALIDATION_FAILED', '规则用途与类型创建后不可修改', {
      reason: 'RETIREMENT_RULE_KIND_IMMUTABLE',
    });
  if (!before) assertRevision(ctx.expectedRevision, 0);
  const ruleId = before ? before.id : await insertRetirementRule(tx, ctx, input);
  if (before) {
    await tx.execute(sql`UPDATE retirement_rules SET name = ${input.name}, priority = ${input.priority},
        org_ids = ${arrayOf(input.orgIds, 'uuid')}, all_orgs = false,
        include_subordinates = ${input.includeSubordinates},
        retirement_age_years = ${input.retirementAgeYears}, retirement_age_months = ${input.retirementAgeMonths},
        expected_function = ${input.expectedFunction}, earliest_function = ${input.earliestFunction},
        latest_function = ${input.latestFunction}, enabled = ${input.enabled}, revision = revision + 1,
        updated_at = ${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${ruleId}::uuid`);
    await replaceConditions(tx, ctx.tenantId, ruleId, input.conditions);
  }
  const [after] = await listRetirementRules(tx, ctx.tenantId, input.purpose, ruleId);
  await audit(tx, ctx, 'save', ruleId, before, after);
  return after!;
}

/**
 * 行操作“复制”：照原规则另建一条（名称加“（复制）”），默认停用，管理员核对后再启用。预置规则的复制件是普通规则
 * （可编辑、可删除），仍适用全公司，直到管理员保存时选定适用组织。
 */
export async function copyRetirementRule(
  tx: Tx,
  ctx: EmploymentContext,
  sourceId: string,
): Promise<RetirementRuleView> {
  await lockRetirementRules(tx, ctx.tenantId);
  const [source] = await listRetirementRules(tx, ctx.tenantId, undefined, sourceId);
  if (!source) throw new AppError('NOT_FOUND', '退休规则不存在');
  assertRevision(ctx.expectedRevision, 0);
  const name = `${source.name.slice(0, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  const conditions = source.conditions.map((condition) => ({ ...condition, values: [...condition.values] }));
  const id = await insertRetirementRule(
    tx,
    ctx,
    { ...source, name, conditions, enabled: false },
    { allOrgs: source.allOrgs },
  );
  const [after] = await listRetirementRules(tx, ctx.tenantId, source.purpose, id);
  await audit(tx, ctx, 'save', id, null, { ...after, copiedFrom: source.id });
  return after!;
}

/** 单条启停：只改启用状态（预置规则也可启停）。 */
export async function setRetirementRuleEnabled(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  enabled: boolean,
): Promise<RetirementRuleView> {
  await lockRetirementRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id, false);
  await tx.execute(sql`UPDATE retirement_rules SET enabled = ${enabled}, revision = revision + 1,
      updated_at = ${ctx.now.toISOString()}::timestamptz WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  const [after] = await listRetirementRules(tx, ctx.tenantId, before.purpose, id);
  await audit(tx, ctx, 'enabled', id, before, after);
  return after!;
}

export async function deleteRetirementRule(tx: Tx, ctx: EmploymentContext, id: string) {
  await lockRetirementRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id, true);
  // 条件行随规则级联删除
  await tx.execute(sql`DELETE FROM retirement_rules WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}
