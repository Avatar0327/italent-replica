import { describe, expect, it } from 'vitest';
import { IDP_OBJECTS } from '@italent/domain';
import { t } from '../../apps/web/src/idp/messages.js';
import { annotations } from '../../apps/web/src/annotations/index.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import {
  batchSplit,
  filterPlans,
  matchesFilters,
  nextStage,
  ownPlans,
  planActions,
  planInput,
  processInView,
  receiptSummary,
  statusText,
  subProcessAccess,
  taskActions,
  templateActions,
  templateInView,
} from '../../apps/web/src/idp/model.js';
import { moduleSettingSections, nodeLabeler } from '../../apps/web/src/idp/template-settings.js';
import type {
  ApprovalCandidate,
  PlanSummary,
  Process,
  Stage,
  SubProcess,
  Template,
  TemplateModule,
} from '../../apps/web/src/idp/types.js';

const stage = (seq: number, status: Stage['status']): Stage => ({
  id: `s${seq}`,
  subProcessId: 'sp',
  seq,
  name: `阶段${seq}`,
  status,
  dueDate: null,
  endedOn: null,
  failureReason: null,
  attemptCount: 0,
});
const plan = (status: PlanSummary['status'], extra: Partial<PlanSummary> = {}): PlanSummary => ({
  id: `p-${status}`,
  revision: 2,
  name: `计划-${status}`,
  employeeId: 'e1',
  templateId: 't1',
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  status,
  currentStageName: null,
  stages: [],
  ...extra,
});

describe('AC-FE-R3d2 发展计划前端规则', () => {
  it.each([
    ['not_started', ['update', 'delete', 'start', 'terminate']],
    ['running', ['update', 'delete', 'urge', 'jump', 'transfer', 'startNext', 'terminate']],
    ['ended', ['delete']],
    ['terminated', ['delete']],
  ] as const)('状态 %s 的操作取允许状态与后端按钮的交集', (status, expected) => {
    expect(planActions(plan(status), () => true)).toEqual(expected);
    expect(planActions(plan(status), () => false)).toEqual([]);
    expect(planActions(plan(status), (button) => button === 'delete')).toEqual(['delete']);
  });
  it('revision 缺失时不显示任何写操作', () => {
    expect(planActions(plan('running', { revision: undefined }), () => true)).toEqual([]);
  });
  it('页签按状态分组，名称与日期筛选在完整结果上进行', () => {
    const rows = [
      plan('not_started', { name: '甲计划' }),
      plan('running', { name: '乙计划', startDate: '2026-11-01' }),
      plan('ended'),
      plan('terminated'),
    ];
    expect(filterPlans(rows, 'active', {}).map((row) => row.status)).toEqual(['not_started', 'running']);
    expect(filterPlans(rows, 'ended', {}).map((row) => row.status)).toEqual(['ended']);
    expect(filterPlans(rows, 'terminated', {}).map((row) => row.status)).toEqual(['terminated']);
    expect(filterPlans(rows, 'active', { name: '乙' }).map((row) => row.name)).toEqual(['乙计划']);
    expect(filterPlans(rows, 'active', { startFrom: '2026-10-15' }).map((row) => row.name)).toEqual(['乙计划']);
    expect(filterPlans(rows, 'active', { status: 'not_started' }).map((row) => row.name)).toEqual(['甲计划']);
  });
  it('批量干预按规格过滤可执行的计划，其余列为跳过并说明', () => {
    const rows = [
      plan('running', { id: 'a', stages: [stage(1, 'running'), stage(2, 'pending')] }),
      plan('running', { id: 'b', stages: [stage(1, 'ended')] }),
      plan('not_started', { id: 'c' }),
      plan('ended', { id: 'd' }),
    ];
    const ids = (action: 'urge' | 'startNext' | 'terminate') => {
      const split = batchSplit(rows, action);
      return [split.eligible.map((row) => row.id), split.skipped.map((row) => row.id)];
    };
    expect(ids('urge')).toEqual([['a'], ['b', 'c', 'd']]);
    expect(ids('startNext')).toEqual([['a'], ['b', 'c', 'd']]);
    expect(ids('terminate')).toEqual([['a', 'b', 'c'], ['d']]);
  });
  it('下个阶段取第一个待开启阶段', () => {
    expect(nextStage([stage(1, 'ended'), stage(2, 'running'), stage(3, 'pending')])?.seq).toBe(3);
    expect(nextStage([stage(1, 'running')])).toBeUndefined();
  });
  it('批量回执按成功与失败计数，不把失败当成功', () => {
    expect(
      receiptSummary([
        { id: 'a', status: 200, outcome: 'done' },
        { id: 'b', status: 409, code: 'CONFLICT', outcome: 'failed' },
      ]),
    ).toEqual({ done: 1, failed: 1 });
  });
  it('表单只提交可编辑字段，日期与指导人规则在前端先校验', () => {
    const editable = ['name', 'employeeId', 'templateId', 'startDate', 'endDate', 'tutorRole', 'tutorEmployeeId'];
    const values = {
      name: '  合成计划  ',
      employeeId: { value: 'e1', label: '员工' },
      templateId: 't1',
      startDate: '2026-10-01',
      endDate: '2026-12-31',
      tutorRole: 'direct_manager',
      tutorEmployeeId: undefined,
    };
    expect(planInput(values, editable)).toEqual({
      body: {
        name: '合成计划',
        employeeId: 'e1',
        templateId: 't1',
        startDate: '2026-10-01',
        endDate: '2026-12-31',
        tutorRole: 'direct_manager',
      },
      errors: {},
    });
    expect(planInput({ ...values, endDate: '2026-09-30' }, editable).errors).toHaveProperty('endDate');
    expect(planInput({ ...values, tutorRole: 'other' }, editable).errors).toHaveProperty('tutorEmployeeId');
    expect(planInput({ ...values, startDate: '2026-10-02' }, ['name']).body).toEqual({ name: '合成计划' });
  });
});

describe('AC-FE-R3d2 第 2 轮：字段裁剪不丢记录（DEC-431①）', () => {
  it('状态被裁剪的计划仍出现在各视图，按状态筛选时才排除；状态位显示“无权查看”', () => {
    const rows = [plan('running', { id: 'a' }), plan(undefined, { id: 'b', name: '无状态计划' })];
    expect(filterPlans(rows, 'active', {}).map((row) => row.id)).toEqual(['a', 'b']);
    expect(filterPlans(rows, 'ended', {}).map((row) => row.id)).toEqual(['b']);
    expect(filterPlans(rows, 'active', { status: 'running' }).map((row) => row.id)).toEqual(['a']);
    expect(statusText(t.status, undefined)).toBe('无权查看');
    expect(statusText(t.status, 'running')).toBe('进行中');
  });
  it('状态被裁剪的模板 / 流程仍出现在两个视图', () => {
    const templates: Template[] = [
      { id: 'p', status: 'published' },
      { id: 'd', status: 'draft' },
      { id: 'x', name: '无状态' },
    ];
    expect(templates.filter((row) => templateInView(row, 'published')).map((row) => row.id)).toEqual(['p', 'x']);
    expect(templates.filter((row) => templateInView(row, 'draft')).map((row) => row.id)).toEqual(['d', 'x']);
    const processes: Process[] = [{ id: 'on', enabled: true }, { id: 'off', enabled: false }, { id: 'x' }];
    expect(processes.filter((row) => processInView(row, 'enabled')).map((row) => row.id)).toEqual(['on', 'x']);
    expect(processes.filter((row) => processInView(row, 'disabled')).map((row) => row.id)).toEqual(['off', 'x']);
  });
  it('模板状态未知时不给启用 / 停用，其余按钮照常；revision 缺失时不给写操作', () => {
    const all = () => true;
    expect(templateActions({ id: 'x', revision: 1 }, all)).toEqual(['update', 'copy', 'delete']);
    expect(templateActions({ id: 'p', revision: 1, status: 'published' }, all)).toEqual([
      'update',
      'copy',
      'unpublish',
      'delete',
    ]);
    expect(templateActions({ id: 'd', revision: 1, status: 'draft' }, all)).toContain('publish');
    expect(templateActions({ id: 'n', status: 'draft' }, all)).toEqual([]);
  });
});

describe('AC-FE-R3d2 第 2 轮：筛选、本人计划、任务权限', () => {
  const rows = [
    plan('running', { id: 'a', employeeId: 'e1', tutorEmployeeId: 't1', currentStageName: '制定计划' }),
    plan('running', { id: 'b', employeeId: 'e2', tutorEmployeeId: 't2', currentStageName: '中期回顾' }),
  ];
  it('高级筛选支持姓名、指导人、当前阶段', () => {
    expect(filterPlans(rows, 'active', { employeeId: 'e2' }).map((row) => row.id)).toEqual(['b']);
    expect(filterPlans(rows, 'active', { tutorEmployeeId: 't1' }).map((row) => row.id)).toEqual(['a']);
    expect(filterPlans(rows, 'active', { currentStageName: '中期回顾' }).map((row) => row.id)).toEqual(['b']);
  });
  it('我的发展计划只列本人计划，会话没有员工身份时为空', () => {
    expect(ownPlans(rows, 'e1').map((row) => row.id)).toEqual(['a']);
    expect(ownPlans(rows, undefined)).toEqual([]);
  });
  it('任务按服务端返回的节点按钮开放，HR 视图（无按钮）与非进行中计划不开放', () => {
    const module = { id: 'm', moduleType: 'goal', name: '发展目标' };
    expect(taskActions(plan('running'), { ...module, buttons: ['RowEditIdpGoal'] })).toEqual(['add', 'edit', 'delete']);
    expect(taskActions(plan('running'), { ...module, buttons: ['RowAddIdpGoal'] })).toEqual([]);
    expect(taskActions(plan('running'), module)).toEqual([]);
    expect(taskActions(plan('ended'), { ...module, buttons: ['RowEditIdpGoal'] })).toEqual([]);
    expect(taskActions(plan('running', { revision: undefined }), { ...module, buttons: ['RowEditIdpGoal'] })).toEqual(
      [],
    );
  });
});

describe('AC-FE-R3d2 第 2 轮：子流程按 IDP.SubProcess 自身权限', () => {
  const field = (visible: string[], editable: string[]) => (name: string) => ({
    visible: visible.includes(name),
    editable: editable.includes(name),
  });
  const all = ['name', 'category', 'approvalType', 'approvalProcessId', 'startMode', 'startTimeType'];
  it('父字段可编辑且子流程字段全可编辑时可增删改', () => {
    const access = subProcessAccess(true, field(all, all));
    expect(access).toMatchObject({ add: true, edit: true, remove: true, reorder: true });
  });
  it('父字段不可编辑时一律只读（失败即拒绝）', () => {
    expect(subProcessAccess(false, field(all, all))).toMatchObject({ add: false, edit: false, remove: false });
  });
  it('子流程对象无权限时只读；必填字段不可编辑时不能新增', () => {
    expect(subProcessAccess(true, field([], []))).toMatchObject({ add: false, edit: false, remove: false });
    const partial = subProcessAccess(true, field(all, ['name']));
    expect(partial).toMatchObject({ add: false, edit: true });
  });
  it('隐藏字段不出现在可见字段中', () => {
    const access = subProcessAccess(true, field(['name', 'category'], ['name']));
    expect(access.visible).toEqual(['name', 'category']);
    expect(access.editable).toEqual(['name']);
  });
});

describe('AC-FE-R3d2 第 2 轮：模板只读配置用中文分区与字段名', () => {
  const goal: TemplateModule = {
    id: 'g',
    moduleType: 'goal',
    name: '发展目标',
    description: null,
    displayOrder: 1,
    allowCustomGoal: true,
    allowLibraryGoal: false,
    competencySource: 'current_position',
    goalReviewEnabled: true,
    taskEnabled: true,
    checkNoneGoal: false,
    nodeSettings: [{ subProcessId: 's1', nodeKey: 'n1', enabled: true, buttons: ['RowAddIdpGoal', 'RowEditIdpGoal'] }],
    unknownSetting: { nested: 1 },
  };
  const keyInfo: TemplateModule = {
    id: 'k',
    moduleType: 'key_info',
    name: '关键信息',
    keyInfoSources: ['work_shift'],
    keyInfoBlocks: [{ block: 'work_shift', fields: ['orgId', 'startDate'] }],
  };
  const text = (module: TemplateModule) => JSON.stringify(moduleSettingSections(module, () => '制定计划 / 审批节点'));
  it('目标模块按原站“目标设置”“各步骤参与角色及权限设置”呈现', () => {
    const sections = moduleSettingSections(goal, () => '制定计划 / 审批节点');
    expect(sections.map((section) => section.title)).toEqual(['基础信息', '目标设置', '各步骤参与角色及权限设置']);
    const settings = sections[1]!.items;
    expect(settings).toContainEqual({ label: '自定义目标', value: '开启' });
    expect(settings).toContainEqual({ label: '胜任力库目标', value: '关闭' });
    expect(settings).toContainEqual({ label: '胜任力来源', value: '当前职位' });
    expect(settings).toContainEqual({ label: '制定任务', value: '开启' });
    expect(sections[2]!.items).toEqual([{ label: '制定计划 / 审批节点', value: '目标：新增、编辑' }]);
  });
  it('关键信息模块按区块列出展示字段', () => {
    const sections = moduleSettingSections(keyInfo, () => '');
    expect(sections[1]).toEqual({
      title: '区块设置',
      items: [{ label: '轮岗信息', value: '展示字段：组织；开始时间' }],
    });
  });
  it('不出现 DTO 键名或 JSON 文本', () => {
    for (const module of [goal, keyInfo]) {
      const output = text(module);
      for (const key of ['allowCustomGoal', 'competencySource', 'nodeSettings', 'keyInfoBlocks', 'unknownSetting'])
        expect(output).not.toContain(key);
      const values = moduleSettingSections(module, () => '').flatMap((section) => section.items.map((i) => i.value));
      expect(values.some((value) => /[{}[\]]/.test(value))).toBe(false);
    }
  });
});

describe('AC-FE-R3d2 第 2 轮：节点名与我的发展计划筛选', () => {
  const sub = { id: 's1', name: '合成制定阶段', approvalProcessId: 'a1' } as SubProcess;
  const approval: ApprovalCandidate = {
    id: 'a1',
    name: '合成审批',
    nodes: [{ nodeKey: 'n1', name: '制定发展目标', seq: 1 }],
  };
  it('节点配置解析成原站节点名，读不到时只显示子流程名与“节点名称不可见”，不回显内部键', () => {
    const label = nodeLabeler([sub], [approval]);
    expect(label({ subProcessId: 's1', nodeKey: 'n1' })).toBe('制定发展目标');
    expect(label({ subProcessId: 's1', nodeKey: 'n9' })).toBe('合成制定阶段 · 节点名称不可见');
    expect(label({ subProcessId: 'x', nodeKey: 'n1' })).toBe('-- · 节点名称不可见');
    expect(nodeLabeler([sub], [])({ subProcessId: 's1', nodeKey: 'n1' })).toBe('合成制定阶段 · 节点名称不可见');
  });
  it('我的发展计划的行内筛选：状态与起止时间逐项判定，状态不可见时按状态筛选不命中', () => {
    const row: PlanSummary = { id: 'p', status: 'running', startDate: '2026-10-01', endDate: '2026-12-31' };
    expect(matchesFilters(row, {})).toBe(true);
    expect(matchesFilters(row, { status: 'running', startFrom: '2026-09-01', endTo: '2026-12-31' })).toBe(true);
    expect(matchesFilters(row, { status: 'ended' })).toBe(false);
    expect(matchesFilters(row, { startFrom: '2026-10-02' })).toBe(false);
    expect(matchesFilters({ id: 'q' }, { status: 'running' })).toBe(false);
  });
  it('状态位：空值显示 --，裁剪显示“无权查看”，已知值显示中文', () => {
    expect(statusText(t.status, 'ended')).toBe('已结束');
    expect(statusText(t.status, null)).toBe('--');
    expect(statusText(t.status, undefined)).toBe('无权查看');
  });
});

describe('AC-FE-R3d2 页面与注释登记', () => {
  const codes = Object.values(IDP_OBJECTS).map((object) => object.code);
  const snapshot = (entryObjects: string[]) =>
    ({ apps: [{ app: 'idp', visible: true, entryObjects }], adminMenus: [] }) as never;
  const app = PAGES.apps.find((item) => item.app === 'idp')!;
  it('应用登记为人才发展计划，下一层按入口对象给出三张列表', () => {
    expect(app.label).toBe('人才发展计划');
    expect(app.page?.name).toBe('IdpPage');
    const route = app as never;
    expect(app.children!(snapshot(codes), route).map((node) => node.label)).toEqual([
      '发展计划',
      '发展计划模板',
      '发展计划流程',
    ]);
    expect(app.children!(snapshot(['IDP.IDPTemplate']), route).map((node) => node.path)).toEqual(['/idp/templates']);
    expect(PAGES.routes.filter((item) => item.module === 'idp').map((item) => item.path)).toEqual([
      '/idp/*',
      '/self/idp',
    ]);
  });
  it.each(['idp-plans', 'idp-plan-detail', 'idp-my-plans', 'idp-templates', 'idp-processes', 'idp-demo'])(
    '注释 %s 已登记且写明原站与决策',
    (id) => {
      expect(annotations[id]).toBeDefined();
      expect(annotations[id]?.decisions).toContain('DEC-494');
      expect(annotations[id]?.original).toBeTruthy();
      expect(annotations[id]?.decision).toBeTruthy();
    },
  );
});
