/// <reference lib="dom" />
// @vitest-environment happy-dom
/**
 * F-474-4c 前端（DEC-776 / DEC-836）：组织员工 → 人员信息 → 全部人员。
 * 接口夹具取 support/f474-all-people-row.ts（后端验收断言真实响应键集与它一致），
 * 列序 / 宽度 / 默认筛选手写自 codex-R1bd spec §2.3。
 */
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock } from 'vitest';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { act, allFields, h, uiHarness } from './support/f474-ui.js';
import { ALL_PEOPLE_COLUMNS, ALL_PEOPLE_PAGE, ALL_PEOPLE_ROW } from './support/f474-all-people-row.js';

const LIST = '/api/tenant/employment/all-people';
let ui: ReturnType<typeof uiHarness>;
beforeEach(() => {
  ui = uiHarness();
});
afterEach(async () => ui.close());
const page = async () => (await import(resolve('apps/web/src/all-people/AllPeoplePage.tsx'))).AllPeoplePage;
const calls = () => (globalThis.fetch as Mock).mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
const listCalls = () => calls().filter((url) => url.pathname === LIST);
/**
 * 员工筛选（PersonSelect）挂载 200ms 后会向同一接口发 pageSize=20 的候选搜索（AllPeoplePage.tsx CANDIDATE_SIZE），
 * 与表格请求的先后取决于机器快慢；断言表格查询时只取表格请求（DEC-771 并入：计时竞态）。
 */
const CANDIDATE_SIZE = '20';
const tableCalls = () => listCalls().filter((url) => url.searchParams.get('pageSize') !== CANDIDATE_SIZE);
/** 任职记录侧筛选字段要显式给查看权，否则按字段权隐藏对应筛选。 */
const fields = [...allFields, 'employmentForm', 'serviceType', 'idType', 'idNumber', 'age', 'level'];
const without = (...hidden: string[]) => fields.filter((field) => !hidden.includes(field));
const body = (columnKeys?: readonly string[]) => ({
  ...ALL_PEOPLE_PAGE,
  columns: ALL_PEOPLE_COLUMNS.filter((column) => !columnKeys || columnKeys.includes(column.key)),
});

describe('AC-EMP F-474-4c 全部人员页面', () => {
  it('入口登记在 调动管理（人员）应用下，按任职记录对象的查看权出现，不挂人事分析', () => {
    const entry = PAGES.entries.find((item) => item.id === 'all-people');
    expect(entry).toMatchObject({
      app: 'transfer',
      label: '全部人员',
      objectCode: 'TenantBase.EmploymentRecord',
      path: '/all-people',
    });
  });

  it('列序与宽度来自原站：复选 + 16 列，没有操作列', async () => {
    await ui.render(h(await page()), '/', fields, { [LIST]: body() });
    expect(ui.headers()).toEqual(['', ...ALL_PEOPLE_COLUMNS.map((column) => column.label)]);
    expect(ui.widths().slice(-16)).toEqual(
      [140, 200, 140, 140, 140, 140, 140, 140, 140, 130, 105, 172, 140, 140, 140, 172].map((width) => `${width}px`),
    );
  });

  it('默认筛选：人员状态 试用 + 正式、任职类型 主职，每页 15 条', async () => {
    await ui.render(h(await page()), '/', fields, { [LIST]: body() });
    expect(Object.fromEntries(tableCalls().at(-1)!.searchParams)).toEqual({
      page: '1',
      pageSize: '15',
      employeeStatus: '2,3',
      serviceType: 'primary',
    });
  });

  it('行取值：照后端返回显示，空值显示占位，共 N 条', async () => {
    const row = { ...ALL_PEOPLE_ROW, orgLevel3: null, level: null };
    await ui.render(h(await page()), '/', fields, { [LIST]: { ...body(), items: [row] } });
    const cells = Array.from(ui.host.querySelectorAll('tbody tr:not([aria-hidden]) td')).map((c) => c.textContent);
    expect(cells.slice(1)).toEqual([
      '合成员工甲',
      'syn4c1@example.com',
      'SYN-4C-1',
      '合成集团',
      '合成研发部',
      '—',
      '合成后端组',
      '—',
      '合成后端工程师',
      '合成经理乙',
      '2025-07-01',
      '1.2',
      '男',
      '合成证件类型',
      'SYN-ID-0001',
      '36',
    ]);
    expect(ui.host.textContent).toContain('共1条');
  });

  it('列以后端返回的 columns 为准：无字段权的列整列不出现（不靠前端猜）', async () => {
    const keys = ALL_PEOPLE_COLUMNS.map((column) => column.key).filter((key) => key !== 'idNumber' && key !== 'email');
    const row = Object.fromEntries(
      Object.entries(ALL_PEOPLE_ROW).filter(([key]) => keys.includes(key as never) || key === 'employeeId'),
    );
    await ui.render(h(await page()), '/', fields, { [LIST]: { ...body(keys), items: [row] } });
    expect(ui.headers()).not.toContain('证件号码');
    expect(ui.headers()).not.toContain('邮箱');
    expect(ui.headers()).toContain('证件类型');
    expect(ui.host.textContent).not.toContain('SYN-ID-0001');
  });

  it('筛选随字段权：邮箱 / 人员状态 / 用工形式 / 雇佣关系 / 任职类型字段不可见则无该筛选，也不带该参数', async () => {
    await ui.render(h(await page()), '/', fields, { [LIST]: body() });
    for (const label of ['员工', '姓名', '邮箱', '用工形式', '雇佣关系', '任职类型', '人员状态'])
      expect(ui.host.querySelector(`[aria-label="${label}"]`), label).not.toBeNull();
    await ui.close();
    ui = uiHarness();
    await ui.render(
      h(await page()),
      '/',
      without('email', 'employeeStatus', 'employmentForm', 'employType', 'serviceType'),
      {
        [LIST]: body(),
      },
    );
    for (const label of ['邮箱', '人员状态', '用工形式', '雇佣关系', '任职类型'])
      expect(ui.host.querySelector(`[aria-label="${label}"]`), label).toBeNull();
    const query = Object.fromEntries(tableCalls().at(-1)!.searchParams);
    expect(query).toEqual({ page: '1', pageSize: '15' });
  });

  it('可见员工超过 1000 人时，员工筛选走服务端搜索，选中后带该员工的 employeeId', async () => {
    const people = Array.from({ length: 1201 }, (_, index) => ({
      employeeId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      employeeName: `合成员工${String(index + 1).padStart(4, '0')}`,
      name: `合成员工${String(index + 1).padStart(4, '0')}`,
    }));
    // 与后端一致：name 子串匹配，page / pageSize 分页，total 为命中总数
    const search = (url: URL) => {
      const name = url.searchParams.get('name');
      const hits = name ? people.filter((person) => person.employeeName.includes(name)) : people;
      const size = Number(url.searchParams.get('pageSize'));
      const no = Number(url.searchParams.get('page'));
      return { ...body(), items: hits.slice((no - 1) * size, no * size), total: hits.length };
    };
    await ui.render(h(await page()), '/', fields, {
      [LIST]: search,
      '/api/tenant/personnel/employees': search,
    });
    const input = ui.host.querySelector<HTMLInputElement>('input[aria-label="员工"]')!;
    const type = async (text: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
    };
    await type('合成员工1201');
    const option = Array.from(document.body.querySelectorAll<HTMLElement>('.ant-select-item-option')).find((item) =>
      item.textContent?.includes('合成员工1201'),
    );
    expect(option, '第 1201 名员工应能搜索到并选择').toBeTruthy();
    await act(async () => {
      option!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const picked = listCalls().filter((url) => url.searchParams.has('employeeId'));
    expect(picked.at(-1)!.searchParams.get('employeeId')).toBe(people[1200]!.employeeId);
  });

  it('无数据范围时给出无权限空态', async () => {
    await ui.render(h(await page()), '/', fields, {
      [LIST]: { ...body(), items: [], total: 0, hasDataPermission: false },
    });
    expect(ui.host.textContent).toContain('当前没有可查看的数据范围');
  });

  it('查询串：状态多选逗号拼接、筛选项原样带出、不可见字段的筛选被丢弃、翻页保留筛选', async () => {
    const { allPeoplePath, allowedFilters, defaultFilters } = await import(resolve('apps/web/src/all-people/model.ts'));
    const q = (filters: object, pageNo = 1) =>
      Object.fromEntries(new URL(allPeoplePath(filters, { page: pageNo, pageSize: 15 }), 'http://x').searchParams);
    expect(q(defaultFilters)).toEqual({ page: '1', pageSize: '15', employeeStatus: '2,3', serviceType: 'primary' });
    expect(
      q({ ...defaultFilters, employeeStatus: [3, 8], name: ' 张 ', email: 'a@example.com', employType: 'intern' }, 2),
    ).toEqual({
      page: '2',
      pageSize: '15',
      employeeStatus: '3,8',
      serviceType: 'primary',
      name: '张',
      email: 'a@example.com',
      employType: 'intern',
    });
    expect(q({ ...defaultFilters, employmentForm: 'full_time', employeeId: 'E1' })).toMatchObject({
      employmentForm: 'full_time',
      employeeId: 'E1',
    });
    const visible = (field: string) => !['email', 'employeeStatus', 'serviceType'].includes(field);
    expect(allowedFilters({ ...defaultFilters, email: 'a', name: '张' }, visible)).toEqual({ name: '张' });
  });
});
