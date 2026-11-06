import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ hidden: [] as string[] }));
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({ field: (key: string) => ({ visible: !state.hidden.includes(key), editable: false }) }),
}));
vi.mock('../../apps/web/src/foundation/Session.js', () => ({ useApiClient: () => ({}) }));
const { ReviewList } = await import(resolve('apps/web/src/talent-review/ReviewList.tsx'));
const headers = (html: string) =>
  [...(html.match(/<thead[^>]*>([\s\S]*?)<\/thead>/)?.[1] ?? '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(
    (match) => match[1]!.replace(/<[^>]*>/g, ''),
  );
const props = {
  collection: 'projects',
  data: { items: [{ id: 'synthetic-project', name: '合成项目', status: 'new', revision: 1 }], total: 1 },
  loading: false,
  retry() {},
  open() {},
  actions: h('button', null, '新增'),
  rowActions: () => h('button', null, '编辑'),
};
beforeEach(() => {
  state.hidden = [];
});
describe('AC-TR F-475A 项目列表结构', () => {
  it('两视图并列显示，表头、复选列和齿轮完整，操作列不固定', () => {
    const html = render(h(ReviewList, props));
    expect(html).toContain('role="tab"');
    expect(html).toContain('已结束的盘点项目');
    expect(headers(html)).toEqual([
      '',
      '名称',
      '所属分类',
      '盘点场景',
      '所属组织',
      '盘点报告模板',
      '开始时间',
      '结束时间',
      '盘点年度',
      '盘点计算规则',
      '状态',
      '结果审批流程',
      '操作',
      '⚙',
    ]);
    expect(html).toContain('width:128px');
    expect(html).toContain('width:93px');
    expect(html).toContain('width:160px');
    expect(html).not.toContain('ant-table-cell-fix-right');
    expect(html).toContain('新增（步骤导航）');
    expect(html).not.toContain('导出');
  });
  it('隐藏状态时仅显示无状态过滤的授权集合，隐藏字段不出现列与筛选', () => {
    state.hidden = ['status', 'name', 'ownerOrgId'];
    const html = render(h(ReviewList, props));
    expect(html).toContain('全部盘点项目');
    expect(html).not.toContain('进行中的盘点项目');
    expect(html).not.toContain('已结束的盘点项目');
    expect(headers(html)).not.toContain('状态');
    expect(headers(html)).not.toContain('名称');
    expect(headers(html)).not.toContain('所属组织');
    expect(html).toContain('共1条');
  });
  it('只展示本页真实授权数据，无范围时提示范围为空', () => {
    const html = render(h(ReviewList, { ...props, data: { items: [], total: 0, hasDataPermission: false } }));
    expect(html).toContain('当前没有可查看的数据范围');
    expect(html).not.toContain('合成项目');
    expect(html).toContain('共0条');
  });
});

it('AC-TR F-475A 多选组织和分类只使用可见字段，空选择不筛掉记录', async () => {
  const { matchesFilters } = await import('../../apps/web/src/talent-review/model.js');
  const row = { id: 'p', ownerOrgId: 'org-a', categoryId: 'category-a' };
  const filters = { ownerOrgIds: ['org-b'], categoryId: 'category-b' };
  expect(matchesFilters(row, filters, () => true)).toBe(false);
  expect(matchesFilters(row, { ...filters, ownerOrgIds: ['org-a'], categoryId: 'category-a' }, () => true)).toBe(true);
  expect(matchesFilters(row, filters, () => false)).toBe(true);
  expect(matchesFilters(row, { ownerOrgIds: [] }, () => true)).toBe(true);
});
