/**
 * AC-DM-30-F493-28（F-493 S1，设计 §3.5）：员工工号为 NULL 时，读取 / 排序 / 校验位置不崩、不丢人。
 * 三人：工号 S-02、NULL、S-01（各位置按需要用其中的几人）。
 * ① 精确查找  ② 人员列表排序  ④ 关键字查找  ⑤ 花名册导出  ⑥ 任职工号校验  ⑦ 组织调整失败清单
 * ⑧ 人员排序编码重算。③ 360 自动添加键集分页在 AC-DM-30-F493-28-keyset.test.ts（大租户，独立库）。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { rosterCellText } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { employmentSession } from './AC-EMP-support.js';
import { gateWorld } from './AC-EXIT-gate-support.js';
import { hireNullCode, nullCodeEmployee } from './AC-F493-s1-support.js';
import { parseCsv, ROSTER_HEADERS, rosterWorld, stripBom } from './AC-HA-roster-support.js';
import { itemsWorld, rename } from './AC-OA-items-support.js';
import { reader } from './AC-OA-read-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/** 三人：S-02、NULL、S-01 都建档并入职（同一部门）。 */
async function threePeople(label: string) {
  const { db } = database();
  const w = await employmentSession(db, label);
  const org = await w.org('合成空工号部门', { establishedOn: '2025-01-01' });
  const hire = (id: string, revision: number) =>
    w.business(
      id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: org.id } },
      revision,
    );
  const s02 = await w.employee('乙二', 'S-02');
  await hire(s02.id, s02.revision);
  const { employee: none } = await hireNullCode(db, w, '空工号人员', { departmentId: org.id });
  const s01 = await w.employee('甲一', 'S-01');
  await hire(s01.id, s01.revision);
  return { db, w, org, s02, s01, none };
}

describe('AC-DM-30-F493-28 ① 精确查找', () => {
  it('按工号精确查找：命中 S-01，不会命中工号为 NULL 的人', async () => {
    const { w, s01, none } = await threePeople('f493s1-28-exact');
    const response = await w.request('GET', '/employees?code=S-01');
    expect(response.status, await response.clone().text()).toBe(200);
    const items = ((await response.json()) as { items: { id: string }[] }).items;
    expect(items.map((item) => item.id)).toEqual([s01.id]);
    expect(items.map((item) => item.id)).not.toContain(none.id);
  });
});

describe('AC-DM-30-F493-28 ② 人员列表按工号升序', () => {
  it('S-01、S-02 在前，空工号排最后（不报错）', async () => {
    const { db, w, s01, s02, none } = await threePeople('f493s1-28-sort');
    const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const response = await api.request('GET', '/api/tenant/personnel/employees', {
      user: w.user.id,
      tenant: w.tenant.id,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const items = ((await response.json()) as { items: { id: string; code: string | null }[] }).items;
    expect(items.map((item) => item.id)).toEqual([s01.id, s02.id, none.id]);
    expect(items.map((item) => item.code ?? null)).toEqual(['S-01', 'S-02', null]);
  });
});

describe('AC-DM-30-F493-28 ④ 离职 / 试用 / 合同列表关键字', () => {
  it('合同“入职缺失”视图：按姓名关键字找得到空工号的人，按工号关键字找不到', async () => {
    const { db } = database();
    const w = await contractWorld(db, 'f493s1-28-contract');
    const { employee: none } = await hireNullCode(db, w.session, '空工号合同人', { departmentId: w.org.id });
    const ids = async (keyword: string) => {
      const response = await w.request(
        'GET',
        `?view=missing&typeId=${w.type.id}&keyword=${encodeURIComponent(keyword)}`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { employeeId: string }[] }).items.map((i) => i.employeeId);
    };
    expect(await ids('空工号合同人')).toEqual([none.id]);
    // w.employee 是夹具里有工号的另一人：按它的工号只命中它自己
    const codedCode = (await w.session.getEmployee(w.employee.id)).code;
    expect(await ids(codedCode)).toEqual([w.employee.id]);
  });

  it('离职视图：按姓名关键字找得到空工号的人，按工号关键字只找得到有工号的人', async () => {
    const { db } = database();
    const w = await gateWorld(db, 'f493s1-28-exit');
    const coded = await w.hired('有工号离职人');
    const { employee: none } = await hireNullCode(db, w.session, '空工号离职人', { departmentId: w.from.id });
    for (const target of [coded.employee, none]) {
      const { revision } = await w.session.getEmployee(target.id);
      const response = await w.session.request('POST', `/exits/employees/${target.id}`, {
        ifMatch: revision,
        body: { mode: 'application', lastWorkDate: '2026-10-30' },
      });
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const ids = async (keyword: string) => {
      const response = await w.session.request('GET', `/exits?view=all&keyword=${encodeURIComponent(keyword)}`);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { employeeId: string }[] }).items.map((i) => i.employeeId);
    };
    expect(await ids('空工号离职人')).toEqual([none.id]);
    expect(await ids(coded.employee.code)).toEqual([coded.employee.id]);
  });

  it('试用视图：按姓名关键字找得到空工号的人，按工号关键字只找得到有工号的人', async () => {
    const { db } = database();
    const w = await gateWorld(db, 'f493s1-28-probation');
    const coded = await w.hired('有工号试用人', { probation: true });
    const { employee: none } = await hireNullCode(
      db,
      w.session,
      '空工号试用人',
      { departmentId: w.from.id, place: '原地点', employType: 'internal' },
      { probation: true },
    );
    const names = async (keyword: string) => {
      const response = await w.session.request(
        'GET',
        `/probation-views?view=all&keyword=${encodeURIComponent(keyword)}`,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { name: string }[] }).items.map((i) => i.name);
    };
    expect(await names('空工号试用人')).toEqual(['空工号试用人']);
    expect(await names(coded.employee.code)).toEqual(['有工号试用人']);
    expect(none.code).toBeNull();
  });
});

describe('AC-DM-30-F493-28 ⑤ 花名册导出', () => {
  it('空工号的人导出一行，工号单元格为空串；列表里该人的工号为 null', async () => {
    const { db } = database();
    const w = await rosterWorld(db, 'f493s1-28-roster');
    const dept = await w.org('合成花名册部门');
    const { employee: none } = await hireNullCode(db, w.session, '空工号花名册人', { departmentId: dept.id });
    const lines = parseCsv(stripBom(await (await w.exported('2026-10-01')).text()));
    const row = lines.find((line) => line.includes('空工号花名册人'));
    expect(row, '导出里有该人').toBeDefined();
    expect(row![lines[0]!.indexOf('工号')]).toBe('');
    expect(lines[0]).toEqual(expect.arrayContaining([...ROSTER_HEADERS.slice(0, 2)]));
    const page = await w.rosterOk('2026-10-01');
    expect(page.items.find((item) => item.employeeId === none.id)?.code ?? null).toBeNull();
    expect(rosterCellText('code', null)).toBe('');
  });
});

describe('AC-DM-30-F493-28 ⑥ 任职工号必须等于员工主档工号', () => {
  it('空工号的人：编辑任职记录带非空 jobNumber → 400（不是 500），jobNumber 为空照常通过', async () => {
    const { db } = database();
    const w = await employmentSession(db, 'f493s1-28-job-number');
    const org = await w.org('合成工号部门', { establishedOn: '2025-01-01' });
    const { employee, hire } = await hireNullCode(db, w, '空工号编辑人', { departmentId: org.id });
    const [record] = await w.records(employee.id);
    const invalid = await w.request('PATCH', `/records/${record!.id}`, {
      ifMatch: hire.revision,
      body: { fields: { jobNumber: 'SYNTHETIC_ANY' } },
    });
    expect(invalid.status, await invalid.clone().text()).toBe(400);
    expect(JSON.stringify(await invalid.json())).toContain('任职工号必须等于员工主档工号');
    const cleared = await w.request('PATCH', `/records/${record!.id}`, {
      ifMatch: hire.revision,
      body: { fields: { jobNumber: null } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(hire.status).toBe('effective');
  });

  it('空工号的人：办理入职时带非空 jobNumber → 400（继承校验）', async () => {
    const { db } = database();
    const w = await employmentSession(db, 'f493s1-28-job-number-hire');
    const org = await w.org('合成工号入职部门', { establishedOn: '2025-01-01' });
    const employee = await nullCodeEmployee(db, w, '空工号入职人');
    const response = await w.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: org.id, jobNumber: 'SYNTHETIC_ANY' },
        loginEmail: `person-${employee.id}@example.com`,
      },
    });
    expect(response.status, await response.clone().text()).toBe(400);
  });
});

describe('AC-DM-30-F493-28 ⑦ 组织调整失败清单', () => {
  it('清单里有空工号的人：正常返回，有工号在前、空工号排后', async () => {
    const { db } = database();
    const w = await itemsWorld(db, 'f493s1-28-failures');
    const view = await w.created(w.head({ adjustmentRange: [w.a] }));
    const itemId = (await w.item(view.id, rename(w.a))).items.at(-1)!.id;
    // 两个有工号 + 两个空工号：排序比较器必然拿空工号当比较对象（单对排序受引擎比较顺序影响，会侥幸通过）
    const coded = [await w.person('ZZ_有工号甲', w.a), await w.person('ZZ_有工号乙', w.a)];
    const nones = [];
    for (const name of ['ZZ_空工号甲', 'ZZ_空工号乙']) {
      const none = await nullCodeEmployee(db, { tenant: w.tenant, user: w.hr }, name);
      await w.hire(none.id, { departmentId: w.a });
      nones.push(none);
    }
    for (const employeeId of [...coded.map((p) => p.employeeId), ...nones.map((n) => n.id)]) {
      await withTenant(db, w.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO org_adjustment_employment_failures
          (tenant_id, adjustment_id, item_id, employee_id, reason, message)
          VALUES (${w.tenant.id}, ${view.id}, ${itemId}, ${employeeId}, 'EMPLOYMENT_CHANGED', '合成失败说明')`),
      );
    }
    const detail = (await reader(w).detail(view.id)) as unknown as {
      employmentFailures?: { employeeId: string; employeeCode: string | null }[];
    };
    const listed = detail.employmentFailures ?? [];
    expect(listed).toHaveLength(4);
    expect(
      listed
        .slice(0, 2)
        .map((f) => f.employeeId)
        .sort(),
    ).toEqual(coded.map((p) => p.employeeId).sort());
    expect(listed.slice(0, 2).every((f) => f.employeeCode !== null)).toBe(true);
    expect(listed.slice(2).map((f) => f.employeeCode)).toEqual([null, null]);
    expect(listed.slice(2).map((f) => f.employeeId)).toEqual(nones.map((n) => n.id).sort());
  });
});

describe('AC-DM-30-F493-28 ⑧ 人员排序编码重算', () => {
  it('启用工号升序规则后重算完成，空工号的人排最后', async () => {
    const { db, w, s01, s02, none } = await threePeople('f493s1-28-order-code');
    const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const call = (method: string, path: string, body: unknown, ifMatch: number) =>
      api.request(method, `/api/tenant/personnel/${path}`, { user: w.user.id, tenant: w.tenant.id, body, ifMatch });
    const settings = await call(
      'PUT',
      'order-code/settings',
      { enabled: true, items: [{ field: 'code', direction: 'asc', enabled: true }] },
      0,
    );
    expect(settings.status, await settings.clone().text()).toBe(200);
    const recompute = await call('POST', 'order-code/recompute', {}, 1);
    expect(recompute.status, await recompute.clone().text()).toBe(200);
    expect(await recompute.json()).toMatchObject({ outcome: 'computed' });
    const ranks = await withTenant(db, w.tenant.id, async (tx) =>
      rowsOf<{ employee_id: string; order_code: number }>(
        await tx.execute(sql`SELECT employee_id, order_code FROM personnel_employee_order_codes
          WHERE tenant_id=${w.tenant.id} ORDER BY order_code`),
      ),
    );
    expect(ranks.map((row) => row.employee_id)).toEqual([s01.id, s02.id, none.id]);
  });
});
