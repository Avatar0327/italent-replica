/**
 * R2 BE-15b2 自动发起试用期考核规则（B58；docs/02_业务建模/29 PB-R16 / R17 / R22）：规则增删改查、复制、单条启停（DEC-533②），
 * 挂在任职设置配置对象上（tenant.employment.configuration.write，管理员 other_settings），审计 auto_assessment_rule.*。
 * 表单：考核名称*（发起时即考核记录的名称）、考核类型*（试用中 / 转正）、入职后第 N 天*（1～999，R2e6）、优先级*、
 * 适用组织*（可取消包含下级）、发起人类型*（当前管理员 / 主职部门 HRBP / 负责人）。
 * 附加范围（员工信息 / 任职记录 / 合同公司白名单字段）、“按职务”发起人与失败通知未实现，接口拒绝未知字段（PR 未决 / 假设）。
 * 修改 / 删除规则不影响已发起的（PB-R22）：发起台账与考核不随规则变化。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import {
  ASSESSMENT_NAME_MAX,
  ASSESSMENT_TYPE_CODES,
  AUTO_ASSESSMENT_DAYS_MESSAGE,
  AUTO_ASSESSMENT_RULE_LIMIT,
  AUTO_ASSESSMENT_SETTING_KEY,
  AUTO_RULE_INITIATOR_CODES,
  isAutoAssessmentDays,
  type AssessmentType,
  type AutoRuleInitiator,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertOrgsExist, expandRuleScopes } from './auto-regularization-rules.js';
import { assertRevision } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const AUTO_ASSESSMENT_RULE_AUDIT_TYPE = 'auto_assessment_rule';
const COPY_SUFFIX = '（复制）';

export interface AutoAssessmentRuleView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly includeSubordinates: boolean;
  readonly assessmentType: AssessmentType;
  readonly daysAfterEntry: number;
  readonly initiatorType: AutoRuleInitiator;
  readonly enabled: boolean;
  readonly operatorUserId: string;
  readonly revision: number;
}

const ruleInput = z.strictObject({
  name: z.string().trim().min(1).max(ASSESSMENT_NAME_MAX),
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
  assessmentType: z.enum(ASSESSMENT_TYPE_CODES),
  daysAfterEntry: z.int(),
  initiatorType: z.enum(AUTO_RULE_INITIATOR_CODES),
  enabled: z.boolean().default(true),
});
export type AutoAssessmentRuleInput = z.infer<typeof ruleInput>;

/** 入职后天数先单独判，空值 / 0 / 越界 / 非整数都报原站原文（R2e6，AC-PB-12）。 */
export function parseAutoAssessmentRule(raw: unknown): AutoAssessmentRuleInput {
  const days = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).daysAfterEntry : undefined;
  if (!isAutoAssessmentDays(days))
    throw new AppError('VALIDATION_FAILED', AUTO_ASSESSMENT_DAYS_MESSAGE, { reason: 'AUTO_RULE_DAYS_INVALID' });
  const parsed = ruleInput.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '自动考核规则字段不合法', parsed.error.issues);
  return parsed.data;
}

/** 规则按优先级再按登记顺序号排列（与匹配时“同优先级取先登记者”一致）。 */
export async function listAutoAssessmentRules(
  tx: Tx,
  tenantId: string,
  ruleId?: string,
): Promise<AutoAssessmentRuleView[]> {
  return rowsOf<AutoAssessmentRuleView>(
    await tx.execute(sql`
      SELECT id, name, priority, org_ids AS "orgIds", include_subordinates AS "includeSubordinates",
        assessment_type AS "assessmentType", days_after_entry AS "daysAfterEntry", initiator_type AS "initiatorType",
        enabled, operator_user_id AS "operatorUserId", revision
      FROM employment_auto_assessment_rules WHERE tenant_id = ${tenantId}
        ${ruleId ? sql`AND id = ${ruleId}::uuid` : sql``}
      ORDER BY priority, sequence_no LIMIT ${AUTO_ASSESSMENT_RULE_LIMIT}`),
  );
}

export type ExpandedAutoAssessmentRule = AutoAssessmentRuleView & { readonly scopeOrgIds: readonly string[] };

/** 执行用：启用的规则按优先级排好并展开适用组织。 */
export async function loadEnabledAutoAssessmentRules(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<ExpandedAutoAssessmentRule[]> {
  const rules = (await listAutoAssessmentRules(tx, tenantId)).filter((rule) => rule.enabled);
  return expandRuleScopes(tx, tenantId, rules, today);
}

/** F-223：员工锁内复核读最新规则状态，做法同 currentAutoRegularizationRules（id + revision 比对，有出入才整体重读）。 */
export async function currentAutoAssessmentRules(
  tx: Tx,
  tenantId: string,
  snapshot: readonly ExpandedAutoAssessmentRule[],
  today: string,
): Promise<readonly ExpandedAutoAssessmentRule[]> {
  const now = rowsOf<{ id: string; revision: number }>(
    await tx.execute(sql`SELECT id::text, revision FROM employment_auto_assessment_rules
      WHERE tenant_id = ${tenantId} AND enabled`),
  );
  const same =
    now.length === snapshot.length &&
    snapshot.every((rule) => now.some((row) => row.id === rule.id && row.revision === rule.revision));
  return same ? snapshot : loadEnabledAutoAssessmentRules(tx, tenantId, today);
}

/** 总开关有效值（两层配置；系统值 false）。 */
export async function readAutoAssessmentEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  return (await readEffectiveSetting(tx, tenantId, AUTO_ASSESSMENT_SETTING_KEY)).value === true;
}

async function lockRules(tx: Tx, tenantId: string) {
  await advisoryLock(tx, asUuid(tenantId), ':employment-auto-assessment-rules');
}

async function audit(tx: Tx, ctx: EmploymentContext, action: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${AUTO_ASSESSMENT_RULE_AUDIT_TYPE}.${action}`,
    objectType: AUTO_ASSESSMENT_RULE_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function lockedRule(tx: Tx, ctx: EmploymentContext, id: string) {
  const [before] = await listAutoAssessmentRules(tx, ctx.tenantId, id);
  if (!before) throw new AppError('NOT_FOUND', '自动考核规则不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

async function insertRule(tx: Tx, ctx: EmploymentContext, input: AutoAssessmentRuleInput) {
  assertRevision(ctx.expectedRevision, 0);
  // 登记顺序号在规则锁内分配（max + 1），同自动转正规则
  const [count] = rowsOf<{ n: number; next: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n, COALESCE(max(sequence_no), 0) + 1 AS next
      FROM employment_auto_assessment_rules WHERE tenant_id = ${ctx.tenantId}`),
  );
  if (count!.n >= AUTO_ASSESSMENT_RULE_LIMIT)
    throw new AppError('CONFLICT', '自动考核规则已达上限', {
      reason: 'AUTO_RULE_LIMIT_REACHED',
      limit: AUTO_ASSESSMENT_RULE_LIMIT,
    });
  const id = randomUUID();
  const now = ctx.now.toISOString();
  await tx.execute(sql`INSERT INTO employment_auto_assessment_rules(id, tenant_id, name, priority, sequence_no,
      org_ids, include_subordinates, assessment_type, days_after_entry, initiator_type, enabled, operator_user_id,
      created_at, updated_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${input.name}, ${input.priority}, ${count!.next},
      ${`{${input.orgIds.join(',')}}`}::uuid[], ${input.includeSubordinates}, ${input.assessmentType},
      ${input.daysAfterEntry}, ${input.initiatorType}, ${input.enabled}, ${ctx.userId}::uuid,
      ${now}::timestamptz, ${now}::timestamptz)`);
  return id;
}

/** 新增（If-Match 0）或整份保存（If-Match = 当前 revision）一条规则；保存人记为“当前管理员”。 */
export async function saveAutoAssessmentRule(
  tx: Tx,
  ctx: EmploymentContext,
  input: AutoAssessmentRuleInput,
  id?: string,
): Promise<AutoAssessmentRuleView> {
  await lockRules(tx, ctx.tenantId);
  await assertOrgsExist(tx, ctx.tenantId, input.orgIds);
  const before = id ? await lockedRule(tx, ctx, id) : null;
  const ruleId = before ? before.id : await insertRule(tx, ctx, input);
  if (before)
    await tx.execute(sql`UPDATE employment_auto_assessment_rules SET name = ${input.name},
        priority = ${input.priority}, org_ids = ${`{${input.orgIds.join(',')}}`}::uuid[],
        include_subordinates = ${input.includeSubordinates}, assessment_type = ${input.assessmentType},
        days_after_entry = ${input.daysAfterEntry}, initiator_type = ${input.initiatorType}, enabled = ${input.enabled},
        operator_user_id = ${ctx.userId}::uuid, revision = revision + 1,
        updated_at = ${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${ruleId}::uuid`);
  const [after] = await listAutoAssessmentRules(tx, ctx.tenantId, ruleId);
  await audit(tx, ctx, before ? 'update' : 'create', ruleId, before, after);
  return after!;
}

/** 行操作“复制”：照原规则另建一条（名称加“（复制）”），默认停用，管理员核对后再启用（PR 假设，同自动转正）。 */
export async function copyAutoAssessmentRule(
  tx: Tx,
  ctx: EmploymentContext,
  sourceId: string,
): Promise<AutoAssessmentRuleView> {
  await lockRules(tx, ctx.tenantId);
  const [source] = await listAutoAssessmentRules(tx, ctx.tenantId, sourceId);
  if (!source) throw new AppError('NOT_FOUND', '自动考核规则不存在');
  const name = `${source.name.slice(0, ASSESSMENT_NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  const id = await insertRule(tx, ctx, { ...source, name, enabled: false });
  const [after] = await listAutoAssessmentRules(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'create', id, null, { ...after, copiedFrom: source.id });
  return after!;
}

/** 单条启停（DEC-533②，复刻增加）：只改启用状态，不改保存人。 */
export async function setAutoAssessmentRuleEnabled(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  enabled: boolean,
): Promise<AutoAssessmentRuleView> {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  await tx.execute(sql`UPDATE employment_auto_assessment_rules SET enabled = ${enabled},
      revision = revision + 1, updated_at = ${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  const [after] = await listAutoAssessmentRules(tx, ctx.tenantId, id);
  await audit(tx, ctx, enabled ? 'enable' : 'disable', id, before, after);
  return after!;
}

export async function deleteAutoAssessmentRule(tx: Tx, ctx: EmploymentContext, id: string) {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  await tx.execute(
    sql`DELETE FROM employment_auto_assessment_rules WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`,
  );
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}
