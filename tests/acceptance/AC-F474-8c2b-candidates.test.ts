/**
 * F-474-8c-2b 候选读取（AC-INS-03 / 04 / 09 / 10 读侧；设计 §4.1）：缴交地逐级下钻、方案候选、公司候选。
 * 真实授权器 + 真实 HTTP；方案 / 公司由夹具以属主身份写（方案对运行时角色只读）。
 */
import { grantMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { insuranceReadWorld } from './support/insurance-read.js';
import { seedInsuranceWorld } from './support/insurance-tables.js';
import { cmd } from './support/tenant-api.js';

const testDb = useTestDb();
const REGIONS = '/api/tenant/insurance/regions';
const PLANS = '/api/tenant/insurance/plans';
const COMPANIES = '/api/tenant/insurance/companies';
type Item = Record<string, unknown>;
const items = async (res: Response) => ((await res.json()) as { items: Item[] }).items;

describe('AC-INS-03 缴交地逐级下钻', () => {
  let c: Awaited<ReturnType<Awaited<ReturnType<typeof insuranceReadWorld>>['caller']>>;
  let r: Awaited<ReturnType<typeof insuranceReadWorld>>;
  beforeAll(async () => {
    r = await insuranceReadWorld(testDb().db, 'ins-regions');
    c = await r.caller({ profile: false, plan: false, company: false, employment: false, seeAll: false });
  });

  it('省 → 市 → 区县；直辖市的区县直接挂在省级编码下；按编码排序，条目只含 编码 / 父级 / 层级 / 名称', async () => {
    const provinces = await items(await c.get(REGIONS));
    expect(provinces.length).toBeGreaterThan(30);
    expect(provinces.every((p) => p.level === 1 && p.parentCode === null)).toBe(true);
    expect(provinces.map((p) => p.code)).toEqual([...provinces.map((p) => p.code as string)].sort());
    expect(Object.keys(provinces[0]!).sort()).toEqual(['code', 'level', 'name', 'parentCode']);
    const cities = await items(await c.get(`${REGIONS}?parent=440000`));
    expect(cities).toContainEqual(expect.objectContaining({ code: '440100', level: 2, name: '广州市' }));
    const districts = await items(await c.get(`${REGIONS}?parent=440100`));
    expect(districts).toContainEqual(expect.objectContaining({ code: '440106', level: 3, parentCode: '440100' }));
    const beijing = await items(await c.get(`${REGIONS}?parent=110000`));
    expect(beijing.every((d) => d.level === 3)).toBe(true);
  });

  it('条数上限 500（可分页）：超过上限或非法分页参数 400；未知父级返回空列表', async () => {
    expect((await items(await c.get(`${REGIONS}?parent=440000&limit=2`))).length).toBe(2);
    const second = await items(await c.get(`${REGIONS}?parent=440000&limit=2&offset=2`));
    expect(second.map((i) => i.code)).not.toContain('440100');
    for (const bad of ['limit=501', 'limit=0', 'offset=-1', 'parent=abc'])
      expect((await c.get(`${REGIONS}?${bad}`)).status, bad).toBe(400);
    expect(await items(await c.get(`${REGIONS}?parent=999999`))).toEqual([]);
  });

  it('未登录 401；登录用户不需要任何社保授权就能下钻（全局字典）', async () => {
    expect((await r.world.api.request('GET', REGIONS)).status).toBe(401);
    expect((await c.get(REGIONS)).status).toBe(200);
  });
});

describe('AC-INS-04 / 09 方案候选：启用、当月有效、按缴交地过滤，需方案查看权', () => {
  let r: Awaited<ReturnType<typeof insuranceReadWorld>>;
  let ids: Record<string, string>;
  beforeAll(async () => {
    r = await insuranceReadWorld(testDb().db, 'ins-plans');
    ids = {
      district: await r.plan('DIST', '440106', '2026-01-01'),
      city: await r.plan('CITY', '440100', '2026-01-01', { stop: '2027-01-01' }),
      province: await r.plan('PROV', '440000', '2026-10-01'),
      disabled: await r.plan('OFF', '440106', '2026-01-01', { enabled: false }),
      notYet: await r.plan('NEXT', '440106', '2026-11-01'),
      stopped: await r.plan('STOP', '440106', '2026-01-01', { stop: '2026-10-01' }),
      other: await r.plan('ELSE', '310101', '2026-01-01'),
    };
  });
  const list = async (path: string, spec = {}) => (await r.caller(spec)).get(`${PLANS}?${path}`);

  it('选到区县：方案缴交地 = 该区县或其祖先（市 / 省）；停用、未到生效月、已过停用月、别处缴交地的方案都不出现', async () => {
    const res = await list('regionCode=440106&asOf=2026-10-15');
    expect(res.status).toBe(200);
    const got = await items(res);
    expect(got.map((p) => p.planId).sort()).toEqual([ids.district, ids.city, ids.province].sort());
    expect(got[0]).toEqual(
      expect.objectContaining({ code: expect.any(String), name: expect.any(String), regionCode: expect.any(String) }),
    );
  });

  it('asOf 取当月：下个月的方案到 11 月才出现，停用月的方案当月起不再出现；缺省 asOf 取租户当日', async () => {
    const november = (await items(await list('regionCode=440106&asOf=2026-11-30'))).map((p) => p.planId);
    expect(november).toContain(ids.notYet);
    expect(november).not.toContain(ids.stopped);
    const september = (await items(await list('regionCode=440106&asOf=2026-09-30'))).map((p) => p.planId);
    expect(september).toContain(ids.stopped);
    expect(september).not.toContain(ids.province);
    const today = (await items(await list('regionCode=440106'))).map((p) => p.planId);
    expect(today).toContain(ids.district);
    expect(today).not.toContain(ids.notYet);
  });

  it('选到别的区县：只出现各自缴交地的方案（反例：广州的方案不出现在上海）', async () => {
    const got = (await items(await list('regionCode=310101&asOf=2026-10-15'))).map((p) => p.planId);
    expect(got).toEqual([ids.other]);
  });

  it('参数不合法 400；没有方案查看权 403（含只有档案权限的角色）；方案字段不可见则只裁掉该字段', async () => {
    for (const bad of ['', 'regionCode=44', 'regionCode=440106&asOf=2026-13-01'])
      expect((await list(bad)).status, bad).toBe(400);
    expect((await list('regionCode=440106', { plan: false })).status).toBe(403);
    expect((await list('regionCode=440106', { plan: false, company: false, employment: false })).status).toBe(403);
    expect((await list('regionCode=440106&asOf=2026-10-15', { profile: false })).status).toBe(200);
    const trimmed = await items(await list('regionCode=440106&asOf=2026-10-15', { plan: ['code', 'name'] }));
    expect(trimmed.length).toBeGreaterThan(0);
    for (const item of trimmed) expect(Object.keys(item).sort()).toEqual(['code', 'name', 'planId']);
  });

  it('AC-INS-10：别的租户的方案不出现；同一用户在别的租户里没有授权，读不到本租户方案', async () => {
    const other = await seedInsuranceWorld(testDb().db, 'plans-other');
    const c = await r.caller();
    const own = await items(await c.get(`${PLANS}?regionCode=110000&asOf=2026-10-15`));
    expect(own.map((p) => p.planId)).not.toContain(other.planId);
    await grantMembership(testDb().db, { tenantId: other.tenantId, userId: c.as.user, expectedRevision: 0 }, cmd());
    const res = await r.world.api.request('GET', `${PLANS}?regionCode=110000&asOf=2026-10-15`, {
      user: c.as.user,
      tenant: other.tenantId,
    });
    expect(res.status).toBe(403);
  });
});

describe('AC-INS-04 / 09 公司候选：合同公司主数据，沿用既有可见性', () => {
  it('启用的合同公司可选；停用的、别的租户的不出现；字段随合同公司对象的可见字段', async () => {
    const r = await insuranceReadWorld(testDb().db, 'ins-companies');
    const [on, off] = [await r.company('ON'), await r.company('OFF', false)];
    const other = await seedInsuranceWorld(testDb().db, 'companies-other');
    const c = await r.caller();
    const res = await c.get(COMPANIES);
    expect(res.status).toBe(200);
    const got = await items(res);
    expect(got.map((i) => i.id)).toContain(on);
    expect(got.map((i) => i.id)).not.toContain(off);
    expect(got.map((i) => i.id)).not.toContain(other.companyId);
    expect(got[0]).toEqual({ id: expect.any(String), code: expect.any(String), name: expect.any(String) });
  });

  it('没有合同公司查看权 403；数据范围不是看全部时与合同公司主数据一致：读不到任何一家', async () => {
    const r = await insuranceReadWorld(testDb().db, 'ins-companies-deny');
    await r.company('ONE');
    expect((await (await r.caller({ company: false })).get(COMPANIES)).status).toBe(403);
    const narrow = await (await r.caller({ seeAll: false })).get(COMPANIES);
    expect(narrow.status).toBe(200);
    expect(await items(narrow)).toEqual([]);
  });
});
