/**
 * 入职生成邮箱规则（R2 BE-2b；34 EN-R12）：规则整份替换的配置，加上对待入职记录的“生成邮箱”判定。
 * 生成只给建议：不预留序号、不回写人员档案，由办理入职表单取用（真实占用在建账号时由登录邮箱唯一性兜底）；
 * 每次生成（含失败）在同事务写审计，失败原因落在审计里（EN-R12「写失败原因」）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  EMAIL_EMPLOY_TYPES,
  EMAIL_PREFIX_FIELD_CODES,
  EMAIL_RULE_LIMIT,
  ENTRY_STATUS,
  escapeRegExp,
  nextAvailableEmail,
  normalizeEmailDomain,
  planEntryEmail,
  type EmailGeneration,
  type EmailPrefixField,
  type EmailRuleFacts,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { assertRevision, auditEmployment } from './context.js';
import { lockPendingEntry } from './employee-status.js';
import { rowsOf } from './read-model.js';
import type { EmploymentContext } from './types.js';

export interface EmailRuleView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly orgIds: readonly string[];
  readonly employTypes: readonly string[];
  readonly prefixField: EmailPrefixField;
  readonly domain: string;
}
export interface EmailRuleSet {
  readonly revision: number;
  readonly entryEmailRules: readonly EmailRuleView[];
}

const ruleInput = z.strictObject({
  id: z
    .uuid()
    .transform((value) => value.toLowerCase())
    .optional(),
  name: z.string().trim().min(1).max(100),
  priority: z.int().min(0).max(9999),
  enabled: z.boolean().default(true),
  orgIds: z
    .array(z.uuid().transform((value) => value.toLowerCase()))
    .min(1)
    .max(50),
  employTypes: z.array(z.enum(EMAIL_EMPLOY_TYPES)).max(EMAIL_EMPLOY_TYPES.length).default([]),
  prefixField: z.enum(EMAIL_PREFIX_FIELD_CODES),
  domain: z.string().transform((value, ctx) => {
    const domain = normalizeEmailDomain(value);
    if (domain === null) ctx.addIssue({ code: 'custom', message: '邮箱后缀不合法' });
    return domain ?? value;
  }),
});
export const emailRulesBody = z
  .strictObject({ entryEmailRules: z.array(ruleInput).max(EMAIL_RULE_LIMIT) })
  .refine(({ entryEmailRules: rules }) => new Set(rules.map((rule) => rule.name)).size === rules.length, {
    message: '规则名称不能重复',
  })
  .refine(({ entryEmailRules: rules }) => rules.every((rule) => new Set(rule.orgIds).size === rule.orgIds.length), {
    message: '组织范围不能重复',
  });
export type EmailRulesBody = z.infer<typeof emailRulesBody>;

export async function readEmailRules(tx: Tx, tenantId: string): Promise<EmailRuleSet> {
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_email_rule_sets WHERE tenant_id=${tenantId}`),
  );
  const revision = head?.revision ?? 0;
  const rules = rowsOf<EmailRuleView>(
    await tx.execute(sql`
    SELECT rule_id AS id, name, priority, enabled, org_ids AS "orgIds", employ_types AS "employTypes",
      prefix_field AS "prefixField", domain
    FROM employment_email_rules WHERE tenant_id=${tenantId} AND set_revision=${revision} ORDER BY ordinal
  `),
  );
  return { revision, entryEmailRules: rules };
}

async function assertOrgsExist(tx: Tx, tenantId: string, orgIds: readonly string[]): Promise<void> {
  if (!orgIds.length) return;
  const [row] = rowsOf<{ found: number }>(
    await tx.execute(sql`
    SELECT count(DISTINCT org_id)::int AS found FROM org_versions
    WHERE tenant_id=${tenantId} AND org_id = ANY(${`{${orgIds.join(',')}}`}::uuid[])
  `),
  );
  if (row?.found !== new Set(orgIds).size)
    throw new AppError('VALIDATION_FAILED', '组织范围包含不存在的组织', { reason: 'ORG_NOT_FOUND' });
}

/** 整份替换（If-Match = 当前版本号）：写新版本的规则行并推进头表，审计同事务。 */
export async function replaceEmailRules(tx: Tx, ctx: EmploymentContext, input: EmailRulesBody): Promise<EmailRuleSet> {
  await tx.execute(
    sql`INSERT INTO employment_email_rule_sets(tenant_id) VALUES(${ctx.tenantId}) ON CONFLICT DO NOTHING`,
  );
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_email_rule_sets WHERE tenant_id=${ctx.tenantId} FOR UPDATE`),
  );
  assertRevision(ctx.expectedRevision, head!.revision);
  const rules = input.entryEmailRules;
  await assertOrgsExist(tx, ctx.tenantId, [...new Set(rules.flatMap((rule) => rule.orgIds))]);
  const before = await readEmailRules(tx, ctx.tenantId);
  const revision = head!.revision + 1;
  for (const [ordinal, rule] of rules.entries()) {
    await tx.execute(sql`
      INSERT INTO employment_email_rules(tenant_id,set_revision,rule_id,ordinal,name,priority,enabled,org_ids,
        employ_types,prefix_field,domain,created_at)
      VALUES(${ctx.tenantId},${revision},${rule.id ?? randomUUID()}::uuid,${ordinal},${rule.name},${rule.priority},
        ${rule.enabled},${`{${rule.orgIds.join(',')}}`}::uuid[],${`{${rule.employTypes.join(',')}}`}::text[],
        ${rule.prefixField},${rule.domain},${ctx.now.toISOString()}::timestamptz)
    `);
  }
  await tx.execute(sql`
    UPDATE employment_email_rule_sets SET revision=${revision}, updated_at=${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId}
  `);
  const after = await readEmailRules(tx, ctx.tenantId);
  await auditEmployment(
    tx,
    ctx,
    'employment.entry_email_rules.update',
    'employment_settings',
    ctx.tenantId,
    before,
    after,
  );
  return after;
}

/** 入职日当天，部门及其全部上级（行政维度）。 */
async function orgChain(tx: Tx, tenantId: string, departmentId: string, asOf: string): Promise<string[]> {
  const rows = rowsOf<{ orgId: string }>(
    await tx.execute(sql`
    WITH RECURSIVE current_versions AS (
      SELECT DISTINCT ON (org_id) id, org_id, stop_date FROM org_versions
      WHERE tenant_id=${tenantId} AND start_date <= ${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC
    ), chain AS (
      SELECT v.org_id, v.id AS version_id, ARRAY[v.org_id] AS path
      FROM current_versions v WHERE v.org_id=${departmentId}::uuid
      UNION ALL
      SELECT parent.org_id, parent.id, chain.path || parent.org_id FROM chain
      JOIN org_hierarchy_links link ON link.tenant_id=${tenantId} AND link.dimension='admin'
        AND link.version_id=chain.version_id
      JOIN current_versions parent ON parent.org_id=link.parent_org_id AND parent.stop_date >= ${asOf}::date
      WHERE NOT parent.org_id = ANY(chain.path)
    )
    SELECT org_id AS "orgId" FROM chain
  `),
  );
  return rows.map((row) => row.orgId);
}

async function personFacts(tx: Tx, tenantId: string, employeeId: string) {
  const [row] = rowsOf<{ employeeCode: string; namePinyin: string | null; pinyinInitials: string | null }>(
    await tx.execute(sql`
    SELECT e.code AS "employeeCode", v.name_pinyin AS "namePinyin", v.pinyin_initials AS "pinyinInitials"
    FROM employment_employees e
    LEFT JOIN LATERAL (SELECT pv.name_pinyin, pv.pinyin_initials FROM personnel_employee_versions pv
      WHERE pv.tenant_id=e.tenant_id AND pv.employee_id=e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
    WHERE e.tenant_id=${tenantId} AND e.id=${employeeId}::uuid
  `),
  );
  if (!row) throw new AppError('NOT_FOUND', '员工不存在');
  return row;
}

/** 已占用的邮箱：人员档案最新版本的工作邮箱 / 个人邮箱，以及本租户成员的登录邮箱（不分大小写，只取同前缀同后缀）。 */
async function takenEmails(tx: Tx, tenantId: string, prefix: string, domain: string): Promise<string[]> {
  const pattern = `^${escapeRegExp(prefix)}[0-9]*@${escapeRegExp(domain)}$`;
  const rows = rowsOf<{ addr: string }>(
    await tx.execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (employee_id) work_email, email FROM personnel_employee_versions
      WHERE tenant_id=${tenantId} ORDER BY employee_id, revision DESC
    )
    SELECT lower(addr) AS addr FROM (
      SELECT work_email AS addr FROM latest
      UNION ALL SELECT email FROM latest
      UNION ALL SELECT acc.email FROM tenant_member_accounts(
        (SELECT array_agg(user_id) FROM tenant_memberships WHERE tenant_id=${tenantId})) acc
    ) taken WHERE addr ~* ${pattern}
  `),
  );
  return rows.map((row) => row.addr);
}

/** 生成邮箱（EN-R12）：待入职且未取消才可生成；成功、失败、跳过、无规则都写审计。 */
export async function generateEntryEmailFor(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
): Promise<EmailGeneration> {
  const { record } = await lockPendingEntry(tx, ctx, recordId);
  if (record.entryStatus === ENTRY_STATUS.cancelled)
    throw new AppError('CONFLICT', '已取消入职，请先改期恢复', { reason: 'ENTRY_CANCELLED' });
  const { entryEmailRules } = await readEmailRules(tx, ctx.tenantId);
  const rules: EmailRuleFacts[] = entryEmailRules.map((rule) => ({ ...rule }));
  const departmentId = record.fields.departmentId;
  const chain = departmentId ? await orgChain(tx, ctx.tenantId, departmentId, record.effectiveDate) : [];
  const person = await personFacts(tx, ctx.tenantId, record.employeeId);
  const plan = planEntryEmail(rules, {
    kind: record.kind,
    orgChain: chain,
    employType: record.fields.employType ?? null,
    ...person,
  });
  const result: EmailGeneration =
    plan.status === 'plan'
      ? {
          status: 'generated',
          ruleId: plan.rule.id,
          ruleName: plan.rule.name,
          email: nextAvailableEmail(
            plan.prefix,
            plan.rule.domain,
            await takenEmails(tx, ctx.tenantId, plan.prefix, plan.rule.domain),
          ),
        }
      : plan;
  await auditEmployment(tx, ctx, 'employment.entry.email_generate', 'employment-business', recordId, null, {
    businessId: recordId,
    ...result,
  });
  return result;
}
