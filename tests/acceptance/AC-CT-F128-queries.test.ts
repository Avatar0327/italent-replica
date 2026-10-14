/** F-128 BE-1：入职缺失按类型（A2）、高级筛选与排序（A7）、即将到期排除已续签（A1）、详情任职与版本链（A8）。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld, type ContractView } from './AC-CT-support.js';

const testDb = useTestDb();
type World = Awaited<ReturnType<typeof contractWorld>>;
interface Page<T = ContractView> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

async function query<T = ContractView>(w: World, qs: string, status = 200): Promise<Page<T>> {
  const response = await w.request('GET', `?${qs}`);
  expect(response.status, await response.clone().text()).toBe(status);
  return (await response.json()) as Page<T>;
}

/** 两个员工、两家法人公司、两个组织（子部门挂在合同部门下）；甲持劳动合同，乙持劳务合同。 */
async function populated(label: string) {
  const w = await contractWorld(testDb().db, label);
  const child = await w.session.org('合同子部门', {
    establishedOn: '2025-01-01',
    parents: { admin: { parentId: w.org.id } },
  });
  const second = await w.session.employee('李四合成', 'EMP_LISI');
  await w.session.business(
    second.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2025-03-01', fields: { departmentId: child.id } },
    second.revision,
  );
  const company = await w.request('POST', '/master-data/companies', {
    ifMatch: 0,
    body: { code: 'CO-2', name: '第二法人' },
  });
  const otherCompany = (await company.json()) as { id: string };
  const a = await w.create({ endDate: '2027-09-30', number: 'A-001' });
  const bResponse = await w.request('POST', '/commands', {
    ifMatch: 0,
    body: {
      operation: 'create',
      mode: 'direct',
      employeeId: second.id,
      fields: {
        ...w.fields,
        typeId: w.otherType.id,
        companyId: otherCompany.id,
        number: 'B-002',
        effectiveDate: '2025-06-01',
        endDate: '2026-10-15',
        termMonths: 16,
      },
    },
  });
  expect(bResponse.status, await bResponse.clone().text()).toBe(201);
  const b = (await bResponse.json()) as ContractView;
  return { w, a, b, second, otherCompany, child: child.id };
}

describe('AC-CT F-128 A2 入职缺失按类型并带任职列', () => {
  it('typeId：缺失 = 没有该类型的有效合同；不传保持“任何有效合同都没有”', async () => {
    const { w, second } = await populated('f128-missing');
    const third = await w.session.employee('王五合成', 'EMP_WANGWU');
    await w.session.business(
      third.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2025-04-01', fields: { departmentId: w.org.id } },
      third.revision,
    );
    const any = await query<{ employeeId: string }>(w, 'view=missing');
    expect(any.items.map((i) => i.employeeId)).toEqual([third.id]);
    const byType = await query<{ employeeId: string }>(w, `view=missing&typeId=${w.type.id}`);
    expect(byType.items.map((i) => i.employeeId).sort()).toEqual([second.id, third.id].sort());
    expect(byType.total).toBe(2);
  });

  it('返回任职列：部门、职务 / 职位、入职日期（取当前主职）', async () => {
    const { w, second, child } = await populated('f128-missing-columns');
    const result = await query<Record<string, unknown>>(w, `view=missing&typeId=${w.type.id}`);
    const row = result.items.find((i) => i.employeeId === second.id)!;
    expect(row).toMatchObject({ code: 'EMP_LISI', name: '李四合成' });
    expect(row.employment).toMatchObject({ departmentId: child, entryDate: '2025-03-01' });
    expect(Object.keys(row.employment as object)).toEqual(expect.arrayContaining(['positionId', 'postId']));
  });
});

describe('AC-CT F-128 A2 入职缺失视图只认适用的筛选（日期等合同维度筛选被忽略）', () => {
  it.each([
    'effectiveFrom=2000-01-01',
    'effectiveTo=2100-01-01',
    'endFrom=2000-01-01',
    'endTo=2100-01-01',
    'effectiveFrom=2000-01-01&effectiveTo=2100-01-01&endFrom=2000-01-01&endTo=2100-01-01',
    'status=terminated&termType=indefinite&companyId=00000000-0000-4000-8000-000000000000',
  ])('带 %s 结果与不带时一致', async (extra) => {
    const { w, second } = await populated(`f128-missing-${extra.length}-${extra.slice(0, 9)}`);
    const base = await query<{ employeeId: string }>(w, `view=missing&typeId=${w.type.id}`);
    expect(base.items.map((i) => i.employeeId)).toEqual([second.id]);
    const withExtra = await query<{ employeeId: string }>(w, `view=missing&typeId=${w.type.id}&${extra}`);
    expect(withExtra.items.map((i) => i.employeeId)).toEqual([second.id]);
    expect(withExtra.total).toBe(1);
  });

  it('日期参数与员工 / 姓名 / 工号 / 组织筛选组合时，后者仍然生效', async () => {
    const { w, second, child } = await populated('f128-missing-combo');
    const dates = 'effectiveFrom=2000-01-01&endTo=2100-01-01';
    const ids = async (qs: string) =>
      (await query<{ employeeId: string }>(w, `view=missing&typeId=${w.type.id}&${dates}&${qs}`)).items.map(
        (i) => i.employeeId,
      );
    expect(await ids(`employeeId=${second.id}`)).toEqual([second.id]);
    expect(await ids(`employeeId=${w.employee.id}`)).toEqual([]);
    expect(await ids(`keyword=${encodeURIComponent('李四')}`)).toEqual([second.id]);
    expect(await ids('keyword=EMP_LISI')).toEqual([second.id]);
    expect(await ids('keyword=NOBODY')).toEqual([]);
    expect(await ids(`orgId=${child}`)).toEqual([second.id]);
    expect(await ids(`orgId=${w.org.id}`)).toEqual([]);
  });
});

describe('AC-CT F-128 A7 高级筛选、排序与总数', () => {
  it.each([
    ['员工', (c: Ctx) => `employeeId=${c.second.id}`, ['B-002']],
    ['姓名关键字', () => `keyword=${encodeURIComponent('李四')}`, ['B-002']],
    ['工号关键字', () => 'keyword=EMP_LISI', ['B-002']],
    ['组织（含下级）', (c: Ctx) => `orgId=${c.w.org.id}&includeChildren=true`, ['A-001', 'B-002']],
    ['组织（不含下级）', (c: Ctx) => `orgId=${c.w.org.id}`, ['A-001']],
    ['合同类型', (c: Ctx) => `typeId=${c.w.otherType.id}`, ['B-002']],
    ['法人公司', (c: Ctx) => `companyId=${c.otherCompany.id}`, ['B-002']],
    ['状态', () => 'status=valid', ['A-001', 'B-002']],
    ['状态无匹配', () => 'status=terminated', []],
    ['期限类型', () => 'termType=fixed', ['A-001', 'B-002']],
    ['生效日区间', () => 'effectiveFrom=2025-05-01&effectiveTo=2025-12-31', ['B-002']],
    ['终止日区间', () => 'endFrom=2027-01-01&endTo=2027-12-31', ['A-001']],
  ] as const)('筛选：%s', async (_name, build, numbers) => {
    const c = await populated(`f128-filter-${_name}`);
    const result = await query(c.w, `view=all&${build(c)}`);
    expect(result.items.map((i) => i.number).sort()).toEqual([...numbers]);
    expect(result.total).toBe(numbers.length);
  });

  it('所有视图共用同一套参数', async () => {
    const c = await populated('f128-filter-views');
    const valid = await query(c.w, `view=valid&typeId=${c.w.otherType.id}`);
    expect(valid.items.map((i) => i.number)).toEqual(['B-002']);
    const expiring = await query(c.w, 'view=expiring&days=30&keyword=EMP_LISI');
    expect(expiring.items.map((i) => i.number)).toEqual(['B-002']);
    const none = await query(c.w, `view=expiring&days=30&typeId=${c.w.type.id}`);
    expect(none.items).toEqual([]);
  });

  it('排序：白名单字段 + asc / desc；默认保持生效日、编号次序', async () => {
    const c = await populated('f128-sort');
    const numbers = async (qs: string) => (await query(c.w, qs)).items.map((i) => i.number);
    expect(await numbers('view=all')).toEqual(['A-001', 'B-002']);
    expect(await numbers('view=all&sort=endDate&order=desc')).toEqual(['A-001', 'B-002']);
    expect(await numbers('view=all&sort=endDate&order=asc')).toEqual(['B-002', 'A-001']);
    expect(await numbers('view=all&sort=effectiveDate&order=desc')).toEqual(['B-002', 'A-001']);
    expect(await numbers('view=all&sort=number&order=desc')).toEqual(['B-002', 'A-001']);
    expect(await numbers('view=all&sort=name&order=desc')).toEqual(['B-002', 'A-001']);
    expect(await numbers('view=valid&sort=signingDate&order=asc')).toHaveLength(2);
    await query(c.w, 'view=all&sort=password', 400);
    await query(c.w, 'view=all&sort=endDate&order=sideways', 400);
  });

  it('列表响应带 total，分页不影响总数', async () => {
    const c = await populated('f128-total');
    const first = await query(c.w, 'view=all&page=1&pageSize=1');
    expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(first.items).toHaveLength(1);
    const second = await query(c.w, 'view=all&page=2&pageSize=1');
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it('参数不合法 → 400', async () => {
    const c = await populated('f128-bad-params');
    await query(c.w, 'view=all&employeeId=not-a-uuid', 400);
    await query(c.w, 'view=all&effectiveFrom=2025-13-01', 400);
    await query(c.w, 'view=all&status=whatever', 400);
  });
});

describe('AC-CT F-128 A1 即将到期排除已续签', () => {
  it('已有后续续签合同或续签申请的合同不再出现在即将到期', async () => {
    const c = await populated('f128-expiring');
    const before = await query(c.w, 'view=expiring&days=30');
    expect(before.items.map((i) => i.number)).toEqual(['B-002']);
    // 续签（默认生效日为原终止日次日 2026-10-16，晚于今天 → 生成已通过的申请）
    const renewal = await c.w.request('POST', '/commands', {
      ifMatch: c.b.revision,
      body: { operation: 'renew', mode: 'direct', employeeId: c.second.id, targetId: c.b.id, fields: {} },
    });
    expect(renewal.status, await renewal.clone().text()).toBe(201);
    const after = await query(c.w, 'view=expiring&days=30');
    expect(after.items).toEqual([]);
  });
});

describe('AC-CT F-128 A8 详情带任职与版本链', () => {
  it('GET /records/:id 带 employment 与同 root 的版本摘要', async () => {
    const c = await populated('f128-detail');
    const renewal = await c.w.change(c.a, 'renew', { effectiveDate: '2026-10-01', endDate: '2028-09-30' });
    expect(renewal.status, await renewal.clone().text()).toBe(201);
    const renewed = (await renewal.json()) as ContractView & { rootContractId: string };
    const response = await c.w.request('GET', `/records/${renewed.id}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as {
      id: string;
      employment: { departmentId: string; place: unknown } | null;
      versions: { id: string; signingCount: number; effectiveDate: string }[];
    };
    expect(detail.id).toBe(renewed.id);
    expect(detail.employment).toMatchObject({ departmentId: c.w.org.id });
    expect(Object.keys(detail.employment!)).toEqual(expect.arrayContaining(['positionId', 'postId', 'place']));
    expect(detail.versions.map((v) => v.signingCount)).toEqual([1, 2]);
    expect(detail.versions.map((v) => v.id)).toContain(c.a.id);
    expect(detail.versions.every((v) => 'number' in v && 'status' in v && 'endDate' in v)).toBe(true);
  });

  it('GET /employees/:id/contracts 返回该员工全部合同摘要，不含他人的', async () => {
    const c = await populated('f128-employee-contracts');
    const response = await c.w.request('GET', `/employees/${c.w.employee.id}/contracts`);
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as { items: { id: string; number: string }[] };
    expect(body.items.map((i) => i.number)).toEqual(['A-001']);
    const other = await c.w.request('GET', `/employees/${c.second.id}/contracts`);
    expect(((await other.json()) as { items: { number: string }[] }).items.map((i) => i.number)).toEqual(['B-002']);
    expect((await c.w.request('GET', '/employees/not-a-uuid/contracts')).status).toBe(400);
  });
});

interface Ctx {
  w: World;
  second: { id: string };
  otherCompany: { id: string };
}
