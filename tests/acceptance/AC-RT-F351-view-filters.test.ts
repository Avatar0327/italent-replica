/**
 * F-351 ①：GET /retirements 的五视图 + 撤销视图接受 keyword（姓名 / 工号）与 departmentId（含下级）筛选。
 * 口径同离职视图（AC-DM-19 B-66）：筛选在分页前叠加，数据范围照旧（fail-closed）；
 * 筛选用到的字段无字段权 → 403（不让筛选成为探针）；范围外与不存在的部门同一个空结果（同码同文案）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const ASOF = '2026-10-15';

interface Page {
  items: { id?: string; employeeId: string; name?: string }[];
  total: number;
}

async function world(label: string) {
  const x = await retirementWorld(database().db, label, TODAY);
  const child = await x.session.org('子部门', {
    establishedOn: '2026-01-01',
    parents: { admin: { parentId: x.from.id } },
  });
  async function hireIn(name: string, departmentId: string) {
    const employee = await x.session.employee(name);
    await x.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId } },
      employee.revision,
    );
    return employee;
  }
  /** 张筛选在根部门、李筛选在子部门；两人都有预计退休日（进人员视图）和一张草稿退休单（进单据视图）。 */
  async function people() {
    const zhang = (await x.hired('张筛选')).employee;
    const li = await hireIn('李筛选', child.id);
    const bills: Record<string, string> = {};
    for (const [key, employee] of [
      ['zhang', zhang],
      ['li', li],
    ] as const) {
      await x.setExpectedRetirement('2026-10-20', employee.id);
      bills[key] = (
        await x.createdRetire(employee.id, {
          kind: 'retirement',
          mode: 'application',
          lastWorkDate: '2026-10-25',
          fields: {},
        })
      ).id;
    }
    return { zhang, li, bills };
  }
  async function get(view: string, query = '', api = x.session.request) {
    const response = await api('GET', `/retirements?view=${view}&asOf=${ASOF}${query}`);
    return { status: response.status, text: await response.text() };
  }
  async function page(view: string, query = '', api = x.session.request): Promise<Page> {
    const result = await get(view, query, api);
    expect(result.status, result.text).toBe(200);
    return JSON.parse(result.text) as Page;
  }
  return { x, child, people, get, page };
}

describe('F-351 退休视图的关键字与部门筛选', () => {
  it('单据视图（all / processing）：关键字按姓名 / 工号（忽略大小写、% 不当通配符），部门默认含下级', async () => {
    const w = await world('f351-vf-bill');
    const { zhang, li, bills } = await w.people();
    const ids = async (query: string) => (await w.page('all', query)).items.map((item) => item.id);
    expect(await ids('&keyword=张筛')).toEqual([bills.zhang]);
    const code = (await w.x.session.getEmployee(li.id)).code;
    expect(await ids(`&keyword=${encodeURIComponent(code.toLowerCase())}`)).toEqual([bills.li]);
    expect(await ids('&keyword=%25')).toEqual([]);
    expect((await ids(`&departmentId=${w.x.from.id}`)).sort()).toEqual([bills.zhang, bills.li].sort());
    expect(await ids(`&departmentId=${w.child.id}`)).toEqual([bills.li]);
    expect(await ids(`&departmentId=${w.x.from.id}&includeChildren=false`)).toEqual([bills.zhang]);
    // total 随筛选变化（分页前过滤），不是只裁剪当前页
    expect((await w.page('all', `&departmentId=${w.child.id}&pageSize=1`)).total).toBe(1);
    expect(zhang.id).not.toBe(li.id);
  });

  it('人员视图（upcoming）：同一组筛选，行带 employeeId', async () => {
    const w = await world('f351-vf-person');
    const { zhang, li } = await w.people();
    const ids = async (query: string) => (await w.page('upcoming', query)).items.map((item) => item.employeeId);
    expect(await ids('&keyword=张筛')).toEqual([zhang.id]);
    expect(await ids('&keyword=%25')).toEqual([]);
    expect((await ids(`&departmentId=${w.x.from.id}`)).sort()).toEqual([zhang.id, li.id].sort());
    expect(await ids(`&departmentId=${w.child.id}`)).toEqual([li.id]);
    expect(await ids(`&departmentId=${w.x.from.id}&includeChildren=false`)).toEqual([zhang.id]);
    expect((await w.page('upcoming', `&departmentId=${w.child.id}&pageSize=1`)).total).toBe(1);
  });

  it('参数校验与字段权：部门不是 UUID → 400；无部门 / 姓名字段权时按它们筛选 → 403', async () => {
    const w = await world('f351-vf-perm');
    await w.people();
    expect((await w.get('all', '&departmentId=not-a-uuid')).status).toBe(400);
    expect((await w.get('all', `&keyword=${'a'.repeat(101)}`)).status).toBe(400);
    const noDepartment = w.x.restricted(denyButtons(), undefined, [
      'id',
      'employeeId',
      'status',
      'revision',
      'name',
      'code',
    ]);
    for (const view of ['all', 'upcoming']) {
      expect((await w.get(view, `&departmentId=${w.x.from.id}`, noDepartment)).status, view).toBe(403);
      expect((await w.get(view, '&keyword=张', noDepartment)).status, `${view} 有姓名权`).toBe(200);
    }
    const noName = w.x.restricted(denyButtons(), undefined, ['id', 'employeeId', 'status', 'revision', 'departmentId']);
    for (const view of ['all', 'upcoming']) expect((await w.get(view, '&keyword=张', noName)).status, view).toBe(403);
  });

  it('数据范围照旧：范围外的人带筛选也看不到；范围外部门与不存在的部门同一个空结果（同状态同文案）', async () => {
    const w = await world('f351-vf-scope');
    await w.people();
    const nobody = w.x.restricted(denyButtons(), '00000000-0000-4000-8000-000000000001', [
      'id',
      'employeeId',
      'status',
      'revision',
      'name',
      'code',
      'departmentId',
    ]);
    for (const view of ['all', 'upcoming']) {
      const keyword = await w.page(view, '&keyword=张筛', nobody);
      expect(keyword, view).toMatchObject({ items: [], total: 0 });
      const outside = await w.get(view, `&departmentId=${w.x.from.id}`, nobody);
      const missing = await w.get(view, '&departmentId=00000000-0000-4000-8000-0000000000aa', nobody);
      expect(outside.status, view).toBe(200);
      expect(outside, view).toEqual(missing);
      expect(JSON.parse(outside.text)).toMatchObject({ items: [], total: 0 });
    }
  });
});
