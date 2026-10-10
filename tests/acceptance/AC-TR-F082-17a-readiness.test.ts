/**
 * F-082 AC-17a 裁剪先于改绑（R2-P2-1，F082-5）：改绑命令开始前确认计算规则审计的来源裁剪 calcRuleSources 已登记，
 * 否则 503 AUDIT_REDACTOR_MISSING，不写任何数据（无规范文本、无引用、无审计）；登记后同一租户改绑成功，
 * 且改绑审计对没有字段目录访问的查看人已裁剪（不含字段名称、字段 ID、句柄），有访问的查看人看到写入时刻的名称。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { TALENT_REVIEW_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as SourceRegistry from '../../apps/api/src/audit/source-registry.js';
import { auditApi } from './AC-AUD-support.js';
import { BASE, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { CALC_RULES, calcBody, calcItem, calcRuleOperator, type CalcRuleView } from './AC-TR-calc-rule-support.js';
import { configBody, TR_BASE, TR_NOW } from './AC-TR-config-support.js';
import { REBIND_ACTION, rows } from './AC-TR-F082-rebind-support.js';
import { errorOf } from './AC-TR-F082-support.js';
import { PLATFORM, seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

// 把“calcRuleSources 已登记”做成可切换的探针（其余登记照常）
const registry = vi.hoisted(() => ({ calcRuleRegistered: true }));
vi.mock('../../apps/api/src/audit/source-registry.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof SourceRegistry;
  const { TALENT_REVIEW_OBJECTS: objects } = await import('@italent/domain');
  return {
    ...actual,
    auditSourceRegistered: (objectType: string) =>
      actual.auditSourceRegistered(objectType) && (registry.calcRuleRegistered || objectType !== objects.calcRule.code),
  };
});

const testDb = useTestDb();
const clock = () => TR_NOW;
const RULE = TALENT_REVIEW_OBJECTS.calcRule;
const PLACEHOLDER = '〔不可见字段〕';

describe('AC-17a 裁剪先于改绑', () => {
  let world: PermissionWorld;
  let off: ReturnType<typeof tenantApi>;
  let on: ReturnType<typeof tenantApi>;
  let operator: { id: string };

  const adminRequest = (api: typeof off, method: string, path: string, options: Record<string, unknown> = {}) =>
    api.request(method, `${TR_BASE}${path}`, { ...world.asAdmin, ...options });
  const field = async (name: string) => {
    const response = await adminRequest(off, 'POST', '/fields', {
      ifMatch: 0,
      body: configBody('field', { kind: 'number', group: 'result', name }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; name: string };
  };
  const rebind = (key = randomUUID()) =>
    on.request('POST', `${PLATFORM}/tenants/${world.tenant.id}/talent-review/calc-formulas/rebind`, {
      user: operator.id,
      body: {},
      idempotencyKey: key,
    });
  async function makeAuditor(userId: string) {
    const response = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId, role: 'audit_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  async function auditText(as: { user: string; tenant: string }, ruleId: string) {
    // 平台命令的审计按数据库时间写入（不受测试时钟控制），查询时钟取当前
    const audit = auditApi(testDb().db, new Date().toISOString(), { authorize: undefined });
    const list = await audit.dataChanges(as, { objectType: RULE.code, limit: '100' });
    const mine = list.items.filter((item) => item.objectId === ruleId && item.action === REBIND_ACTION);
    const details = [];
    for (const item of mine) details.push(await audit.dataChange(as, item.id));
    return { count: mine.length, text: JSON.stringify([mine, details]) };
  }
  const state = async () => {
    const found = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT
        (SELECT count(*)::int FROM talent_review_calc_rule_items WHERE formula_binding = 'bound') AS bound,
        (SELECT count(*)::int FROM talent_review_calc_item_refs) AS refs,
        (SELECT count(*)::int FROM audit_events WHERE action = ${REBIND_ACTION}) AS audits`),
    );
    return rows<{ bound: number; refs: number; audits: number }>(found)[0]!;
  };

  beforeAll(async () => {
    const db = testDb().db;
    world = await seedPermissionWorld(db);
    world = { ...world, api: tenantApi(db, { authorize: undefined, clock, formulaIdBinding: true }) };
    off = tenantApi(db, { clock, formulaIdBinding: false });
    on = tenantApi(db, { clock, formulaIdBinding: true });
    operator = await seedOperator(db, 'ac17a');
  });

  it('calcRuleSources 未登记 → 503 AUDIT_REDACTOR_MISSING，不写任何数据；登记后同一租户改绑成功且审计已裁剪', async () => {
    const [target, source] = [await field('改绑目标'), await field('改绑来源')];
    const created = await adminRequest(off, 'POST', CALC_RULES, {
      ifMatch: 0,
      body: calcBody([calcItem(target, '盘点对象.改绑来源 + 1')]),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const rule = (await created.json()) as CalcRuleView;
    const before = await state();

    registry.calcRuleRegistered = false;
    const refused = await rebind();
    expect(refused.status).toBe(503);
    const refusal = await errorOf(refused);
    expect([refusal.code, refusal.details['reason']]).toEqual(['SERVICE_UNAVAILABLE', 'AUDIT_REDACTOR_MISSING']);
    expect(await state()).toEqual(before);

    registry.calcRuleRegistered = true;
    expect((await rebind()).status).toBe(200);
    const after = await state();
    expect(after).toMatchObject({ bound: before.bound + 1, audits: before.audits + 1 });

    // 改绑审计对查看人当前权限裁剪：有字段目录访问的看到写入时刻的名称，没有访问的只有占位符
    const seeing = await calcRuleOperator(world, { seeAll: true, fields: 'seeAll' });
    await makeAuditor(seeing.user.id);
    const visible = await auditText(seeing.as, rule.id);
    expect(visible.count).toBe(1);
    expect(visible.text).toContain('盘点对象.改绑来源 + 1');
    expect(visible.text).not.toContain('@{tr-field:');

    const blind = await calcRuleOperator(world, { seeAll: true, fields: 'none' });
    await makeAuditor(blind.user.id);
    const hidden = await auditText(blind.as, rule.id);
    expect(hidden.count).toBe(1);
    for (const secret of ['改绑来源', source.id, '@{tr-field:']) expect(hidden.text, secret).not.toContain(secret);
    expect(hidden.text).toContain(PLACEHOLDER);
  });
});
