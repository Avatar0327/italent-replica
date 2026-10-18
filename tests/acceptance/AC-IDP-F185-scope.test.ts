/**
 * F-185 第 1 轮 P2-1（DEC-406 / DEC-455 披露类）：关键信息列表的员工范围条件必须限定外层表名。
 * 管理范围按“当前任职组织”派生人员时，范围子查询内有同名列 employee_id；裸列写法会绑定成内层列，
 * 变成 managed.employee_id = managed.employee_id，范围外员工的记录从列表漏出（详情仍 404）。
 * 用真实授权器（只有部门 A 的 IDP 范围的操作人）核对四种读法一致：列表、employeeId 筛选、分页、详情。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { idpOperator } from './AC-IDP-permission-support.js';
import { permissionWorldOf, planWorld, type PlanWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';
const span = (n: number) => ({ startDate: `2026-0${n}-01`, endDate: `2026-0${n}-28` });

async function scene(label: string) {
  const w = await planWorld(testDb().db, label);
  const pw = await permissionWorldOf(w);
  const otherDept = await w.org('范围外部门');
  const outsiderB = await w.person('范围外员工B', otherDept);
  const hr = await idpOperator(pw, { orgId: w.dept });
  return { w, hr, outsiderB, otherDept };
}

type Scene = Awaited<ReturnType<typeof scene>>;

interface Kind {
  readonly path: string;
  /** 范围内记录的请求体（第 n 条）与范围外员工 B 的记录请求体。 */
  readonly inside: (s: Scene, n: number) => Record<string, unknown>;
  readonly outside: (s: Scene) => Record<string, unknown>;
}

const KINDS: Record<string, Kind> = {
  careers: {
    path: '/careers',
    inside: (s, n) => ({ employeeId: s.w.employee.employeeId, ...span(n) }),
    outside: (s) => ({ employeeId: s.outsiderB.employeeId, ...span(1) }),
  },
  // 轮岗部门在范围内、员工在范围外：只有员工条件能挡住
  'work-shifts': {
    path: '/work-shifts',
    inside: (s, n) => ({ employeeId: s.w.employee.employeeId, orgId: s.w.dept, ...span(n) }),
    outside: (s) => ({ employeeId: s.outsiderB.employeeId, orgId: s.w.dept, ...span(1) }),
  },
  tutorships: {
    path: '/tutorships',
    inside: (s, n) => ({
      tutorEmployeeId: s.w.manager.employeeId,
      tuteeEmployeeId: s.w.employee.employeeId,
      ...span(n),
    }),
    outside: (s) => ({
      tutorEmployeeId: s.w.manager.employeeId,
      tuteeEmployeeId: s.outsiderB.employeeId,
      ...span(1),
    }),
  },
};

async function make(w: PlanWorld, path: string, body: Record<string, unknown>) {
  return (await w.ok<{ id: string }>(await w.http(w.hrUser, 'POST', `${IDP}${path}`, { ifMatch: 0, body }), 201)).id;
}

const listOf = async (s: Scene, query: string) => {
  const response = await s.hr.request('GET', query);
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return { text, items: (JSON.parse(text) as { items: { id: string }[] }).items };
};

describe.each(Object.entries(KINDS))('F-185 P2-1：%s 的员工范围条件', (name, kind) => {
  it('列表、employeeId 筛选、分页、详情对范围外员工的记录一致不可见', async () => {
    const s = await scene(`f185-scope-${name}`);
    // 范围外的记录开始日最早，排在最前：若泄漏，会占据第 1 页
    const outside = await make(s.w, kind.path, { ...kind.outside(s) });
    const inside = [await make(s.w, kind.path, kind.inside(s, 2)), await make(s.w, kind.path, kind.inside(s, 3))];

    const all = await listOf(s, kind.path);
    expect(all.items.map((i) => i.id)).toEqual(inside);
    expect(all.text).not.toContain(outside);
    expect(all.text).not.toContain(s.outsiderB.employeeId);

    const pages: string[] = [];
    for (const page of [1, 2, 3]) {
      pages.push(...(await listOf(s, `${kind.path}?pageSize=1&page=${page}`)).items.map((i) => i.id));
    }
    expect(pages).toEqual(inside);

    const personField = name === 'tutorships' ? 'tuteeEmployeeId' : 'employeeId';
    const filtered = await listOf(s, `${kind.path}?employeeId=${s.outsiderB.employeeId}`);
    expect(filtered.items, personField).toEqual([]);
    expect(filtered.text).not.toContain(outside);

    expect((await s.hr.request('GET', `${kind.path}/${outside}`)).status).toBe(404);
    expect((await s.hr.request('GET', `${kind.path}/${inside[0]}`)).status).toBe(200);
  });
});

describe('F-185 P2-1：职业发展列表不披露范围外员工的任职快照', () => {
  it('范围外员工已有的“当前”职级 / 职务 / 职务名称不出现在列表里', async () => {
    const s = await scene('f185-scope-snapshot');
    const post = await s.w.ok<{ id: string }>(
      await s.w.http(s.w.hrUser, 'POST', '/api/tenant/job/posts', {
        ifMatch: 0,
        body: { code: crypto.randomUUID(), name: '范围外专属职务', startDate: '2020-01-01' },
      }),
      201,
    );
    const hidden = await s.w.person('带职务的范围外员工', s.otherDept, { postId: post.id });
    await make(s.w, '/careers', { employeeId: hidden.employeeId, ...span(1) });
    await make(s.w, '/careers', { employeeId: s.w.employee.employeeId, ...span(2) });

    for (const query of ['/careers', `/careers?employeeId=${hidden.employeeId}`]) {
      const { text } = await listOf(s, query);
      for (const leaked of [post.id, '范围外专属职务', hidden.employeeId]) expect(text, query).not.toContain(leaked);
    }
  });
});
