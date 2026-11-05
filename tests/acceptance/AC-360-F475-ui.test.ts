import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hidden: [] as string[],
  paths: [] as string[],
  data: {} as Record<string, unknown>,
  denied: '',
}));
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({
    snapshot: {
      objects: Object.fromEntries(
        ['Activity', 'Questionnaire', 'Relation', 'Result', 'Settings']
          .filter((key) => key !== state.denied)
          .map((key) => [`Survey360.${key}`, {}]),
      ),
    },
    field: (key: string) => ({ visible: !state.hidden.includes(key), editable: false }),
    can: () => false,
  }),
}));
vi.mock('../../apps/web/src/evaluation/runtime.js', () => ({
  useRead: (path?: string) => {
    if (path) state.paths.push(path);
    return { data: state.data[path ?? ''] ?? { items: [] }, loading: false, reload() {} };
  },
  Failure: () => null,
  RemoteSelect: () => null,
}));
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
const { SurveyList } = await import(resolve('apps/web/src/survey360/SurveyPage.tsx'));
const { Relations } = await import(resolve('apps/web/src/survey360/Relations.tsx'));
const headers = (html: string) =>
  [...(html.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/)?.[0] ?? '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) =>
      match[1]!
        .replace(/<[^>]*>/g, '')
        .replace(/&[^;]+;/g, '')
        .trim(),
    )
    .filter(Boolean);
beforeEach(() => {
  state.hidden = [];
  state.paths = [];
  state.data = {};
  state.denied = '';
});

describe('AC-360 F-475 列表界面对齐', () => {
  it('活动列、宽度、状态视图和筛选，不再显示简化列', () => {
    const html = render(h(SurveyList, { kind: 'activities' }));
    expect(headers(html)).toEqual([
      '关注',
      '活动名称',
      '评价对象人数',
      '评价者人数',
      '应用场景',
      '创建人',
      '创建时间',
      '作答进度',
      '状态',
      '操作',
      '⚙',
    ]);
    for (const width of [60, 266, 98, 86, 116, 110, 186, 62, 122, 26]) expect(html).toContain(`width:${width}px`);
    for (const name of ['已关注', '活动名称', '应用场景', '创建人', '创建时间']) expect(html).toContain(name);
    expect(html).not.toContain('启用时间');
  });
  it('企业自定义题库保留其自己的列与缺契约披露', () => {
    const html = render(h(SurveyList, { kind: 'templates' }));
    expect(headers(html)).toEqual([
      '套卷模板名称',
      '创建人',
      '共享部门',
      '共享人',
      '套卷模板类别',
      '备注',
      '创建时间',
      '更新时间',
      '操作',
      '⚙',
    ]);
    expect(html).toContain('width:147px');
    expect(html).toContain('未完成');
  });
  it('评价对象列表按人员信息、所用套卷和评价者呈现，未验证子页不可伪造', () => {
    const html = render(h(Relations, { activityId: 'synthetic' }));
    expect(headers(html)).toEqual(['评价对象', '邮箱', '部门', '职位', '所用套卷', '评价者', '⚙']);
    expect(html).toContain('评价关系确认者');
    expect(html).toContain('width:241px');
    expect(state.paths).toContain('/api/tenant/survey360/activities/synthetic/objects');
  });
  it('字段被裁剪后对应列与筛选不可见', () => {
    state.hidden = ['name', 'scene', 'status'];
    const html = render(h(SurveyList, { kind: 'activities' }));
    expect(headers(html)).not.toContain('活动名称');
    expect(headers(html)).not.toContain('应用场景');
    expect(headers(html)).not.toContain('状态');
    expect(html).not.toContain('aria-label="应用场景"');
  });
});

const { ReadingPanel, ActivityBasic } = await import(resolve('apps/web/src/survey360/ReadingPanels.tsx'));
const { RoleSettings } = await import(resolve('apps/web/src/survey360/RoleSettings.tsx'));
const { surveyReceipt } = await import(resolve('apps/web/src/survey360/useSurveyForm.ts'));
describe('AC-360 F475 新分区的真实返回形态', () => {
  it.each([
    [
      'progress',
      ['评价者', '邮箱', '部门', '职位', '状态', '最后发送时间', '进度', '忽略任务数', '邮件到达状态', '操作', '⚙'],
    ],
    ['data', ['评价对象', '邮箱', '部门', '职位', '操作', '⚙']],
    ['reports', ['所属评价对象', '邮箱', '套卷', '套卷类别', '所属报告模板', '部门', '职位', '操作', '⚙']],
  ])('%s 列序', (kind, expected) => {
    const html = render(h(ReadingPanel, { activityId: 'synthetic', kind }));
    expect(headers(html)).toEqual(expected);
  });
  it('总进度使用信封，不能将当前明细全完成误报为 100%', () => {
    state.data['/api/tenant/survey360/activities/synthetic/progress'] = {
      total: { completed: 1, all: 2 },
      items: [{ personId: 'synthetic', name: '合成评价者', status: 'completed', progress: { done: 3, total: 3 } }],
    };
    const html = render(h(ReadingPanel, { activityId: 'synthetic', kind: 'progress' }));
    expect(html).toContain('50%');
    expect(html).toContain('3/3');
    expect(html).toContain('已完成');
  });
  it('无进程权限不发读取；裁剪进度后不显示总进度', () => {
    state.denied = 'Relation';
    render(h(ReadingPanel, { activityId: 'synthetic', kind: 'progress' }));
    expect(state.paths).toEqual([]);
    state.denied = '';
    state.hidden = ['progress'];
    const html = render(h(ReadingPanel, { activityId: 'synthetic', kind: 'progress' }));
    expect(html).not.toContain('总进度');
    expect(headers(html)).not.toContain('进度');
  });
  it('角色列表使用接口顺序，不从截图补六条内置人员信息', () => {
    state.data['/api/tenant/survey360/roles'] = { items: [{ id: 'synthetic', name: '合成角色', sort: 7 }] };
    const html = render(h(RoleSettings));
    expect(headers(html)).toEqual([
      '评价角色名称',
      '顺序',
      '创建人',
      '创建时间',
      '最新修改人',
      '最新修改时间',
      '操作',
      '⚙',
    ]);
    expect(html).toContain('合成角色');
    expect(html).toContain('共1条');
  });
  it('活动授权使用 authorized 与 names 信封，不展示未授权候选人', () => {
    state.data['/api/tenant/survey360/activities/synthetic/grants'] = {
      authorized: [{ userId: 'allowed' }],
      unauthorized: [{ userId: 'other' }],
      names: { allowed: '合成已授权', other: '合成未授权' },
    };
    const html = render(h(ActivityBasic, { row: { id: 'synthetic', revision: 1, name: '合成活动' } }));
    expect(html).toContain('合成已授权');
    expect(html).not.toContain('合成未授权');
    expect(headers(html)).toEqual(['用户名称', '部门', '职位', '身份']);
  });
  it('回执按实际提交的版本判断；旧版、错对象与缺版本均不能当成功', () => {
    expect(surveyReceipt({ id: 'a', revision: 6 }, 5, 'a')).toEqual({ id: 'a', revision: 6 });
    for (const result of [{ id: 'a', revision: 5 }, { id: 'b', revision: 6 }, { id: 'a' }])
      expect(() => surveyReceipt(result, 5, 'a')).toThrow();
  });
});
