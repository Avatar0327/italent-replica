import { HR_PROCESS_COMPONENTS, type HrProcessComponentCode } from '@italent/domain';
import { expect, it } from 'vitest';
import {
  inFlightTable,
  processDefaults,
  processDetailTable,
  processDetailUrl,
  processMetrics,
  processOverviewUrl,
  processPoints,
  processResultFilters,
  processSections,
  processTrend,
  validProcessFilters,
  type ProcessComponent,
  type ProcessDetail,
  type ProcessGroup,
} from './process-model.js';

const defaults = processDefaults('2024-03-01');
const window = { asOf: '2024-03-02', from: '2024-02-02', to: '2024-03-02', hasDataPermission: true };
const component = (code: HrProcessComponentCode, groups: ProcessGroup[] = []): ProcessComponent => ({
  ...HR_PROCESS_COMPONENTS.find((item) => item.code === code)!,
  total: 5,
  hits: 2,
  groups,
});
const group = (key: string, series: string | null = null, average: number | null = null): ProcessGroup => ({
  key,
  label: null,
  series,
  average,
  count: 3,
});
const parameterValues = (path: string) => Object.fromEntries(new URL(path, 'https://example.com').searchParams);

it('AC-FE-R2f-05 租户日期默认闭区间、合法筛选与回执窗口保持原钻取条件', () => {
  expect(defaults).toEqual({ asOf: '2024-03-01', from: '2024-02-01', to: '2024-03-01' });
  expect(validProcessFilters(defaults)).toBe(true);
  const invalid: Record<string, string>[] = [
    { from: '2024-03-02' },
    { from: '2024-02-30' },
    { category: 'unknown' },
    { departmentId: 'x' },
  ];
  for (const edits of invalid) expect(validProcessFilters({ ...defaults, ...edits })).toBe(false);
  expect(parameterValues(processOverviewUrl({ ...defaults, category: '', departmentId: '' }))).toEqual(defaults);

  const departmentId = '10000000-0000-4000-8000-100000000051';
  const filters = processResultFilters({ ...defaults, category: 'other', departmentId }, window);
  const name = 'ZZ_FER2F_S4A_经理：%+&/=?';
  expect(parameterValues(processDetailUrl('taskDurationByNode', filters, 2, { group: name }))).toEqual({
    asOf: window.asOf,
    from: window.from,
    to: window.to,
    category: 'other',
    departmentId,
    page: '2',
    pageSize: '20',
    group: name,
  });
  expect(
    parameterValues(
      processDetailUrl('inFlightCount', defaults, 1, processMetrics(component('inFlightCount'))[2]!.drill),
    ),
  ).toMatchObject({ hit: 'false' });
});

it('AC-FE-R2f-05 仅映射在途时效十项，堆叠不合并钻取键，组合图沿用服务端耗时和任务数', () => {
  const sections = processSections(HR_PROCESS_COMPONENTS.map(({ code }) => component(code)).reverse());
  expect(sections.map(({ module }) => module)).toEqual(['inFlight', 'timeliness']);
  expect(sections.flatMap(({ items }) => items.map(({ no }) => no))).toEqual(
    Array.from({ length: 10 }, (_, index) => `7.2.${String(index + 1).padStart(2, '0')}`),
  );
  const approver = 'ZZ_FER2F_S4A_审批人';
  const stacked = component('inFlightByApprover', [group(approver, 'offer'), group(approver, 'transfer')]);
  const points = processPoints(stacked);
  expect(new Set(points.map(({ key }) => key)).size).toBe(2);
  expect(points.map(({ drill }) => drill)).toEqual([
    { group: approver, series: 'offer' },
    { group: approver, series: 'transfer' },
  ]);
  expect(processTrend(stacked, points).categories).toEqual([{ key: approver, label: approver }]);

  const combo = component('taskDurationByApprover', [group(approver, null, 1.25), group('空耗时')]);
  expect(
    processTrend(combo, processPoints(combo)).series.map(({ points }) => points.map(({ value }) => value)),
  ).toEqual([
    [1.25, null],
    [3, 3],
  ]);
  expect(processMetrics(component('inFlightCount')).map(({ label, value }) => [label, value])).toEqual([
    ['共发起', 5],
    ['在途', 2],
    ['非在途', 3],
  ]);
});

it('AC-FE-R2f-05 在途用租户时区，空列与零值有区别，任务样本保留空实例 ID', () => {
  const detail = (code: HrProcessComponentCode, items: ProcessDetail['items']): ProcessDetail => ({
    ...component(code),
    ...window,
    total: 9,
    page: 2,
    pageSize: 20,
    items,
  });
  const list = inFlightTable(
    detail('inFlightList', [
      {
        instanceId: 'ZZ_FER2F_S4A_实例',
        startedAt: '2024-03-02T23:02:00Z',
        approverStatus: 'active',
        waitBucket: 'le3',
        approvedCount: 0,
        abnormalTypes: ['expired', 'approverLeft'],
      },
    ]),
    'Asia/Shanghai',
  );
  expect(list.total).toBe(9);
  expect(list.columns).toHaveLength(15);
  expect(list.rows[0]).toMatchObject({
    instanceId: 'ZZ_FER2F_S4A_实例',
    arrivedAt: null,
    startedAt: '2024/3/3 07:02',
    approverStatus: '在职',
    waitBucket: '3 天以内',
    approvedCount: 0,
    abnormalTypes: '流程已过期、审批人已离职',
  });
  const task = processDetailTable(
    detail('taskDurationByNode', [
      {
        id: 'ZZ_FER2F_S4A_任务',
        instanceId: null,
        group: '经理审批 & 复核',
        value: 0,
      },
    ]),
  );
  expect(task.columns.map(({ key }) => key)).toEqual(['id', 'instanceId', 'group', 'value']);
  expect(task.rows[0]).toMatchObject({ instanceId: null, group: '经理审批 & 复核', value: 0 });
});
