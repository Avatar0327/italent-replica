import { onboardingIntegrationSettings, eq, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { SQL } from 'drizzle-orm';
import { rowsOf } from '../employment/record-store.js';
import type { ModuleScope } from '../permission/module-access.js';
import { schemeMissing, schemeScopeSql } from './integration-schemes-access.js';
import type { IntegrationMatchFacts, SchemeInput } from './integration-schemes-input.js';

export const INTEGRATION_SCHEME_AUDIT = 'onboarding-integration-scheme';

export type SchemeView = SchemeInput & { id: string; revision: number };

const schemeOrgs = sql`onboarding_integration_scope_orgs o WHERE o.tenant_id = s.tenant_id AND o.scheme_id = s.id`;

const array = (query: SQL) => sql`COALESCE((${query}), '[]'::jsonb)`;
const orgIds = array(sql`SELECT jsonb_agg(o.org_id ORDER BY o.org_id) FROM ${schemeOrgs}`);
const visible = (scope: ModuleScope) => schemeScopeSql(scope, sql`(SELECT o.org_id FROM ${schemeOrgs})`);

const timing = (alias: string, name: 'start' | 'due') => {
  const col = (part: string) => sql`${sql.identifier(alias)}.${sql.identifier(`${name}_${part}`)}`;
  return sql`jsonb_build_object('unit', ${col('unit')}, 'ordinal', ${col('ordinal')})`;
};
const tasks = array(sql`
  SELECT jsonb_agg(jsonb_build_object(
    'id', t.id, 'poolTaskId', t.pool_task_id, 'employeeVisible', t.employee_visible,
    'start', ${timing('t', 'start')}, 'due', ${timing('t', 'due')},
    'assignee', jsonb_strip_nulls(jsonb_build_object('type', t.assignee_type, 'role', t.assignee_role,
      'id', COALESCE(t.assignee_user_id, t.assignee_position_id, t.assignee_post_id, t.assignee_profile_id))),
    'reminder', jsonb_strip_nulls(jsonb_build_object(
      'mode', CASE WHEN t.reminder_days IS NULL THEN 'inherit' WHEN t.reminder_days = 0 THEN 'off' ELSE 'on' END,
      'days', NULLIF(t.reminder_days, 0)))
  ) ORDER BY t.sequence, t.id)
  FROM onboarding_integration_stage_tasks t WHERE t.tenant_id = g.tenant_id AND t.stage_id = g.id`);
const stages = array(sql`
  SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'tasks', ${tasks},
    'start', ${timing('g', 'start')}, 'due', ${timing('g', 'due')}) ORDER BY g.sequence, g.id)
  FROM onboarding_integration_stages g WHERE g.tenant_id = s.tenant_id AND g.scheme_id = s.id`);

const dto = sql`s.id, s.name, s.priority, s.description, s.conditions, s.revision,
  s.failure_recipient_id AS "failureRecipientId", ${orgIds} AS "orgIds",
  jsonb_strip_nulls(jsonb_build_object(
    'mode', CASE WHEN s.reminder_days IS NULL THEN 'off' ELSE 'on' END, 'days', s.reminder_days)) AS reminder`;

export async function listSchemes(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope,
  page: { limit: number; offset: number },
) {
  type Summary = Omit<SchemeView, 'stages'>;
  return rowsOf<Summary>(
    await tx.execute(sql`
    SELECT ${dto} FROM onboarding_integration_schemes s
    WHERE s.tenant_id = ${tenantId} AND ${visible(scope)}
    ORDER BY s.priority, s.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}

export async function readScheme(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope,
  id: string,
  lock = false,
): Promise<SchemeView> {
  // 聚合编辑先锁头，再用新语句重读子项，以免等待锁期间子项仍停留在旧快照。
  if (lock) {
    const locked = rowsOf<{ id: string }>(
      await tx.execute(sql`
      SELECT s.id FROM onboarding_integration_schemes s WHERE s.tenant_id = ${tenantId}
        AND s.id = ${id} AND ${visible(scope)} FOR UPDATE`),
    );
    if (!locked.length) throw schemeMissing();
  }
  const [scheme] = rowsOf<SchemeView>(
    await tx.execute(sql`
    SELECT ${dto}, ${stages} AS stages FROM onboarding_integration_schemes s
    WHERE s.tenant_id = ${tenantId} AND s.id = ${id} AND ${visible(scope)}`),
  );
  if (!scheme) throw schemeMissing();
  return scheme;
}

/** R2-T01 §7.1。只接受可信任职事实；调用方负责员工及周期授权。 */
export async function matchIntegrationScheme(tx: Tx, tenantId: string, facts: IntegrationMatchFacts) {
  const { orgId, ...conditions } = facts;
  const match = rowsOf<SchemeView>(
    await tx.execute(sql`
    SELECT ${dto}, ${stages} AS stages FROM onboarding_integration_schemes s
    WHERE s.tenant_id = ${tenantId} AND EXISTS (SELECT 1 FROM ${schemeOrgs} AND o.org_id = ${orgId})
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_each(s.conditions) c(key, options)
        WHERE NOT COALESCE(c.options ? (${JSON.stringify(conditions)}::jsonb ->> c.key), false)
      )
    ORDER BY s.priority, s.id LIMIT 2`),
  );
  if (match[0] && match[1]?.priority === match[0].priority) {
    throw new AppError('CONFLICT', '同优先级有多个融入方案命中', { reason: 'INTEGRATION_SCHEME_AMBIGUOUS' });
  }
  return match[0] ?? null;
}

/** 设置缺行沿用默认关闭。开关管理与触发随 16b-4 一并装配。 */
export async function integrationAutoStartEnabled(tx: Tx, tenantId: string) {
  const [settings] = await tx
    .select({ enabled: onboardingIntegrationSettings.autoStart })
    .from(onboardingIntegrationSettings)
    .where(eq(onboardingIntegrationSettings.tenantId, tenantId));
  return settings?.enabled ?? false;
}
