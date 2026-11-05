import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: '',
  hidden: [] as string[],
  readonly: [] as string[],
  rows: [] as Record<string, unknown>[],
}));
const requireWeb = createRequire(resolve('apps/web/package.json'));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup: render } = requireWeb('react-dom/server');
const { MemoryRouter } = requireWeb('react-router');
vi.mock('../../apps/web/src/foundation/DecisionNote.js', () => ({ DecisionNote: () => null }));
vi.mock('../../apps/web/src/evaluation/CreateEntry.js', () => ({
  CreateCommands: ({ children }: { children: unknown }) => children,
  CreateEntry: ({ children }: { children: unknown }) => children,
}));
vi.mock('../../apps/web/src/foundation/Permissions.js', () => ({
  usePermissions: () => ({
    loading: false,
    snapshot: {
      objects: Object.fromEntries(
        ['EvaluationActivity', 'StaffEvaluationData', 'EvaluationForm', 'ReviewGroup'].map((name) => [
          `TEvaluation.${name}`,
          { dataOperations: { view: true, update: true, create: true } },
        ]),
      ),
    },
    can: () => true,
    field: (key: string) => ({
      visible: !state.hidden.includes(key),
      editable: !state.hidden.includes(key) && !state.readonly.includes(key),
    }),
  }),
}));
vi.mock('../../apps/web/src/evaluation/runtime.js', () => ({
  useRead: (path?: string) => ({
    data: !path
      ? undefined
      : path.includes('/synthetic')
        ? state.rows[0]
        : { items: state.rows, total: state.rows.length },
    reload() {},
    loading: false,
  }),
  Failure: () => null,
  RemoteSelect: ({ label }: { label: string }) => h('span', null, label),
}));
vi.mock('../../apps/web/src/evaluation/useEvaluationForm.js', () => ({
  useEvaluationForm: (_path: string, row: unknown) => ({ current: row, locked: false, busy: false }),
}));
const { EvaluationPage } = await import(resolve('apps/web/src/evaluation/EvaluationPage.tsx'));
const { ActivityWizard } = await import(resolve('apps/web/src/evaluation/ActivityWizard.tsx'));
const headers = (html: string) =>
  [...(html.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/)?.[0] ?? '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((m) =>
      m[1]!
        .replace(/<[^>]*>/g, '')
        .replace(/&[^;]+;/g, '')
        .trim(),
    )
    .filter((text) => text && text !== '⚙');
const page = (query: string) => {
  state.query = query;
  return render(h(MemoryRouter, { initialEntries: [`/evaluation?${query}`] }, h(EvaluationPage)));
};
beforeEach(() => {
  state.query = '';
  state.hidden = [];
  state.readonly = [];
  state.rows = [{ id: 'synthetic', revision: 1, name: '合成评定', status: 'draft', enabled: true, members: [] }];
});

describe('AC-EV F-475 独立页面及列表结构', () => {
  it.each([
    [
      'process&activity=synthetic',
      ['人员', '部门', '原类别', '申请类别', '原级别', '申请级别', '状态', '最终结果', '累计工龄（年）'],
    ],
    [
      'process&activity=synthetic&stage=apply',
      ['人员', '部门', '申报日期', '原类别', '申请类别', '原级别', '申请级别', '状态', '操作'],
    ],
    ['records', ['人员', '部门', '入职日期', '申请类别', '申请级别', '生效日期', '状态', '操作']],
    ['forms', ['名称', '所属组织', '状态', '创建人', '操作']],
    ['groups', ['名称', '所属组织', '人数', '组长', '成员', '状态', '操作']],
  ])('%s 为独立列表，列顺序完整', (view, expected) => {
    expect(headers(page(`view=${view}`))).toEqual(expected);
  });
  it('活动列宽和筛选入口对齐，状态不用标签块', () => {
    const html = page('view=activities');
    expect(headers(html)).toEqual(['名称', '年度', '周期', '状态', '所属组织', '报名人数', '负责人', '操作']);
    for (const width of [173, 113, 174, 114, 132, 164]) expect(html).toContain(`width:${width}px`);
    for (const name of ['名称', '状态', '周期', '年度']) expect(html).toContain(`aria-label="${name}"`);
    expect(html).not.toContain('ant-tag');
  });
  it('评价表默认启用筛选和宽度，清空入口存在', () => {
    const html = page('view=forms');
    expect(html).toContain('width:268px');
    expect(html).toContain('清空已选');
    expect(html).toContain('aria-label="状态"');
  });
  it('人员字段裁剪后仍保留行，不显示或过滤该字段', () => {
    state.hidden = ['employeeId'];
    const html = page('view=records');
    expect(headers(html)).not.toContain('人员');
    expect(html).not.toContain('aria-label="人员"');
    expect(html).toContain('data-row-key="synthetic"');
  });
  it('过程页不拿当前分页凑阶段总数，不显示合成流程', () => {
    const html = page('view=process&activity=synthetic');
    expect(html).toContain('全部人员');
    expect(html).toContain('资格申报');
    expect(html).not.toContain('独立合成流程');
  });
});

describe('AC-EV F-475 整页表单容器', () => {
  it('只读名称与规则枚举同名时仍显示原名，只有规则字段翻译', () => {
    state.readonly = ['name'];
    state.rows = [{ id: 'synthetic', revision: 1, name: 'by_indicator', scoreMode: 'by_indicator', items: [] }];
    const html = page('view=forms&edit=synthetic');
    expect(html).toContain('>by_indicator</span>');
    expect(html).toContain('按指标评分');
  });
  it('活动向导为整页，第一步有三组和固定底栏', () => {
    const html = render(h(ActivityWizard, { row: state.rows[0], close() {}, saved() {} }));
    expect(html).toContain('evaluation-full-page');
    for (const title of ['基本信息', '适用范围', '其他设置', '下一步']) expect(html).toContain(title);
    expect(html).toContain('evaluation-footer');
    expect(html).not.toContain('role="dialog"');
  });
  it('评价表编辑为独立整页，有评价区和评分项表格', () => {
    state.rows = [{ id: 'synthetic', revision: 1, name: '合成评价表', scoreMode: 'by_indicator', items: [] }];
    const html = page('view=forms&edit=synthetic');
    for (const title of ['编辑评价表', '员工信息区', '评价区', '评价结果区', '打分规则']) expect(html).toContain(title);
    expect(html).toContain('evaluation-full-page');
    expect(html).not.toContain('role="dialog"');
  });
});

describe('AC-EV F-475 P2-2 投票参考评分规则', () => {
  beforeEach(() => {
    state.rows = [
      {
        id: 'synthetic',
        revision: 1,
        name: '合成投票参考表',
        scoreMode: 'by_vote',
        indicatorReference: true,
        fullScore: 120,
        passScore: 72,
        totalRule: 'average',
        votePassRatio: 60,
        items: [],
      },
    ];
  });
  it('实际存在的满分、通过分数及总分计算方式只读显示，不按投票模式隐藏', () => {
    const html = page('view=forms&edit=synthetic');
    for (const label of ['满分', '通过分数', '评委总分计算方式']) expect(html).toContain(label);
    for (const value of ['120', '72', '平均分']) expect(html).toContain(`>${value}</span>`);
    for (const key of ['fullScore', 'passScore', 'totalRule']) expect(html).not.toContain(`id="${key}"`);
  });
  it('规则字段被裁剪时不显示标签或值，仍保留允许读取的投票规则', () => {
    state.hidden = ['fullScore', 'passScore', 'totalRule'];
    const html = page('view=forms&edit=synthetic');
    for (const label of ['满分', '通过分数', '评委总分计算方式']) expect(html).not.toContain(label);
    for (const value of ['120', '72', '平均分']) expect(html).not.toContain(`>${value}</span>`);
    expect(html).toContain('>60</span>');
  });
});
