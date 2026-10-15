// F-132 第 2 段（FE-R1c）：调动管理列表与审批中心按原站核对后的视图、工具栏、提示、列序与子页结构。
// 原站文案与列序见 PR 对照表（DEC-489：取证只在本机查看）；原站有而接口没有的列与按钮不伪造，列入后端缺口清单。
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const transfer = () => import(resolve('apps/web/src/transfer/page-model.ts'));
const approval = () => import(resolve('apps/web/src/approval/page-model.ts'));
const approvalPages = () => import(resolve('apps/web/src/approval/pages.ts'));
const demo = () => import(resolve('apps/web/src/demo-stubs/transfer.ts'));
const hrForm = () => import(resolve('apps/web/src/transfer/hr-form-model.ts'));

describe('AC-FE-R1c 调动管理列表按原站三个视图', () => {
  it('标题视图为调动中员工 / 已完成的调动 / 全部调动记录，没有复刻自加的“我的申请”', async () => {
    const { transferViews } = await transfer();
    expect(transferViews.map((view: { label: string }) => view.label)).toEqual([
      '调动中员工',
      '已完成的调动',
      '全部调动记录',
    ]);
  });
  it('各视图工具栏顺序按原站；只有他人调动申请与调动可用', async () => {
    const { transferTools, toolLabels, enabledTools, dropdownTools } = await transfer();
    const labels = (view: 'progress' | 'completed' | 'all') =>
      transferTools[view].map((tool: keyof typeof toolLabels) => toolLabels[tool]);
    expect(labels('progress')).toEqual(['调动处理', '他人调动申请', '调动', '批量调动', '更多操作']);
    expect(labels('completed')).toEqual(['调动处理', '他人调动申请', '调动', '批量调动', '导出数据']);
    expect(labels('all')).toEqual(['他人调动申请', '调动', '批量调动', '导出数据', '导入调动记录']);
    expect(enabledTools).toEqual(['apply', 'direct']);
    expect(dropdownTools).toEqual(['process', 'more', 'export', 'import']);
  });
  it('提示原文按视图区分，调动中两行并附常见问题入口', async () => {
    const { transferBanners } = await transfer();
    expect(transferBanners.progress.lines).toHaveLength(2);
    expect(transferBanners.progress.lines[0]).toMatch(
      /^1、在此列表查看调动中的员工.*【撤回】按钮直接对调动流程进行干预。$/,
    );
    expect(transferBanners.progress.lines[1]).toMatch(
      /^2、也可以在此列表发起员工的【调动申请】.*一次发起多人的调动申请。$/,
    );
    expect(transferBanners.progress.link).toBe('更多常见问题及解答');
    expect(transferBanners.completed.lines).toEqual([
      '可在此页面查看已经生效的调动记录，也可以进行调动申请或者调动等操作',
    ]);
    expect(transferBanners.all.lines).toEqual([
      '可在此页面查看所有的调动记录，也可以进行调动申请、调入申请或者调动等操作',
    ]);
    expect(transferBanners.all.link).toBe('了解更多');
  });
  it('快捷筛选：已完成视图没有审批状态；清空已选只在已完成与全部', async () => {
    const { transferFilters, clearableViews } = await transfer();
    expect(transferFilters.progress).toEqual(['person', 'date', 'department', 'post', 'status']);
    expect(transferFilters.completed).toEqual(['person', 'date', 'department', 'post']);
    expect(transferFilters.all).toEqual(['person', 'date', 'department', 'post', 'status']);
    expect(clearableViews).toEqual(['completed', 'all']);
  });
  it('列序按原站各视图', async () => {
    const { transferColumns, columnLabels } = await transfer();
    const labels = (view: 'progress' | 'completed' | 'all') =>
      transferColumns[view].map((column: keyof typeof columnLabels) => columnLabels[column]);
    expect(labels('progress')).toEqual([
      ...['姓名', '工号', '调动日期', '调动类型', '调动前部门', '调动前职务', '调动后机构', '调动后部门'],
      ...['调动后工作地点', '调动后职务', '交接状态', '审批状态', '当前审批人', '操作'],
    ]);
    expect(labels('completed')).toEqual([
      ...['姓名', '工号', '调动日期', '调动类型', '调动前机构全称', '调动前机构', '调动前职位', '调动前职级类别'],
      ...['调动后机构全称', '调动后机构', '调动后职位', '调动后职级类别', '交接状态', '审批状态', '操作'],
    ]);
    expect(labels('all')).toEqual([
      ...['姓名', '工号', '调动日期', '调动类型', '调动前部门', '调动前职务', '调动后机构', '调动后部门'],
      ...['调动后工作地点', '调动后职务', '审批状态', '当前审批人', '操作'],
    ]);
  });
  it('筛选只作用于合成数据：调动中排除已生效，日期区间与调动后部门可组合', async () => {
    const { filterTransfers } = await transfer();
    const { transferExamples } = await demo();
    const rows = transferExamples();
    const names = (list: { name: string }[]) => list.map((row) => row.name);
    expect(names(filterTransfers(rows, 'progress', {}))).toEqual(['林晓（合成）', '陈安（合成）']);
    expect(names(filterTransfers(rows, 'completed', { status: 'running' }))).toEqual(['周宁（合成）']);
    expect(names(filterTransfers(rows, 'all', { from: '2026-10-15', department: '市场部' }))).toEqual(['陈安（合成）']);
    expect(names(filterTransfers(rows, 'all', { person: 'DEMO-003' }))).toEqual(['周宁（合成）']);
  });
});

describe('AC-FE-R1c 审批中心子页按原站', () => {
  const snapshot = (entryObjects: string[]) =>
    ({ apps: [{ app: 'approval', visible: true, entryObjects }] }) as unknown as Parameters<
      NonNullable<Awaited<ReturnType<typeof approvalPages>>['pages']['apps'][number]['children']>
    >[0];
  const children = async (entryObjects: string[]): Promise<[string, string][]> => {
    const { pages } = await approvalPages();
    const app = pages.apps!.find((item: { app: string }) => item.app === 'approval')!;
    return app.children!(snapshot(entryObjects), { group: 'work' } as never).map(
      (node: { label: string; path: string }): [string, string] => [node.label, node.path],
    );
  };
  it('我的待办 / 我的申请 / 我的委托对所有成员可见；流程管理与管理员委托要审批实例对象权限', async () => {
    expect(await children([])).toEqual([
      ['我的待办', '/approval/todos'],
      ['我的申请', '/approval/applications'],
      ['我的委托', '/approval/delegations'],
    ]);
    expect((await children(['TenantBase.ApprovalProcess', 'TenantBase.ApprovalInstance'])).map(([l]) => l)).toEqual([
      '我的待办',
      '我的申请',
      '我的委托',
      '流程管理',
      '管理员委托',
    ]);
  });
  it('子页都挂在 /approval/* 路由下', async () => {
    const { pages } = await approvalPages();
    expect(pages.routes?.map((route: { path: string }) => route.path)).toEqual(['/approval/*']);
  });
  it('详情按钮顺序为同意、不同意、驳回、转交、撤销；不同意对应 disagree', async () => {
    const { actionOrder } = await approval();
    const { messages } = await import(resolve('apps/web/src/approval/messages.ts'));
    expect(actionOrder.map((action: keyof typeof messages) => messages[action])).toEqual([
      '同意',
      '不同意',
      '驳回',
      '转交',
      '撤销',
    ]);
  });
  it('待办工具栏：待处理有批量同意 / 批量不同意，其余只有流程委托 / 流程管理；排序标签按视图', async () => {
    const { todoTools, todoSort } = await approval();
    expect(todoTools.pending).toEqual(['batchApprove', 'batchDisagree', 'delegate', 'manage']);
    expect(todoTools.completed).toEqual(['delegate', 'manage']);
    expect(todoTools.initiated).toEqual(['delegate', 'manage']);
    expect(todoSort).toEqual({ pending: '接收时间倒序', completed: '处理时间倒序', initiated: '申请时间倒序' });
  });
  it('我的申请只显示接口有的列，发起人 / 当前处理人 / 申请理由列为缺口', async () => {
    const { applicationColumns, applicationGapColumns } = await approval();
    expect(applicationColumns).toEqual(['title', 'category', 'status', 'createdAt']);
    expect(applicationGapColumns).toEqual(['initiator', 'handler', 'reason']);
  });
  it('委托与流程管理页的视图、工具栏与列序按原站', async () => {
    const { gapPages } = await approval();
    const mine = gapPages.delegations.views;
    expect(mine.map((view: { label: string }) => view.label)).toEqual(['进行中的委托', '已完成的委托']);
    expect(mine[0].tools).toEqual(['新建委托', '批量收回', '我委托的流程']);
    expect(mine[1].tools).toEqual(['我委托的流程']);
    expect(mine[0].columns).toEqual([
      ...['委托人', '被委托人', '开始时间', '结束时间', '委托审批类型范围', '审批类型', '委托部门范围', '部门'],
      ...['委托已有待办', '创建人', '操作'],
    ]);
    const admin = gapPages['admin-delegations'].views;
    expect(admin.map((view: { label: string }) => view.label)).toEqual([
      '进行中的委托(管理员)',
      '已完成的委托(管理员)',
    ]);
    expect(admin[1].columns.slice(-4)).toEqual(['收回人', '收回时间', '委托已有待办', '操作']);
    const process = gapPages.processes;
    expect(process.title).toBe('组织员工流程');
    expect(process.views[0].tools).toEqual(['催办', '转交', '撤销', '一键审批', '导出']);
    expect(process.filters).toEqual(['标题', '审批类型', '发起人', '当前审批人', '审批状态']);
    expect(process.views[0].columns).toEqual([
      ...['标题', '审批类型', '发起人', '工号', '当前审批人', '审批状态', '创建时间', '摘要', '催办状态', '操作'],
    ]);
  });
  it('流程状态按原站文案与色调', async () => {
    const { instanceStatus } = await import(resolve('apps/web/src/approval/messages.ts'));
    expect(instanceStatus.approved).toEqual({ label: '通过', tone: 'passed' });
    expect(instanceStatus.running).toEqual({ label: '审批中', tone: 'running' });
    expect(instanceStatus.disapproved).toEqual({ label: '不通过', tone: 'failed' });
    expect(instanceStatus.returned).toEqual({ label: '已驳回', tone: 'returned' });
  });
});

// #333 第 1 轮返工：HR 全页表单两个入口的按钮、写权限与四个区块。
describe('AC-FE-R1c HR 调动表单按入口与权限', () => {
  const full = { dataOperations: { read: true, create: true }, editableFields: ['departmentId'] };
  const preview = (direct: boolean) => ({
    allowDirectTransfer: direct,
    allowedActions: { application: true, directList: direct, directRow: false },
  });
  it('区块按原站：调动信息 / 任职调整 / 薪资调整 / 合同变更', async () => {
    const { hrSections } = await hrForm();
    expect(hrSections.map((section: { label: string }) => section.label)).toEqual([
      '调动信息',
      '任职调整',
      '薪资调整',
      '合同变更',
    ]);
  });
  it('P2-1 调动为取消 / 保存，他人调动申请为取消 / 暂存 / 提交', async () => {
    const { hrFormActions, hrActionLabels } = await hrForm();
    const labels = (mode: 'apply' | 'direct') =>
      hrFormActions[mode].map((action: keyof typeof hrActionLabels) => hrActionLabels[action]);
    expect(labels('direct')).toEqual(['取消', '保存']);
    expect(labels('apply')).toEqual(['取消', '暂存', '提交']);
  });
  it('P2-1 两个入口 × 有无直接调动权限', async () => {
    const { hrActionState } = await hrForm();
    const state = (mode: 'apply' | 'direct', direct: boolean) =>
      hrActionState({ mode, writable: true, blocked: false, preview: preview(direct) });
    expect(state('apply', true).enabled).toEqual({ cancel: true, draft: true, submit: true, save: false });
    expect(state('apply', false).enabled).toEqual({ cancel: true, draft: true, submit: true, save: false });
    expect(state('apply', false).hint).toBeUndefined();
    expect(state('direct', true).enabled).toEqual({ cancel: true, draft: false, submit: false, save: true });
    expect(state('direct', true).hint).toBeUndefined();
    expect(state('direct', false).enabled).toEqual({ cancel: true, draft: false, submit: false, save: false });
    expect(state('direct', false).hint).toBe('当前账号或该员工不允许直接调动，请改用“他人调动申请”。');
    // 直接调动开关开着但列表级按钮 Employment.Tranfer 不在，仍不能保存。
    const allowedActions = { application: true, directList: false, directRow: true };
    const rowOnly = { allowDirectTransfer: true, allowedActions };
    expect(hrActionState({ mode: 'direct', writable: true, blocked: false, preview: rowOnly }).enabled.save).toBe(
      false,
    );
  });
  it('P2-2 写权限要 create 与可编辑字段；只留 Transfer.Hr 按钮不够，摘要按无权', async () => {
    const { hrWriteAccess, hrActionState } = await hrForm();
    expect(hrWriteAccess(full)).toBe(true);
    expect(hrWriteAccess(undefined)).toBe(false);
    expect(hrWriteAccess({ ...full, summary: true })).toBe(false);
    expect(hrWriteAccess({ ...full, dataOperations: { read: true, create: false } })).toBe(false);
    expect(hrWriteAccess({ ...full, editableFields: [] })).toBe(false);
    for (const mode of ['apply', 'direct'] as const) {
      const state = hrActionState({ mode, writable: false, blocked: false, preview: preview(true) });
      expect(state.enabled).toEqual({ cancel: true, draft: false, submit: false, save: false });
      expect(state.hint).toBe('当前账号没有新增任职记录的权限或可编辑字段，不能保存调动。');
    }
  });
  it('表单未就绪（未选员工或必填缺失）时写按钮都不可点，取消仍可用', async () => {
    const { hrActionState } = await hrForm();
    expect(hrActionState({ mode: 'apply', writable: true, blocked: true, preview: preview(true) }).enabled).toEqual({
      cancel: true,
      draft: false,
      submit: false,
      save: false,
    });
    expect(hrActionState({ mode: 'direct', writable: true, blocked: true, preview: null }).hint).toBeUndefined();
  });
});
