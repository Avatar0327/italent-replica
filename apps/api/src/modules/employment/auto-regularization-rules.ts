/**
 * R2 BE-15a 自动转正规则（B57；docs/02_业务建模/29 PB-R16 / R18 / R22）：规则增删改查、复制、单条启停（DEC-533②），
 * 挂在任职设置配置对象上（tenant.employment.configuration.write，管理员 other_settings），审计 auto_regularization_rule.*。
 * 表单：规则名称*（DEC-539②）、优先级*、适用组织*（可取消包含下级，R2e6）、业务处理规则*（自动转正 / 自动发起转正申请 +
 * 到期前 0～999 天）、发起人类型*、试用结果（BE-3 起转正必填，规则上默认“正常转正”）。
 * 附加范围（职务序列、工作地点、用工形式、人员类别）与“发送失败通知”未实现，接口拒绝未知字段（PR 未决 / 假设）。
 * 修改 / 删除规则不影响已发起的（PB-R22）：发起台账与业务不随规则变化。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import {
  AUTO_REGULARIZATION_DAYS_MESSAGE,
  AUTO_REGULARIZATION_MODE_CODES,
  AUTO_REGULARIZATION_RULE_LIMIT,
  AUTO_REGULARIZATION_SETTING_KEY,
  AUTO_RULE_INITIATOR_CODES,
  isAutoRegularizationDays,
  type AutoRegularizationMode,
  type AutoRuleInitiator,
  type OrgId,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { listOrgDescendantsInTransaction } from '../org/hierarchy-reader.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { assertRevision } from './context.js';
import { requireEnabledProbationResult } from './probation-results.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const AUTO_REGULARIZATION_RULE_AUDIT_TYPE = 'auto_regularization_rule';
const NAME_MAX = 100;
const COPY_SUFFIX = '（复制）';

export interface AutoRegularizationRuleView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly includeSubordinates: boolean;
  readonly mode: AutoRegularizationMode;
  readonly daysBefore: number;
  readonly initiatorType: AutoRuleInitiator;
  readonly probationResult: string;
  readonly enabled: boolean;
  readonly operatorUserId: string;
  readonly revision: number;
}

const ruleInput = z.strictObject({
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
  mode: z.enum(AUTO_REGULARIZATION_MODE_CODES),
  daysBefore: z.int(),
  initiatorType: z.enum(AUTO_RULE_INITIATOR_CODES),
  probationResult: z.string().trim().min(1).max(100).default('normal'),
  enabled: z.boolean().default(true),
});
export type AutoRegularizationRuleInput = z.infer<typeof ruleInput>;

/** 到期前天数先单独判，空值 / 越界 / 非整数都报原站原文（R2e6，AC-PB-13）。 */
export function parseAutoRegularizationRule(raw: unknown): AutoRegularizationRuleInput {
  const days = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>).daysBefore : undefined;
  if (!isAutoRegularizationDays(days))
    throw new AppError('VALIDATION_FAILED', AUTO_REGULARIZATION_DAYS_MESSAGE, { reason: 'AUTO_RULE_DAYS_INVALID' });
  const parsed = ruleInput.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '自动转正规则字段不合法', parsed.error.issues);
  return parsed.data;
}

export function parseRuleEnabled(raw: unknown): boolean {
  const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '启停须为 { enabled: 布尔值 }', parsed.error.issues);
  return parsed.data.enabled;
}

/** 规则按优先级再按登记顺序号排列（与匹配时“同优先级取先登记者”一致）。 */
export async function listAutoRegularizationRules(
  tx: Tx,
  tenantId: string,
  ruleId?: string,
): Promise<AutoRegularizationRuleView[]> {
  return rowsOf<AutoRegularizationRuleView>(
    await tx.execute(sql`
      SELECT id, name, priority, org_ids AS "orgIds", include_subordinates AS "includeSubordinates", mode,
        days_before AS "daysBefore", initiator_type AS "initiatorType", probation_result AS "probationResult",
        enabled, operator_user_id AS "operatorUserId", revision
      FROM employment_auto_regularization_rules WHERE tenant_id = ${tenantId}
        ${ruleId ? sql`AND id = ${ruleId}::uuid` : sql``}
      ORDER BY priority, sequence_no LIMIT ${AUTO_REGULARIZATION_RULE_LIMIT}`),
  );
}

export interface ExpandedAutoRegularizationRule extends AutoRegularizationRuleView {
  /** 已按“包含下级”展开（行政维度、按执行当天的组织版本，含停用组织，同合同续签规则）。 */
  readonly scopeOrgIds: readonly string[];
}

/** 执行用：启用的规则按优先级排好并展开适用组织。 */
export async function loadEnabledAutoRegularizationRules(
  tx: Tx,
  tenantId: string,
  today: string,
): Promise<ExpandedAutoRegularizationRule[]> {
  const rules = (await listAutoRegularizationRules(tx, tenantId)).filter((rule) => rule.enabled);
  const descendants = new Map<string, readonly string[]>();
  const expanded: ExpandedAutoRegularizationRule[] = [];
  for (const rule of rules) {
    const orgIds = new Set(rule.orgIds);
    if (rule.includeSubordinates)
      for (const orgId of rule.orgIds) {
        let children = descendants.get(orgId);
        if (!children) {
          children = await listOrgDescendantsInTransaction(
            tx,
            { tenantId, orgId: orgId as OrgId, dimension: 'admin', asOf: today },
            { includeDisabled: true },
          );
          descendants.set(orgId, children);
        }
        for (const id of children) orgIds.add(id);
      }
    expanded.push({ ...rule, scopeOrgIds: [...orgIds] });
  }
  return expanded;
}

/** 总开关有效值（两层配置；系统值 false）。 */
export async function readAutoRegularizationEnabled(tx: Tx, tenantId: string): Promise<boolean> {
  return (await readEffectiveSetting(tx, tenantId, AUTO_REGULARIZATION_SETTING_KEY)).value === true;
}

async function lockRules(tx: Tx, tenantId: string) {
  await advisoryLock(tx, asUuid(tenantId), ':employment-auto-regularization-rules');
}

async function assertOrgsExist(tx: Tx, tenantId: string, orgIds: readonly string[]): Promise<void> {
  const [row] = rowsOf<{ found: number }>(
    await tx.execute(sql`SELECT count(DISTINCT org_id)::int AS found FROM org_versions
      WHERE tenant_id = ${tenantId} AND org_id = ANY(${`{${orgIds.join(',')}}`}::uuid[])`),
  );
  if (row?.found !== orgIds.length)
    throw new AppError('VALIDATION_FAILED', '适用组织包含不存在的组织', { reason: 'ORG_NOT_FOUND' });
}

async function audit(tx: Tx, ctx: EmploymentContext, action: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${AUTO_REGULARIZATION_RULE_AUDIT_TYPE}.${action}`,
    objectType: AUTO_REGULARIZATION_RULE_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function lockedRule(tx: Tx, ctx: EmploymentContext, id: string) {
  const [before] = await listAutoRegularizationRules(tx, ctx.tenantId, id);
  if (!before) throw new AppError('NOT_FOUND', '自动转正规则不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

async function insertRule(tx: Tx, ctx: EmploymentContext, input: AutoRegularizationRuleInput) {
  assertRevision(ctx.expectedRevision, 0);
  // 登记顺序号在规则锁内分配（max + 1），同自动加黑规则
  const [count] = rowsOf<{ n: number; next: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n, COALESCE(max(sequence_no), 0) + 1 AS next
      FROM employment_auto_regularization_rules WHERE tenant_id = ${ctx.tenantId}`),
  );
  if (count!.n >= AUTO_REGULARIZATION_RULE_LIMIT)
    throw new AppError('CONFLICT', '自动转正规则已达上限', {
      reason: 'AUTO_RULE_LIMIT_REACHED',
      limit: AUTO_REGULARIZATION_RULE_LIMIT,
    });
  const id = randomUUID();
  const now = ctx.now.toISOString();
  await tx.execute(sql`INSERT INTO employment_auto_regularization_rules(id, tenant_id, name, priority, sequence_no,
      org_ids, include_subordinates, mode, days_before, initiator_type, probation_result, enabled, operator_user_id,
      created_at, updated_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${input.name}, ${input.priority}, ${count!.next},
      ${`{${input.orgIds.join(',')}}`}::uuid[], ${input.includeSubordinates}, ${input.mode}, ${input.daysBefore},
      ${input.initiatorType}, ${input.probationResult}, ${input.enabled}, ${ctx.userId}::uuid,
      ${now}::timestamptz, ${now}::timestamptz)`);
  return id;
}

/** 新增（If-Match 0）或整份保存（If-Match = 当前 revision）一条规则；保存人记为“当前管理员”。 */
export async function saveAutoRegularizationRule(
  tx: Tx,
  ctx: EmploymentContext,
  input: AutoRegularizationRuleInput,
  id?: string,
): Promise<AutoRegularizationRuleView> {
  await lockRules(tx, ctx.tenantId);
  await assertOrgsExist(tx, ctx.tenantId, input.orgIds);
  const probationResult = await requireEnabledProbationResult(tx, ctx.tenantId, input.probationResult);
  const normalized = { ...input, probationResult };
  const before = id ? await lockedRule(tx, ctx, id) : null;
  const ruleId = before ? before.id : await insertRule(tx, ctx, normalized);
  if (before)
    await tx.execute(sql`UPDATE employment_auto_regularization_rules SET name = ${input.name},
        priority = ${input.priority}, org_ids = ${`{${input.orgIds.join(',')}}`}::uuid[],
        include_subordinates = ${input.includeSubordinates}, mode = ${input.mode}, days_before = ${input.daysBefore},
        initiator_type = ${input.initiatorType}, probation_result = ${probationResult}, enabled = ${input.enabled},
        operator_user_id = ${ctx.userId}::uuid, revision = revision + 1,
        updated_at = ${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${ruleId}::uuid`);
  const [after] = await listAutoRegularizationRules(tx, ctx.tenantId, ruleId);
  await audit(tx, ctx, before ? 'update' : 'create', ruleId, before, after);
  return after!;
}

/** 行操作“复制”：照原规则另建一条（名称加“（复制）”），默认停用，管理员核对后再启用（PR 假设）。 */
export async function copyAutoRegularizationRule(
  tx: Tx,
  ctx: EmploymentContext,
  sourceId: string,
): Promise<AutoRegularizationRuleView> {
  await lockRules(tx, ctx.tenantId);
  const [source] = await listAutoRegularizationRules(tx, ctx.tenantId, sourceId);
  if (!source) throw new AppError('NOT_FOUND', '自动转正规则不存在');
  const name = `${source.name.slice(0, NAME_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  const id = await insertRule(tx, ctx, { ...source, name, enabled: false });
  const [after] = await listAutoRegularizationRules(tx, ctx.tenantId, id);
  await audit(tx, ctx, 'create', id, null, { ...after, copiedFrom: source.id });
  return after!;
}

/** 单条启停（DEC-533②，复刻增加）：只改启用状态，不改保存人。 */
export async function setAutoRegularizationRuleEnabled(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
  enabled: boolean,
): Promise<AutoRegularizationRuleView> {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  await tx.execute(sql`UPDATE employment_auto_regularization_rules SET enabled = ${enabled},
      revision = revision + 1, updated_at = ${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  const [after] = await listAutoRegularizationRules(tx, ctx.tenantId, id);
  await audit(tx, ctx, enabled ? 'enable' : 'disable', id, before, after);
  return after!;
}

export async function deleteAutoRegularizationRule(tx: Tx, ctx: EmploymentContext, id: string) {
  await lockRules(tx, ctx.tenantId);
  const before = await lockedRule(tx, ctx, id);
  await tx.execute(
    sql`DELETE FROM employment_auto_regularization_rules WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`,
  );
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}
