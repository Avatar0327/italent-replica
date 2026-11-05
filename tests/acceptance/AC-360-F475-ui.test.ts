import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ hidden: [] as string[], paths: [] as string[] }));
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({
    snapshot: {
      objects: Object.fromEntries(
        ['Activity', 'Questionnaire', 'Relation', 'Result', 'Settings'].map((key) => [`Survey360.${key}`, {}]),
      ),
    },
    field: (key: string) => ({ visible: !state.hidden.includes(key), editable: false }),
    can: () => false,
  }),
}));
vi.mock('../../apps/web/src/evaluation/runtime.js', () => ({
  useRead: (path?: string) => {
    if (path) state.paths.push(path);
    return { data: { items: [] }, loading: false, reload() {} };
  },
  Failure: () => null,
  RemoteSelect: () => null,
}));
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
const { SurveyList } = await import('../../apps/web/src/survey360/SurveyPage.js');
const { Relations } = await import('../../apps/web/src/survey360/Relations.js');
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
    ]);
    expect(html).toContain('width:147px');
    expect(html).toContain('未完成');
  });
  it('评价对象列表按人员信息、所用套卷和评价者呈现，未验证子页不可伪造', () => {
    const html = render(h(Relations, { activityId: 'synthetic' }));
    expect(headers(html)).toEqual(['评价对象', '邮箱', '部门', '职位', '所用套卷', '评价者']);
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
