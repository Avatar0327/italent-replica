/**
 * F-474-8c-2b 原值读取（AC-INS-02 / 09 / 10 读侧，DEC-896④；设计 §4.1 / §3.3）：
 * 原值 = 业务位置之前的档案事件按业务先后折叠（生效日、计划生效日、操作先后），version_no 与追加顺序一概不参与。
 * 业务单由真实提交流程产生；真实授权器 + 真实 HTTP；档案版本由夹具直接写（本任务不写档案事件）。
 */
import { grantMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedInsuranceWorld } from './support/insurance-tables.js';
import { cmd } from './support/tenant-api.js';
import { DAY, insuranceReadWorld, originUrl, type InsuranceReadWorld } from './support/insurance-read.js';

const testDb = useTestDb();
const NONE = { regionCode: null, planId: null, companyId: null };

/** 同一员工的四张真实调动申请（提交先后 = 业务先后）：前一日 A1、当日 A2、目标 B、当日更晚 A3；档案按相反顺序追加。 */
async function scene() {
  const r = await insuranceReadWorld(testDb().db, 'ins-origin');
  const { employee } = await r.w.hired();
  const apply = (date: string) => r.w.apply(employee.id, date, { place: `地点${date}` });
  const a1 = await apply('2026-10-04');
  const a2 = await apply(DAY);
  const b = await apply(DAY);
  const a3 = await apply(DAY);
  const [p1, p2, p3] = [
    await r.plan('P1', '440100', '2026-01-01'),
    await r.plan('P2', '440100', '2026-01-01'),
    await r.plan('P3', '110000', '2026-01-01'),
  ];
  const [c1, c2] = [await r.company('C1'), await r.company('C2')];
  const early = await r.extraBusiness(employee.id);
  const late = await r.extraBusiness(employee.id);
  const row = async (versionNo: number, businessId: string, seq: Promise<number> | number, rest: object) =>
    r.archive({
      employeeId: employee.id,
      versionNo,
      businessId,
      effectiveDate: DAY,
      seq: await seq,
      ...rest,
    } as Parameters<typeof r.archive>[0]);
  // 追加顺序（version_no 1→6）与业务先后相反：最晚的先写
  // 计划日更晚，seq 再小也在后
  await row(1, late, 1, { plannedDate: '2026-10-08', regionCode: '110000', planId: p3, companyId: c2 });
  await row(2, a3.id, r.seqOf(a3.id), { regionCode: '110105', planId: p3 });
  await row(3, a2.id, r.seqOf(a2.id), { planId: p2 });
  await row(4, early, 999_999, { plannedDate: '2026-10-02', companyId: c2 }); // 计划日更早，seq 再大也在前
  await row(5, a1.id, r.seqOf(a1.id), { effectiveDate: '2026-10-04', regionCode: '440100', planId: p1, companyId: c1 });
  return { r, employee, a1, a2, b, a3, ids: { p1, p2, p3, c1, c2 } };
}

describe('AC-INS-02 原值 = 严格前驱事件按业务先后折叠', () => {
  let s: Awaited<ReturnType<typeof scene>>;
  beforeAll(async () => {
    s = await scene();
  });
  const read = async (spec = {}, effective = DAY, businessId?: string) => {
    const c = await s.r.caller(spec);
    const res = await c.get(originUrl(s.employee.id, effective, businessId));
    return { res, body: (await res.json()) as Record<string, unknown> };
  };

  it('带业务编号：含同日在前的业务、不含同日在后的；计划日与操作先后决定顺序，version_no 不参与', async () => {
    const { res, body } = await read({}, DAY, s.b.id);
    expect(res.status).toBe(200);
    // A1 → 前一日；early（计划日更早）→ 公司 C2；A2（同日在前，seq 小于 B）→ 方案 P2；A3 / late 在 B 之后，不计
    expect(body).toEqual({ regionCode: '440100', planId: s.ids.p2, companyId: s.ids.c2 });
  });

  it('已有业务的位置由服务端从单据解析：客户端生效日早于 / 等于 / 晚于单据日期，原值都不变', async () => {
    const expected = { regionCode: '440100', planId: s.ids.p2, companyId: s.ids.c2 };
    // 单据 B 的实际生效日是 DAY；10-03 在 A1 之前、10-06 在后序事件之后，旧实现分别得到全空与含后继的值
    const reads = [];
    for (const queryDate of ['2026-10-03', DAY, '2026-10-06']) reads.push(await read({}, queryDate, s.b.id));
    expect(reads.map((r) => r.res.status)).toEqual([200, 200, 200]);
    expect(reads.map((r) => r.body)).toEqual([expected, expected, expected]);
  });

  it('不带业务编号：位置取当日最后一次操作，当日全部事件都计入', async () => {
    const { body } = await read();
    expect(body).toEqual({ regionCode: '110000', planId: s.ids.p3, companyId: s.ids.c2 });
  });

  it('生效日之前没有任何事件：三个值都为空（不是错误）', async () => {
    expect((await read({}, '2026-10-03')).body).toEqual(NONE);
    expect((await read({}, '2026-10-04')).body).toEqual({
      regionCode: '440100',
      planId: s.ids.p1,
      companyId: s.ids.c1,
    });
  });

  it('同日同计划日的两个业务只按操作先后分前后（A3 是 A2 的后继，不是前驱）', async () => {
    const { body } = await read({}, DAY, s.a3.id);
    expect(body).toMatchObject({ planId: s.ids.p2 });
    expect((await read({}, DAY, s.a2.id)).body).toMatchObject({ planId: s.ids.p1 });
  });

  it('没有档案的员工：三个值都为空', async () => {
    const { employee } = await s.r.w.hired('无档案员工');
    const c = await s.r.caller();
    const res = await c.get(originUrl(employee.id, DAY));
    expect(await res.json()).toEqual(NONE);
  });
});

describe('AC-INS-09 原值的读取准入：员工范围 + 档案查看权，不给半截原值', () => {
  let s: Awaited<ReturnType<typeof scene>>;
  beforeAll(async () => {
    s = await scene();
  });
  const get = async (spec: object, employeeId = s.employee.id) =>
    (await s.r.caller(spec)).get(originUrl(employeeId, DAY, s.b.id));

  it('三个字段都可见：200；没有该对象查看权（含只有任职权限的普通角色）：403 且不带任何原值', async () => {
    expect((await get({})).status).toBe(200);
    for (const spec of [{ profile: false }, { profile: false, plan: false, company: false }]) {
      const res = await get(spec);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toMatch(/regionCode|planId|companyId/);
    }
  });

  it('任一字段不可见：整体 403，不返回其余两个字段', async () => {
    for (const hidden of ['insuranceRegionCode', 'insurancePlanId', 'insuranceCompanyId']) {
      const visible = ['insuranceRegionCode', 'insurancePlanId', 'insuranceCompanyId'].filter((f) => f !== hidden);
      const res = await get({ profile: visible });
      expect(res.status, hidden).toBe(403);
      expect(JSON.stringify(await res.json())).not.toMatch(/440100|110000/);
    }
  });

  it('不在员工数据范围内（范围默认空）：与员工不存在同样 404', async () => {
    const outOfScope = await get({ seeAll: false });
    const missing = await get({}, '00000000-0000-4000-8000-000000000001');
    expect([outOfScope.status, missing.status]).toEqual([404, 404]);
    expect(await outOfScope.json()).toEqual(await missing.json());
  });

  it('参数不合法：400（缺员工 / 日期格式 / 业务编号不是 UUID）', async () => {
    const c = await s.r.caller();
    for (const path of [
      '/api/tenant/transfer/insurance-origin?effectiveDate=2026-10-05',
      `/api/tenant/transfer/insurance-origin?employeeId=${s.employee.id}&effectiveDate=2026-13-01`,
      `/api/tenant/transfer/insurance-origin?employeeId=${s.employee.id}&effectiveDate=${DAY}&businessId=x`,
    ])
      expect((await c.get(path)).status, path).toBe(400);
  });
});

describe('AC-INS-10 读侧租户隔离与业务编号归属', () => {
  it('别的租户的业务、同租户别的员工的业务、不存在的业务：同一个 404，不暴露存在性', async () => {
    const s = await scene();
    const other = await seedInsuranceWorld(testDb().db, 'other-tenant');
    const otherEmployee = await s.r.w.hired('另一员工');
    const foreign = await s.r.w.apply(otherEmployee.employee.id, DAY, { place: '别人的单' });
    const c = await s.r.caller();
    // 对照：本人名下的业务编号读得通，下面三种才是“归属不符”的 404
    expect((await c.get(originUrl(s.employee.id, DAY, s.b.id))).status).toBe(200);
    const responses = await Promise.all(
      [other.businessIds[0], foreign.id, '00000000-0000-4000-8000-0000000000aa'].map((id) =>
        c.get(originUrl(s.employee.id, DAY, id)),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404]);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);
  });

  it('同一用户在另一租户的身份读不到本租户的档案：另一租户里没有该员工，也没有任何授权', async () => {
    const s = await scene();
    const c = await s.r.caller();
    const other = await seedInsuranceWorld(testDb().db, 'other-member');
    expect((await c.get(originUrl(s.employee.id, DAY))).status).toBe(200); // 对照：本租户内同一用户读得通
    await grantMembership(testDb().db, { tenantId: other.tenantId, userId: c.as.user, expectedRevision: 0 }, cmd());
    const res = await s.r.world.api.request('GET', originUrl(s.employee.id, DAY), {
      user: c.as.user,
      tenant: other.tenantId,
    });
    expect([403, 404]).toContain(res.status);
    expect(JSON.stringify(await res.json())).not.toMatch(/440100|110000/);
  });
});

export type { InsuranceReadWorld };
