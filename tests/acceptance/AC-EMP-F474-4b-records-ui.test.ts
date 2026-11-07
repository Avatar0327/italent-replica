/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-474-4b #16 前端（DEC-776，DEC-489）：组织员工 → 任职管理 → 任职记录。
 * 接口夹具取 support/f474-records-row.ts（后端验收断言真实响应键集与它一致），列序 / 宽度 / 默认筛选手写自 codex-R1bd spec §2.4。
 */
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { act, allFields, h, uiHarness } from './support/f474-ui.js';
import { RECORD_ROW } from './support/f474-records-row.js';

const LIST = '/api/tenant/employment/records';
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const page = async () =>
  (await import(resolve('apps/web/src/employment-records/EmploymentRecordsPage.tsx'))).EmploymentRecordsPage;
const calls = () => (globalThis.fetch as Mock).mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
const listCalls = () => calls().filter((url) => url.pathname === LIST);
/** 任职记录字段（isCurrent / serviceType / departmentId）要显式给查看权，否则按字段权隐藏对应列与筛选。 */
const recordFields = [...allFields, 'isCurrent', 'serviceType', 'departmentId'];
const withoutField = (...hidden: string[]) => recordFields.filter((field) => !hidden.includes(field));
/** 后端按字段权裁剪后的行：不可见的键整体缺席（形状同后端响应，只删键不造值）。 */
const rowWithout = (...keys: string[]) =>
  Object.fromEntries(Object.entries(RECORD_ROW).filter(([key]) => !keys.includes(key)));

describe('AC-EMP F-474-4b #16 任职记录列表页面', () => {
  it('入口登记在 调动管理（任职管理）应用下，按任职记录对象的查看权出现', () => {
    const entry = PAGES.entries.find((item) => item.id === 'employment-records');
    expect(entry).toMatchObject({
      app: 'transfer',
      label: '任职记录',
      objectCode: 'TenantBase.EmploymentRecord',
      path: '/employment-records',
    });
  });

  it('列序与宽度：复选 / 姓名 / 工号 / 任职类型 / 任职机构 / 一二三级组织 / 任职部门 / 操作', async () => {
    await ui.render(h(await page()), '/', recordFields, { [LIST]: { items: [RECORD_ROW], total: 1 } });
    expect(ui.headers()).toEqual([
      '',
      '姓名',
      '工号',
      '任职类型',
      '任职机构',
      '一级组织',
      '二级组织',
      '三级组织',
      '任职部门',
      '操作',
    ]);
    // 原站宽度 140 × 8、操作 164（复选列宽由表格内核决定）
    expect(ui.widths().slice(-9)).toEqual(Array(8).fill('140px').concat('164px'));
  });

  it('默认筛选：任职中 + 生效 + 当前生效 = 是，每页 30 条', async () => {
    await ui.render(h(await page()), '/', recordFields, { [LIST]: { items: [RECORD_ROW], total: 1 } });
    // 对象权限读到之前字段不可见，筛选先不带；读到后按字段权补上，以最后一次请求为准
    const query = listCalls().at(-1)!.searchParams;
    expect(Object.fromEntries(query)).toEqual({
      page: '1',
      pageSize: '30',
      employeeStatus: 'working',
      approvalState: 'effective',
      current: 'true',
    });
  });

  it('行取值：主职、机构全称、各级组织与部门；缺级显示占位', async () => {
    await ui.render(h(await page()), '/', recordFields, { [LIST]: { items: [RECORD_ROW], total: 1 } });
    const cells = Array.from(ui.host.querySelectorAll('tbody tr:not([aria-hidden]) td')).map((c) => c.textContent);
    expect(cells.slice(1, 9)).toEqual([
      '合成员工甲',
      'SYN-4B-1',
      '主职',
      '合成租户/合成集团/合成销售部',
      '合成集团',
      '合成销售部',
      '—',
      '合成销售部',
    ]);
    expect(ui.host.textContent).toContain('共1条');
  });

  it('字段权：部门字段不可见则机构类列消失且不带部门筛选；员工状态不可见则默认状态筛选不发出', async () => {
    const { departmentId: _d, ...bare } = RECORD_ROW.fields;
    const row = { ...RECORD_ROW, fields: bare } as Record<string, unknown>;
    for (const key of ['orgCode', 'orgFullName', 'departmentName', 'orgLevels']) delete row[key];
    await ui.render(h(await page()), '/', withoutField('departmentId', 'employeeStatus'), {
      [LIST]: { items: [row], total: 1 },
    });
    expect(ui.headers()).toEqual(['', '姓名', '工号', '任职类型', '操作']);
    const query = Object.fromEntries(listCalls().at(-1)!.searchParams);
    expect(query).not.toHaveProperty('employeeStatus');
    expect(query).not.toHaveProperty('departmentId');
  });

  it('是否当前生效字段不可见：无该筛选，请求不带 current，也不带默认值（审查 R1 P2-1）', async () => {
    await ui.render(h(await page()), '/', withoutField('isCurrent'), {
      [LIST]: { items: [rowWithout('isCurrent')], total: 1 },
    });
    expect(ui.host.querySelector('[aria-label="是否当前生效"]')).toBeNull();
    const query = Object.fromEntries(listCalls().at(-1)!.searchParams);
    expect(query).not.toHaveProperty('current');
    expect(query).toMatchObject({ employeeStatus: 'working', approvalState: 'effective' });
  });

  it('任职类型字段不可见：无该列也无类型筛选；可见时显示“主职”（审查 R1 P2-2）', async () => {
    await ui.render(h(await page()), '/', withoutField('serviceType'), {
      [LIST]: { items: [rowWithout('serviceType')], total: 1 },
    });
    expect(ui.headers()).not.toContain('任职类型');
    expect(ui.host.querySelector('[aria-label="任职类型"]')).toBeNull();
    expect(ui.host.textContent).not.toContain('主职');
    await ui.close();
    ui = uiHarness();
    await ui.render(h(await page()), '/', recordFields, { [LIST]: { items: [RECORD_ROW], total: 1 } });
    expect(ui.headers()).toContain('任职类型');
    expect(ui.host.querySelector('[aria-label="任职类型"]')).not.toBeNull();
    expect(ui.host.textContent).toContain('主职');
  });

  it('无数据范围时给出无权限空态；“编辑任职”打开员工档案的任职记录页签', async () => {
    await ui.render(h(await page()), '/', recordFields, { [LIST]: { items: [], total: 0, hasDataPermission: false } });
    expect(ui.host.textContent).toContain('当前没有可查看的数据范围');
    await ui.close();
    ui = uiHarness();
    await ui.render(h(await page()), '/', recordFields, { [LIST]: { items: [RECORD_ROW], total: 1 } });
    const edit = Array.from(ui.host.querySelectorAll('button')).find((b) => b.textContent === '编辑任职')!;
    await act(async () => edit.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(calls().some((url) => url.pathname === `/api/tenant/personnel/employees/${RECORD_ROW.employeeId}`)).toBe(
      true,
    );
    const active = document.querySelector('.ant-tabs-tab-active')?.textContent;
    expect(active).toBe('任职记录');
  });

  it('人员信息查看被拒（403）时，“编辑任职”仍打开档案并落在任职记录页签，内容照常读出（审查 R1 P2-3）', async () => {
    const own = `/api/tenant/employment/employees/${RECORD_ROW.employeeId}/records`;
    await ui.render(h(await page()), '/', [...recordFields, 'kind', 'effectiveDate'], {
      [LIST]: { items: [RECORD_ROW], total: 1 },
      [own]: { items: [RECORD_ROW], total: 1 },
    });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (raw: string) =>
      new URL(raw, 'http://localhost').pathname === `/api/tenant/personnel/employees/${RECORD_ROW.employeeId}`
        ? Response.json({ error: { code: 'FORBIDDEN', message: '无权查看人员信息' } }, { status: 403 })
        : real(raw),
    );
    const edit = Array.from(ui.host.querySelectorAll('button')).find((b) => b.textContent === '编辑任职')!;
    await act(async () => edit.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(document.querySelector('.ant-tabs-tab-active')?.textContent).toBe('任职记录');
    expect(document.querySelector('.staff-records')?.textContent).toContain('调动');
    // 人员信息页签按 403 处理：切过去是错误态，不是空白，也没有残留档案
    const profile = Array.from(document.querySelectorAll<HTMLElement>('.ant-tabs-tab')).find(
      (t) => t.textContent === '人员信息',
    )!;
    await act(async () => profile.click());
    expect(document.querySelector('.ant-drawer .ant-tabs-tabpane-active')?.textContent).toContain('暂无访问权限');
  });

  it('筛选查询串：不限不发；部门含下级默认不发、取消才发 false；不可见字段的筛选被丢弃', async () => {
    const { recordsPath, allowedFilters, defaultFilters } = await import(
      resolve('apps/web/src/employment-records/model.ts')
    );
    const q = (filters: object) =>
      Object.fromEntries(new URL(recordsPath(filters, { page: 2, pageSize: 30 }), 'http://x').searchParams);
    expect(q({ employeeStatus: 'all', current: 'all' })).toEqual({ page: '2', pageSize: '30' });
    expect(q({ current: 'no', employeeStatus: '8', name: ' 张 ', email: 'a@example.com' })).toEqual({
      page: '2',
      pageSize: '30',
      current: 'false',
      employeeStatus: '8',
      name: '张',
      email: 'a@example.com',
    });
    expect(q({ departmentId: 'D1' })).toMatchObject({ departmentId: 'D1' });
    expect(q({ departmentId: 'D1', includeChildren: false })).toMatchObject({
      departmentId: 'D1',
      includeChildren: 'false',
    });
    const hidden = (field: string) => field !== 'departmentId' && field !== 'email';
    expect(
      allowedFilters({ ...defaultFilters, departmentId: 'D1', includeChildren: false, email: 'a' }, hidden),
    ).toEqual(defaultFilters);
  });
});
