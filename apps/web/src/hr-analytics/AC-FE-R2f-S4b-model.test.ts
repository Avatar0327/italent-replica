import { HR_PROCESS_COMPONENTS, type HrProcessComponentCode } from '@italent/domain';
import { expect, it } from 'vitest';
import {
  processDetailTable,
  processDetailUrl,
  processMetrics,
  processPoints,
  processSections,
  processTrend,
  type ProcessComponent,
  type ProcessDetail,
  type ProcessGroup,
} from './process-model.js';

// 形状照 apps/api/src/modules/analytics/hr-process-dashboard.ts 的 hrProcessOverview / hrProcessPage 回执
const prefix = 'ZZ_FER2F_S4B_';
const window = { asOf: '2026-11-22', from: '2026-10-24', to: '2026-11-22', hasDataPermission: true };
const ratio = (hits: number | null, total: number) => (hits === null || total === 0 ? null : hits / total);
const group = (key: string, count: number, hits: number | null = null, average: number | null = null) => ({
  key,
  label: null,
  series: null,
  count,
  hits,
  rate: ratio(hits, count),
  average,
});
function component(code: HrProcessComponentCode, groups: ProcessGroup[] = [], average: number | null = null) {
  const total = groups.reduce((sum, item) => sum + item.count, 0);
  const hits = groups.some((item) => item.hits !== null)
    ? groups.reduce((sum, item) => sum + (item.hits ?? 0), 0)
    : null;
  return {
    ...HR_PROCESS_COMPONENTS.find((item) => item.code === code)!,
    total,
    hits,
    rate: ratio(hits, total),
    average,
    groups,
  } satisfies ProcessComponent;
}
const detail = (code: HrProcessComponentCode, items: ProcessDetail['items']): ProcessDetail => ({
  ...component(code),
  ...window,
  total: items.length,
  page: 1,
  pageSize: 20,
  items,
});
const parameterValues = (path: string) => Object.fromEntries(new URL(path, 'https://example.com').searchParams);
const labelled = (metrics: ReturnType<typeof processMetrics>) =>
  metrics.map((item) => [item.label, 'text' in item ? item.text : item.value, item.drill]);

it('AC-FE-R2f-05 补全质量与应用后四分区 24 个编号按规格顺序', () => {
  const sections = processSections(HR_PROCESS_COMPONENTS.map(({ code }) => component(code)).reverse());
  expect(sections.map(({ module }) => module)).toEqual(['inFlight', 'timeliness', 'quality', 'usage']);
  expect(sections.flatMap(({ items }) => items.map(({ no }) => no))).toEqual([
    ...Array.from({ length: 19 }, (_, index) => `7.2.${String(index + 1).padStart(2, '0')}`),
    ...['7.1.20', '7.1.21', '7.1.22', '7.1.23', '7.1.24'],
  ]);
});

it('AC-FE-R2f-05 不合规与应用的比率卡用服务端 rate/hits/total，命中钻取带布尔 hit', () => {
  const week = '2026-11-16';
  const nonCompliant = component('nonCompliantByWeek', [group(week, 4, 1), group('2026-11-09', 2, 0)]);
  expect(labelled(processMetrics(nonCompliant))).toEqual([
    ['不合规率', '16.67%', undefined],
    ['不合规数', 1, { hit: true }],
    ['已通过数', 6, {}],
  ]);
  const org = '10000000-0000-4000-8000-100000000061';
  const usage = component('transferApprovalRate', [group(org, 6, 5)]);
  expect(labelled(processMetrics(usage))).toEqual([
    ['占比', '83.33%', undefined],
    ['审批总量', 5, { hit: true }],
    ['业务总量', 6, {}],
  ]);

  const trend = processTrend(nonCompliant, processPoints(nonCompliant));
  expect(trend.categories.map(({ key }) => key)).toEqual([week, '2026-11-09']);
  expect(trend.series.map(({ label, points }) => [label, points.map(({ text }) => text)])).toEqual([
    ['不合规率', ['25%', '0%']],
    ['不合规数', ['1', '0']],
    ['已通过数', ['4', '2']],
  ]);
  const cells = trend.series.flatMap(({ points }) => points);
  expect(new Set(cells.map(({ key }) => key)).size).toBe(6);
  const drills = trend.series.map(({ points }) => points[0]!.drill);
  expect(drills).toEqual([{ group: week, hit: true }, { group: week, hit: true }, { group: week }]);
  expect(parameterValues(processDetailUrl('nonCompliantByWeek', window, 1, drills[1]!))).toMatchObject({
    group: week,
    hit: 'true',
  });
});

it('AC-FE-R2f-05 晚提交按类别显示名称，发起人排名按数量降序、同值按键，平均差值按天', () => {
  const late = processPoints(component('lateSubmitByCategory', [group('transfer', 2), group('offer', 1)]));
  expect(late.map(({ label, text }) => [label, text])).toEqual([
    ['调动', '2'],
    ['Offer', '1'],
  ]);
  const [a, b, c] = ['10000000-0000-4000-8000-1000000000a1', '10000000-0000-4000-8000-1000000000b2', 'c'];
  const ranked = processPoints(component('lateSubmitByInitiator', [group(b, 1), group(c, 3), group(a, 1)]));
  expect(ranked.map(({ category, text }) => [category, text])).toEqual([
    [c, '3'],
    [a, '1'],
    [b, '1'],
  ]);
  const lag = processPoints(component('approveLagByCategory', [group('exit', 2, null, -0.5)]));
  expect(lag.map(({ label, text }) => [label, text])).toEqual([['离职', '-0.5 天']]);
  expect(labelled(processMetrics(component('submitLag', [], 1.25)))).toEqual([['平均天数', '1.25 天', {}]]);
});

it('AC-FE-R2f-05 质量与应用明细显示分组、命中与差值，业务单行的不可见实例 ID 保持为空', () => {
  const org = '10000000-0000-4000-8000-100000000061';
  const usage = processDetailTable(
    detail('offerApprovalRate', [
      { id: prefix + '业务单_1', instanceId: null, group: org, series: null, value: null, hit: true },
      { id: prefix + '业务单_2', instanceId: null, group: org, series: null, value: null, hit: false },
    ]),
  );
  expect(usage.columns).toEqual([
    { key: 'id', label: '业务单 ID' },
    { key: 'instanceId', label: '实例 ID' },
    { key: 'group', label: '录用部门 ID' },
    { key: 'hit', label: '经审批' },
  ]);
  expect(usage.rows.map(({ instanceId, hit }) => [instanceId, hit])).toEqual([
    [null, '是'],
    [null, '否'],
  ]);
  const quality = processDetailTable(
    detail('nonCompliantByWeek', [
      { id: prefix + '实例', instanceId: prefix + '实例', group: '2026-11-16', series: null, value: null, hit: true },
    ]),
  );
  expect(quality.columns.map(({ label }) => label)).toEqual(['实例 ID', '分组', '不合规']);
  expect(quality.rows[0]).toMatchObject({ group: '2026-11-16', hit: '是' });
  const lag = processDetailTable(
    detail('submitLagByCategory', [
      { id: prefix + '实例', instanceId: null, group: 'contract', series: null, value: 0, hit: null },
    ]),
  );
  expect(lag.columns.map(({ label }) => label)).toEqual(['实例 ID', '分组', '相差天数']);
  expect(lag.rows[0]).toMatchObject({ group: '合同', value: 0 });
  const initiator = processDetailTable(
    detail('lateSubmitByInitiator', [{ id: 'i', instanceId: 'i', group: 'u', series: null, value: null, hit: null }]),
  );
  expect(initiator.columns.map(({ label }) => label)).toEqual(['实例 ID', '发起人 ID']);
});
