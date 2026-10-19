/**
 * R2 BE-5c1a（R2-T04 §9.1 / §12.1，DEC-640、DEC-638 A-4 / A-9 / A-20、DEC-636 c4；AC-RT-03 / 15 的配置侧）：
 * - 预计退休日期规则（purpose = expected_date，rule_type = fixed_age）的增删改查、复制、单条启停；
 *   条件只有性别、国籍、雇佣关系（必填）、个人身份四个固定槽位，操作符只有 in；没有“提前 / 延迟 N 月”两列；
 * - 个人身份字典预置工人 = 10、干部 = 20，只读（无 POST / PUT）；规则条件与人事 identityType 只能取启用编码；
 * - 三个租户配置项 retirement.auto_expected_date / auto_flexible_range / upcoming_days。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession } from './AC-EMP-support.js';
import { personnelSession } from './AC-SUB-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

interface Rule {
  readonly id: string;
  readonly purpose: string;
  readonly ruleType: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly includeSubordinates: boolean;
  readonly retirementAgeYears: number;
  readonly retirementAgeMonths: number;
  readonly conditions: { fieldCode: string; operator: string; values: string[] }[];
  readonly enabled: boolean;
  readonly revision: number;
}

/** 字典没有修改接口（DEC-640③），停用只能以表属主身份直接写库来造数。 */
function disableIdentityType(db: ReturnType<typeof testDb>['db'], tenantId: string, code: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql`UPDATE retirement_identity_types SET enabled = false WHERE tenant_id = ${tenantId}
      AND code = ${code}`);
  });
}

async function installRetirementSeeds(db: ReturnType<typeof testDb>['db'], tenantId: string) {
  await withTenant(db, tenantId, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId, actorUserId: null, now: new Date(), commandId: `rt-seed-${randomUUID()}` },
      { modules: ['employment-retirement'] },
    ),
  );
}

async function world(label: string) {
  const session = await employmentSession(testDb().db, `rt-${label}`);
  const org = await session.org(`退休部门-${label}`, { establishedOn: '2026-01-01' });
  await installRetirementSeeds(testDb().db, session.tenant.id);
  const body = (extra: Record<string, unknown> = {}) => ({
    name: '干部男性 60 岁退休',
    priority: 1,
    orgIds: [org.id],
    includeSubordinates: true,
    retirementAgeYears: 60,
    retirementAgeMonths: 0,
    conditions: [
      { fieldCode: 'employType', operator: 'in', values: ['internal'] },
      { fieldCode: 'gender', operator: 'in', values: ['male'] },
    ],
    ...extra,
  });
  const create = (value: unknown, ifMatch = 0) =>
    session.request('POST', '/retirement-rules', { ifMatch, body: value });
  async function created(value: unknown): Promise<Rule> {
    const response = await create(value);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Rule;
  }
  async function list(query = ''): Promise<Rule[]> {
    const response = await session.request('GET', `/retirement-rules${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: Rule[] }).items;
  }
  return { session, org, body, create, created, list, db: testDb().db };
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;

describe('AC-RT-15 个人身份字典（DEC-640③，只读）', () => {
  it('新租户预置 工人 = 10、干部 = 20（标准项，启用，按 display_order 1 / 2），再补装不重复', async () => {
    const w = await world('dict');
    const response = await w.session.request('GET', '/retirement-identity-types');
    expect(response.status, await response.clone().text()).toBe(200);
    const items = ((await response.json()) as { items: Record<string, unknown>[] }).items;
    expect(items).toMatchObject([
      { code: '10', name: '工人', enabled: true, displayOrder: 1 },
      { code: '20', name: '干部', enabled: true, displayOrder: 2 },
    ]);
    await installRetirementSeeds(w.db, w.session.tenant.id);
    const again = await w.session.request('GET', '/retirement-identity-types');
    expect(((await again.json()) as { items: unknown[] }).items).toHaveLength(2);
  });

  it('不提供新增与修改：POST / PUT 路径不存在', async () => {
    const w = await world('dict-ro');
    const [first] = (
      (await (await w.session.request('GET', '/retirement-identity-types')).json()) as {
        items: { id: string }[];
      }
    ).items;
    const post = await w.session.request('POST', '/retirement-identity-types', {
      ifMatch: 0,
      body: { code: '30', name: '新增' },
    });
    expect(post.status).toBe(404);
    const put = await w.session.request('PUT', `/retirement-identity-types/${first!.id}`, {
      ifMatch: 1,
      body: { name: '改名' },
    });
    expect(put.status).toBe(404);
  });

  it('读取要任职对象查看权', async () => {
    const w = await world('dict-403');
    const denied = tenantApi(w.db, { authorize: (request) => request.action !== 'object.view' });
    const response = await denied.request('GET', '/api/tenant/employment/retirement-identity-types', {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
    });
    expect(response.status).toBe(403);
  });
});

describe('AC-RT-15 三个租户配置项（DEC-638 A-5）', () => {
  const as = async (w: Awaited<ReturnType<typeof world>>) => ({
    api: tenantApi(w.db),
    as: { tenant: w.session.tenant.id, user: w.session.user.id },
  });

  it('出厂值：自动计算预计日期关、自动计算弹性范围关、即将退休天数 30', async () => {
    const w = await world('settings');
    const { api, as: who } = await as(w);
    for (const [key, value] of [
      ['retirement.auto_expected_date', false],
      ['retirement.auto_flexible_range', false],
      ['retirement.upcoming_days', 30],
    ] as const) {
      const response = await api.request('GET', `/api/tenant/settings/${key}`, who);
      expect(response.status, `${key} → ${await response.clone().text()}`).toBe(200);
      expect(await response.json()).toMatchObject({ key, value });
    }
  });

  it('取值校验：开关只收布尔；天数收 1～365 的整数；合法值可保存', async () => {
    const w = await world('settings-put');
    const { api, as: who } = await as(w);
    const put = async (key: string, value: unknown) => {
      const current = await api.request('GET', `/api/tenant/settings/${key}`, who);
      const { revision } = (await current.json()) as { revision: number };
      return api.request('PUT', `/api/tenant/settings/${key}`, { ...who, ifMatch: revision, body: { value } });
    };
    for (const value of ['true', 1, null]) expect((await put('retirement.auto_expected_date', value)).status).toBe(400);
    for (const value of ['yes', 0]) expect((await put('retirement.auto_flexible_range', value)).status).toBe(400);
    for (const value of [0, 366, 1.5, '30', true])
      expect((await put('retirement.upcoming_days', value)).status).toBe(400);
    expect((await put('retirement.auto_expected_date', true)).status).toBe(200);
    expect((await put('retirement.upcoming_days', 365)).status).toBe(200);
    const read = await api.request('GET', '/api/tenant/settings/retirement.upcoming_days', who);
    expect(await read.json()).toMatchObject({ value: 365 });
  });
});

describe('AC-RT-15 预计退休日期规则：保存与校验（DEC-640①②）', () => {
  it('新增：默认 purpose = expected_date、rule_type = fixed_age；条件落固定槽位；响应不含提前 / 延迟月数', async () => {
    const w = await world('create');
    const rule = await w.created(w.body());
    expect(rule).toMatchObject({
      purpose: 'expected_date',
      ruleType: 'fixed_age',
      name: '干部男性 60 岁退休',
      priority: 1,
      includeSubordinates: true,
      retirementAgeYears: 60,
      retirementAgeMonths: 0,
      conditions: [
        { fieldCode: 'gender', operator: 'in', values: ['male'] },
        { fieldCode: 'employType', operator: 'in', values: ['internal'] },
      ],
      enabled: true,
      revision: 1,
    });
    expect(rule).not.toHaveProperty('earlierMonths');
    expect(rule).not.toHaveProperty('laterMonths');
    expect(await w.list()).toHaveLength(1);
    expect(await w.list('?purpose=expected_date')).toHaveLength(1);
  });

  it('弹性范围规则与高级公式本单不开放：purpose = flexible_range、rule_type = formula、提前 / 延迟月数均 400', async () => {
    const w = await world('closed');
    for (const extra of [
      { purpose: 'flexible_range' },
      { ruleType: 'formula' },
      { earlierMonths: 12 },
      { laterMonths: 12 },
    ]) {
      const response = await w.create(w.body(extra));
      expect(response.status, `${JSON.stringify(extra)} → ${await response.clone().text()}`).toBe(400);
    }
    const query = await w.session.request('GET', '/retirement-rules?purpose=flexible_range');
    expect(query.status).toBe(400);
    expect(await w.list()).toEqual([]);
  });

  it('退休年龄 30～80 岁、月数 0～11；名称、优先级、适用组织必填且受限', async () => {
    const w = await world('range');
    for (const extra of [
      { retirementAgeYears: 29 },
      { retirementAgeYears: 81 },
      { retirementAgeYears: 60.5 },
      { retirementAgeYears: undefined },
      { retirementAgeMonths: 12 },
      { retirementAgeMonths: -1 },
      { name: '' },
      { name: '   ' },
      { priority: -1 },
      { priority: 10000 },
      { orgIds: [] },
      { orgIds: ['not-a-uuid'] },
    ]) {
      const response = await w.create(w.body(extra));
      expect(response.status, `${JSON.stringify(extra)} → ${await response.clone().text()}`).toBe(400);
    }
    const boundary = await w.created(w.body({ name: '边界', retirementAgeYears: 80, retirementAgeMonths: 11 }));
    expect(boundary).toMatchObject({ retirementAgeYears: 80, retirementAgeMonths: 11 });
    await w.created(w.body({ name: '下界', retirementAgeYears: 30, retirementAgeMonths: 0 }));
  });

  it('适用组织必须存在', async () => {
    const w = await world('org');
    const response = await w.create(w.body({ orgIds: ['00000000-0000-4000-8000-000000000000'] }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).details?.reason).toBe('ORG_NOT_FOUND');
  });

  it('条件：雇佣关系槽位必填；只开放四个槽位；操作符只有 in；每槽至多一条', async () => {
    const w = await world('conditions');
    const only = (conditions: unknown) => w.body({ conditions });
    const cases: [string, unknown][] = [
      ['缺雇佣关系', [{ fieldCode: 'gender', operator: 'in', values: ['male'] }]],
      ['无条件', []],
      ['雇佣关系值为空', [{ fieldCode: 'employType', operator: 'in', values: [] }]],
      ['not_in 不开放', [{ fieldCode: 'employType', operator: 'not_in', values: ['internal'] }]],
      ['is_empty 不开放', [{ fieldCode: 'employType', operator: 'is_empty', values: [] }]],
      [
        '未知槽位（用工形式 / 人员类别未实现）',
        [
          { fieldCode: 'employType', operator: 'in', values: ['internal'] },
          { fieldCode: 'employmentForm', operator: 'in', values: ['a'] },
        ],
      ],
      [
        '同槽位两条',
        [
          { fieldCode: 'employType', operator: 'in', values: ['internal'] },
          { fieldCode: 'employType', operator: 'in', values: ['intern'] },
        ],
      ],
      ['雇佣关系取值不在内部员工 / 实习生 / 外部', [{ fieldCode: 'employType', operator: 'in', values: ['staff'] }]],
      ['值重复', [{ fieldCode: 'employType', operator: 'in', values: ['internal', 'internal'] }]],
      ['缺 operator', [{ fieldCode: 'employType', values: ['internal'] }]],
    ];
    for (const [label, conditions] of cases) {
      const response = await w.create(only(conditions));
      expect(response.status, `${label} → ${await response.clone().text()}`).toBe(400);
    }
    expect(await w.list()).toEqual([]);
    const full = await w.created(
      only([
        { fieldCode: 'identityType', operator: 'in', values: ['10', '20'] },
        { fieldCode: 'nationality', operator: 'in', values: ['CN'] },
        { fieldCode: 'gender', operator: 'in', values: ['male', 'female'] },
        { fieldCode: 'employType', operator: 'in', values: ['internal', 'intern', 'external'] },
      ]),
    );
    // 条件按固定槽位顺序返回（性别、国籍、雇佣关系、个人身份）
    expect(full.conditions.map((condition) => condition.fieldCode)).toEqual([
      'gender',
      'nationality',
      'employType',
      'identityType',
    ]);
  });

  it('个人身份条件只能选字典启用编码（A-9）：未知编码、已停用编码 400', async () => {
    const w = await world('identity');
    const identity = (values: string[]) =>
      w.body({
        conditions: [
          { fieldCode: 'employType', operator: 'in', values: ['internal'] },
          { fieldCode: 'identityType', operator: 'in', values: values },
        ],
      });
    const unknown = await w.create(identity(['99']));
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).details?.reason).toBe('RETIREMENT_IDENTITY_TYPE_UNKNOWN');
    await w.created(identity(['10', '20']));
    await disableIdentityType(w.db, w.session.tenant.id, '20');
    const disabled = await w.create(identity(['10', '20']));
    expect(disabled.status).toBe(400);
    expect((await errorOf(disabled)).details?.reason).toBe('RETIREMENT_IDENTITY_TYPE_DISABLED');
    await w.created(identity(['10']));
  });
});

describe('AC-RT-15 预计退休日期规则：行操作与审计', () => {
  it('编辑整份替换条件；复制默认停用；启停；删除连带条件；列表按优先级再登记序号', async () => {
    const w = await world('crud');
    const later = await w.created(w.body({ name: '后', priority: 5 }));
    const first = await w.created(w.body({ name: '先', priority: 1 }));
    const tie = await w.created(w.body({ name: '同优先级后登记', priority: 1 }));
    expect((await w.list()).map((rule) => rule.name)).toEqual(['先', '同优先级后登记', '后']);

    const edited = await w.session.request('PUT', `/retirement-rules/${later.id}`, {
      ifMatch: 1,
      body: w.body({
        name: '后（改）',
        priority: 0,
        includeSubordinates: false,
        retirementAgeYears: 55,
        retirementAgeMonths: 6,
        conditions: [{ fieldCode: 'employType', operator: 'in', values: ['intern'] }],
      }),
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(await edited.json()).toMatchObject({
      name: '后（改）',
      priority: 0,
      includeSubordinates: false,
      retirementAgeYears: 55,
      retirementAgeMonths: 6,
      conditions: [{ fieldCode: 'employType', operator: 'in', values: ['intern'] }],
      revision: 2,
    });
    expect(
      (await w.session.request('PUT', `/retirement-rules/${later.id}`, { ifMatch: 1, body: w.body() })).status,
    ).toBe(409);
    expect(
      (await w.session.request('PUT', `/retirement-rules/${randomUUID()}`, { ifMatch: 1, body: w.body() })).status,
    ).toBe(404);

    const copied = await w.session.request('POST', `/retirement-rules/${first.id}/copy`, { ifMatch: 0 });
    expect(copied.status, await copied.clone().text()).toBe(201);
    const copy = (await copied.json()) as Rule;
    expect(copy).toMatchObject({ name: '先（复制）', enabled: false, revision: 1, priority: 1 });
    expect(copy.conditions).toEqual(first.conditions);
    expect(copy.id).not.toBe(first.id);

    const disabled = await w.session.request('PUT', `/retirement-rules/${first.id}/enabled`, {
      ifMatch: 1,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect(await disabled.json()).toMatchObject({ enabled: false, revision: 2 });
    expect(
      (await w.session.request('PUT', `/retirement-rules/${first.id}/enabled`, { ifMatch: 1, body: { enabled: true } }))
        .status,
    ).toBe(409);
    expect(
      (await w.session.request('PUT', `/retirement-rules/${first.id}/enabled`, { ifMatch: 2, body: { enabled: 'on' } }))
        .status,
    ).toBe(400);

    expect((await w.session.request('DELETE', `/retirement-rules/${copy.id}`, { ifMatch: 9 })).status).toBe(409);
    const removed = await w.session.request('DELETE', `/retirement-rules/${copy.id}`, { ifMatch: 1 });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.session.request('DELETE', `/retirement-rules/${copy.id}`, { ifMatch: 1 })).status).toBe(404);
    expect((await w.list()).map((rule) => rule.id)).toEqual([later.id, first.id, tie.id]);

    const leftovers = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM retirement_rule_conditions
          WHERE tenant_id = ${w.session.tenant.id} AND rule_id = ${copy.id}::uuid`),
      ),
    );
    expect(leftovers[0]!.n).toBe(0);

    const audits = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rows<{ action: string }>(
        await tx.execute(sql`SELECT action FROM audit_events WHERE tenant_id = ${w.session.tenant.id}
          AND object_type = 'retirement_rule' ORDER BY occurred_at, action`),
      ),
    );
    expect(audits.map((a) => a.action).sort()).toEqual(
      [
        'retirement_rule.save', // 新增 ×3
        'retirement_rule.save',
        'retirement_rule.save',
        'retirement_rule.save', // 编辑
        'retirement_rule.save', // 复制
        'retirement_rule.enabled',
        'retirement_rule.delete',
      ].sort(),
    );
  });

  it('规则上限 100 条', async () => {
    const w = await world('limit');
    await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO retirement_rules(id, tenant_id, purpose, rule_type, name, priority, sequence_no,
          org_ids, include_subordinates, retirement_age_years, retirement_age_months, enabled)
        SELECT gen_random_uuid(), ${w.session.tenant.id}, 'expected_date', 'fixed_age', 'r' || n, 1, n,
          ARRAY[${w.org.id}]::uuid[], true, 60, 0, true FROM generate_series(1, 100) n`),
    );
    const response = await w.create(w.body());
    expect(response.status).toBe(409);
    expect((await errorOf(response)).details?.reason).toBe('RETIREMENT_RULE_LIMIT_REACHED');
  });

  it('写入要任职设置配置写权限，读取要对象查看权：无权 403 且不写入', async () => {
    const w = await world('403');
    const rule = await w.created(w.body());
    const denyWrite = tenantApi(w.db, {
      authorize: (request) => request.action !== 'tenant.employment.configuration.write',
    });
    const who = { user: w.session.user.id, tenant: w.session.tenant.id };
    const base = '/api/tenant/employment/retirement-rules';
    for (const [method, path, body] of [
      ['POST', base, w.body({ name: '越权' })],
      ['PUT', `${base}/${rule.id}`, w.body({ name: '越权改' })],
      ['PUT', `${base}/${rule.id}/enabled`, { enabled: false }],
      ['POST', `${base}/${rule.id}/copy`, undefined],
      ['DELETE', `${base}/${rule.id}`, undefined],
    ] as const) {
      const ifMatch = method === 'POST' && !path.endsWith('copy') ? 0 : 1;
      const response = await denyWrite.request(method, path, { ...who, ifMatch, body });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(await w.list()).toMatchObject([{ name: '干部男性 60 岁退休', revision: 1 }]);
    const denyRead = tenantApi(w.db, { authorize: (request) => request.action !== 'object.view' });
    expect((await denyRead.request('GET', base, who)).status).toBe(403);
  });
});

describe('AC-RT-15 人事“个人身份”只能取字典启用编码（A-9）', () => {
  it('PATCH identityType：启用编码可存、可清空；未知或停用编码 400 且不产生新版本', async () => {
    const s = await personnelSession(testDb().db, 'rt-identity');
    await installRetirementSeeds(testDb().db, s.tenant.id);
    const path = `/employees/${s.employee.id}`;
    const ok = await s.request('PATCH', path, { ifMatch: 0, body: { identityType: '10' } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ identityType: '10', revision: 1 });
    const unknown = await s.request('PATCH', path, { ifMatch: 1, body: { identityType: '99' } });
    expect(unknown.status).toBe(400);
    expect((await errorOf(unknown)).details?.reason).toBe('RETIREMENT_IDENTITY_TYPE_UNKNOWN');
    await disableIdentityType(testDb().db, s.tenant.id, '20');
    const disabled = await s.request('PATCH', path, { ifMatch: 1, body: { identityType: '20' } });
    expect(disabled.status).toBe(400);
    expect((await errorOf(disabled)).details?.reason).toBe('RETIREMENT_IDENTITY_TYPE_DISABLED');
    const cleared = await s.request('PATCH', path, { ifMatch: 1, body: { identityType: null } });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await cleared.json()).toMatchObject({ identityType: null, revision: 2 });
  });
});
