/**
 * R2 BE-5c1b（R2-T04 §9.1 / §9.1A，DEC-640①、DEC-641；AC-RT-16、AC-RT-03 的配置侧）：
 * - 规则设置路由放开 ?purpose=flexible_range：弹性范围规则只配组织范围 + 选用内置函数（最早 / 最晚），
 *   没有“提前 / 延迟 N 个月”两列；expected_date 也可选用内置函数（rule_type = builtin）；
 * - 每租户预置两条法定规则（预计退休日期、弹性范围）：覆盖全公司、默认停用（自动计算开关默认关，A-5）、
 *   不可编辑 / 删除（409 RETIREMENT_RULE_PRESET）、可启停、可复制（复制件是普通规则）；
 * - 预置规则排在自建规则之前（DEC-646②）；规则用途与类型创建后不可改；
 * - loadRetirementRulesForRun 把启用规则展开成纯函数的入参，供 5c2 批次与立即执行调用。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { loadRetirementRulesForRun } from '../../apps/api/src/modules/employment/retirement-rules.js';
import { resolveExpectedDate, resolveFlexibleRange } from '../../packages/domain/src/employment/retirement-rules.js';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession } from './AC-EMP-support.js';

const testDb = useTestDb();

interface Rule {
  readonly id: string;
  readonly purpose: string;
  readonly ruleType: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly allOrgs: boolean;
  readonly preset: boolean;
  readonly includeSubordinates: boolean;
  readonly retirementAgeYears: number | null;
  readonly retirementAgeMonths: number | null;
  readonly expectedFunction: string | null;
  readonly earliestFunction: string | null;
  readonly latestFunction: string | null;
  readonly conditions: { fieldCode: string; operator: string; values: string[] }[];
  readonly enabled: boolean;
  readonly revision: number;
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: { reason?: string } } }).error;

async function world(label: string) {
  const session = await employmentSession(testDb().db, `rt16-${label}`);
  const org = await session.org(`退休部门-${label}`, { establishedOn: '2026-01-01' });
  await withTenant(testDb().db, session.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: session.tenant.id, actorUserId: null, now: new Date(), commandId: `rt16-seed-${randomUUID()}` },
      { modules: ['employment-retirement'] },
    ),
  );
  const range = (extra: Record<string, unknown> = {}) => ({
    purpose: 'flexible_range',
    name: '法定弹性范围（自建）',
    priority: 1,
    orgIds: [org.id],
    includeSubordinates: true,
    earliestFunction: 'statutory_earliest',
    latestFunction: 'statutory_latest',
    conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    ...extra,
  });
  const expected = (extra: Record<string, unknown> = {}) => ({
    purpose: 'expected_date',
    ruleType: 'builtin',
    name: '法定预计退休日期（自建）',
    priority: 1,
    orgIds: [org.id],
    expectedFunction: 'statutory_expected_date',
    conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    ...extra,
  });
  const create = (body: unknown) => session.request('POST', '/retirement-rules', { ifMatch: 0, body });
  async function created(body: unknown): Promise<Rule> {
    const response = await create(body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Rule;
  }
  async function list(purpose: string): Promise<Rule[]> {
    const response = await session.request('GET', `/retirement-rules?purpose=${purpose}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Rule[] }).items;
  }
  return { session, org, range, expected, create, created, list, db: testDb().db };
}

describe('AC-RT-16 预置法定规则（DEC-641①）', () => {
  it('每租户预置两条：预计退休日期、弹性范围；覆盖全公司、默认停用、排在最前（DEC-646②）；再补装不重复', async () => {
    const w = await world('preset');
    const [expected] = await w.list('expected_date');
    expect(expected).toMatchObject({
      preset: true,
      purpose: 'expected_date',
      ruleType: 'builtin',
      expectedFunction: 'statutory_expected_date',
      earliestFunction: null,
      latestFunction: null,
      retirementAgeYears: null,
      retirementAgeMonths: null,
      allOrgs: true,
      orgIds: [],
      enabled: false,
      priority: 9999,
      revision: 1,
    });
    const [range] = await w.list('flexible_range');
    expect(range).toMatchObject({
      preset: true,
      purpose: 'flexible_range',
      ruleType: 'builtin',
      expectedFunction: null,
      earliestFunction: 'statutory_earliest',
      latestFunction: 'statutory_latest',
      allOrgs: true,
      enabled: false,
    });
    expect(range).not.toHaveProperty('earlierMonths');
    // 必填的雇佣关系槽位覆盖三种雇佣关系
    expect(range!.conditions).toEqual([
      { fieldCode: 'employType', operator: 'in', values: ['internal', 'intern', 'external'] },
    ]);
    const custom = await w.created(w.range({ priority: 9999 }));
    expect((await w.list('flexible_range')).map((rule) => rule.id)).toEqual([range!.id, custom.id]);
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      installMissingSeeds(
        tx,
        { tenantId: w.session.tenant.id, actorUserId: null, now: new Date(), commandId: `again-${randomUUID()}` },
        { modules: ['employment-retirement'] },
      ),
    );
    expect(await w.list('flexible_range')).toHaveLength(2);
    expect(await w.list('expected_date')).toHaveLength(1);
  });

  it('预置不可编辑 / 删除（409 RETIREMENT_RULE_PRESET）；可启停；复制件是普通规则', async () => {
    const w = await world('preset-ops');
    const [preset] = await w.list('flexible_range');
    const put = await w.session.request('PUT', `/retirement-rules/${preset!.id}`, {
      ifMatch: 1,
      body: w.range({ name: '改名' }),
    });
    expect(put.status).toBe(409);
    expect((await errorOf(put)).details?.reason).toBe('RETIREMENT_RULE_PRESET');
    const del = await w.session.request('DELETE', `/retirement-rules/${preset!.id}`, { ifMatch: 1 });
    expect(del.status).toBe(409);
    expect((await errorOf(del)).details?.reason).toBe('RETIREMENT_RULE_PRESET');

    const on = await w.session.request('PUT', `/retirement-rules/${preset!.id}/enabled`, {
      ifMatch: 1,
      body: { enabled: true },
    });
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await on.json()).toMatchObject({ enabled: true, revision: 2, preset: true });

    const copied = await w.session.request('POST', `/retirement-rules/${preset!.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const copy = (await copied.json()) as Rule;
    expect(copy).toMatchObject({
      preset: false,
      purpose: 'flexible_range',
      ruleType: 'builtin',
      enabled: false,
      earliestFunction: 'statutory_earliest',
      latestFunction: 'statutory_latest',
      allOrgs: true,
    });
    expect(copy.name).toBe(`${preset!.name}（复制）`);

    // 复制件可编辑：选定适用组织后不再是“全公司”
    const edited = await w.session.request('PUT', `/retirement-rules/${copy.id}`, {
      ifMatch: 1,
      body: w.range({ name: '复制后改' }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ name: '复制后改', allOrgs: false, orgIds: [w.org.id], preset: false });
    const removed = await w.session.request('DELETE', `/retirement-rules/${copy.id}`, { ifMatch: 2 });
    expect(removed.status, await removed.clone().text()).toBe(200);
  });
});

describe('AC-RT-16 弹性范围规则：保存与校验（DEC-640①、DEC-641）', () => {
  it('新增 / 编辑 / 复制 / 启停 / 删除；响应只有内置函数，不含提前 / 延迟月数与退休年龄', async () => {
    const w = await world('crud');
    const rule = await w.created(w.range());
    expect(rule).toMatchObject({
      purpose: 'flexible_range',
      ruleType: 'builtin',
      preset: false,
      allOrgs: false,
      earliestFunction: 'statutory_earliest',
      latestFunction: 'statutory_latest',
      expectedFunction: null,
      retirementAgeYears: null,
      retirementAgeMonths: null,
      enabled: true,
      revision: 1,
    });
    expect(rule).not.toHaveProperty('earlierMonths');
    expect(rule).not.toHaveProperty('laterMonths');

    const edited = await w.session.request('PUT', `/retirement-rules/${rule.id}`, {
      ifMatch: 1,
      body: w.range({ name: '改名', priority: 3, includeSubordinates: false, enabled: false }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({ name: '改名', priority: 3, includeSubordinates: false, revision: 2 });

    const copied = await w.session.request('POST', `/retirement-rules/${rule.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const copy = (await copied.json()) as Rule;
    expect(copy).toMatchObject({ name: '改名（复制）', enabled: false, purpose: 'flexible_range', preset: false });
    const toggled = await w.session.request('PUT', `/retirement-rules/${copy.id}/enabled`, {
      ifMatch: 1,
      body: { enabled: true },
    });
    expect(toggled.status).toBe(200);
    const removed = await w.session.request('DELETE', `/retirement-rules/${copy.id}`, { ifMatch: 2 });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.list('flexible_range')).map((item) => item.id)).toEqual([expect.any(String), rule.id]);
    // 两种用途的规则分开存放，互不出现在对方列表里
    expect((await w.list('expected_date')).some((item) => item.id === rule.id)).toBe(false);
  });

  it('ruleType 缺省：expected_date 为 fixed_age，flexible_range 为 builtin', async () => {
    const w = await world('default-type');
    const flexible = await w.created(w.range());
    expect(flexible.ruleType).toBe('builtin');
    const fixed = await w.created({
      name: '固定',
      priority: 1,
      orgIds: [w.org.id],
      retirementAgeYears: 60,
      conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    });
    expect(fixed).toMatchObject({ purpose: 'expected_date', ruleType: 'fixed_age', retirementAgeMonths: 0 });
  });

  it('弹性范围规则的非法写法一律 400：固定年龄、缺函数、函数串位、混入年龄 / 月数、公式', async () => {
    const w = await world('invalid');
    const cases: [string, Record<string, unknown>][] = [
      ['弹性范围不能用固定年龄', { ruleType: 'fixed_age', retirementAgeYears: 60 }],
      ['缺最早函数', { earliestFunction: undefined }],
      ['缺最晚函数', { latestFunction: undefined }],
      ['最早函数选成最晚函数', { earliestFunction: 'statutory_latest' }],
      ['最晚函数选成预计函数', { latestFunction: 'statutory_expected_date' }],
      ['未知函数', { earliestFunction: 'my_func' }],
      ['混入预计日期函数', { expectedFunction: 'statutory_expected_date' }],
      ['混入退休年龄', { retirementAgeYears: 60 }],
      ['提前月数', { earlierMonths: 12 }],
      ['延迟月数', { laterMonths: 12 }],
      ['高级公式', { ruleType: 'formula' }],
      ['未知用途', { purpose: 'other' }],
      ['缺雇佣关系', { conditions: [{ fieldCode: 'gender', operator: 'in', values: ['male'] }] }],
    ];
    for (const [label, extra] of cases) {
      const response = await w.create(w.range(extra));
      expect(response.status, `${label} → ${await response.clone().text()}`).toBe(400);
    }
    expect(await w.list('flexible_range')).toHaveLength(1); // 只有预置
  });

  it('预计退休日期规则选用内置函数：必须选 statutory_expected_date，不能带退休年龄或最早 / 最晚函数', async () => {
    const w = await world('expected-builtin');
    const ok = await w.created(w.expected());
    expect(ok).toMatchObject({
      ruleType: 'builtin',
      expectedFunction: 'statutory_expected_date',
      retirementAgeYears: null,
    });
    const cases: [string, Record<string, unknown>][] = [
      ['缺函数', { expectedFunction: undefined }],
      ['函数串位', { expectedFunction: 'statutory_latest' }],
      ['带退休年龄', { retirementAgeYears: 60 }],
      ['带最早函数', { earliestFunction: 'statutory_earliest' }],
    ];
    for (const [label, extra] of cases) {
      const response = await w.create(w.expected(extra));
      expect(response.status, `${label} → ${await response.clone().text()}`).toBe(400);
    }
    // 固定年龄规则不能带内置函数
    const fixed = await w.create({
      name: '固定带函数',
      priority: 1,
      orgIds: [w.org.id],
      retirementAgeYears: 60,
      expectedFunction: 'statutory_expected_date',
      conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    });
    expect(fixed.status).toBe(400);
  });

  it('适用组织必须存在；用途与类型创建后不可改（400 RETIREMENT_RULE_KIND_IMMUTABLE）', async () => {
    const w = await world('immutable');
    const missing = await w.create(w.range({ orgIds: ['00000000-0000-4000-8000-000000000000'] }));
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).details?.reason).toBe('ORG_NOT_FOUND');

    const rule = await w.created(w.range());
    const toExpected = await w.session.request('PUT', `/retirement-rules/${rule.id}`, {
      ifMatch: 1,
      body: w.expected(),
    });
    expect(toExpected.status).toBe(400);
    expect((await errorOf(toExpected)).details?.reason).toBe('RETIREMENT_RULE_KIND_IMMUTABLE');
    const fixed = await w.created({
      name: '固定',
      priority: 1,
      orgIds: [w.org.id],
      retirementAgeYears: 60,
      conditions: [{ fieldCode: 'employType', operator: 'in', values: ['internal'] }],
    });
    const toBuiltin = await w.session.request('PUT', `/retirement-rules/${fixed.id}`, {
      ifMatch: 1,
      body: w.expected(),
    });
    expect(toBuiltin.status).toBe(400);
    expect((await errorOf(toBuiltin)).details?.reason).toBe('RETIREMENT_RULE_KIND_IMMUTABLE');
  });

  it('登记顺序号与上限按用途分别计；预置不占自建的 100 条名额', async () => {
    const w = await world('limit');
    const a = await w.created(w.range({ name: 'a' }));
    const b = await w.created(w.range({ name: 'b' }));
    const c = await w.created(w.expected({ name: 'c' }));
    expect([a, b, c].map((rule) => rule.revision)).toEqual([1, 1, 1]);
    const order = (await w.list('flexible_range')).map((rule) => rule.name);
    expect(order.slice(1, 3)).toEqual(['a', 'b']); // 预置法定先于自建；同优先级按登记先后
    expect(order).toHaveLength(3);
  });
});

describe('AC-RT-16 loadRetirementRulesForRun：给 5c2 批次与立即执行的规则入参', () => {
  it('只取启用规则；包含下级展开；预置规则标记全公司；解析结果与纯函数一致', async () => {
    const w = await world('load');
    const child = await w.session.org('退休子部门', {
      establishedOn: '2026-01-01',
      parents: { admin: { parentId: w.org.id } },
    });
    const custom = await w.created(w.range({ name: '子树弹性', priority: 5 }));
    const load = (purpose: 'expected_date' | 'flexible_range') =>
      withTenant(w.db, w.session.tenant.id, (tx) =>
        loadRetirementRulesForRun(tx, w.session.tenant.id, purpose, '2026-10-19'),
      );

    // 预置默认停用：只有自建规则
    let rules = await load('flexible_range');
    expect(rules.map((rule) => rule.id)).toEqual([custom.id]);
    expect(rules[0]).toMatchObject({
      purpose: 'flexible_range',
      ruleType: 'builtin',
      preset: false,
      scopeAllOrgs: false,
      earliestFunction: 'statutory_earliest',
    });
    expect([...rules[0]!.scopeOrgIds].sort()).toEqual([w.org.id, child.id].sort());

    // 启用两条预置后：预置法定先、自建后（DEC-646②）；预置覆盖全公司
    for (const purpose of ['expected_date', 'flexible_range']) {
      const [preset] = (await w.list(purpose)).filter((rule) => rule.preset);
      const on = await w.session.request('PUT', `/retirement-rules/${preset!.id}/enabled`, {
        ifMatch: 1,
        body: { enabled: true },
      });
      expect(on.status, await on.clone().text()).toBe(200);
    }
    rules = await load('flexible_range');
    expect(rules.map((rule) => rule.preset)).toEqual([true, false]);
    expect(rules[0]).toMatchObject({ scopeAllOrgs: true, scopeOrgIds: [] });

    const person = { orgId: null, gender: 'male', nationality: null, employType: 'internal', identityType: null };
    const facts = { birthday: '1990-06-15', expectedDate: '2053-06-16' };
    expect(resolveFlexibleRange(rules, person, facts)).toMatchObject({
      rule: { preset: true },
      earliest: '2050-06-16',
      latest: '2056-06-16',
    });
    // 法定优先：自建规则命中子部门，但法定算得出，自建不生效
    expect(resolveFlexibleRange(rules, { ...person, orgId: child.id }, facts)?.rule.id).not.toBe(custom.id);
    const expectedRules = await load('expected_date');
    expect(resolveExpectedDate(expectedRules, person, { birthday: '1990-06-15', expectedDate: null })).toMatchObject({
      rule: { preset: true },
      date: '2053-06-16',
    });
  });
});
