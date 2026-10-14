import { describe, expect, it } from 'vitest';
import { IDP_OBJECTS } from '@italent/domain';
import { annotations } from '../../apps/web/src/annotations/index.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import {
  batchSplit,
  filterPlans,
  nextStage,
  planActions,
  planInput,
  receiptSummary,
} from '../../apps/web/src/idp/model.js';
import type { PlanSummary, Stage } from '../../apps/web/src/idp/types.js';

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
