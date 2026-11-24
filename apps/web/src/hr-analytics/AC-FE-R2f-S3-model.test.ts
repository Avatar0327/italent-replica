import { HR_MOVEMENT_COMPONENTS, type HrMovementCode } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../foundation/client.js';
import { cellText } from '../hr-reports/model.js';
import { boardErrorText, canRetryRead } from './model.js';
import {
  movementCards,
  movementDetailUrl,
  movementOverviewUrl,
  type MovementGroup,
  type MovementOverview,
} from './movement-model.js';

const filters = { asOf: '2026-10-26', departmentId: '10000000-0000-4000-8000-000000000081' };
const capacity = '10000000-0000-4000-8000-000000000091';
const parent = '["leave","ZZ_FER2F_甲 & / +"]';
const child = '["leave","ZZ_FER2F_甲 & / +",null]';

const point = (key: string, count: number, extra: Partial<MovementGroup> = {}): MovementGroup => ({
  key,
  label: key,
  count,
  ...extra,
});
const result = (code: HrMovementCode, groups: MovementGroup[], value: number | null = null): MovementOverview => ({
  asOf: filters.asOf,
  hasDataPermission: true,
  components: [{ ...HR_MOVEMENT_COMPONENTS.find((item) => item.code === code)!, groups, value }],
});

describe('AC-FE-R2f-04 人员流动统计适配', () => {
  it('6.26 用服务端月份顺序和系列键，两系列不丢零值；6.28 保留 rate、期初、期末及明细人数', () => {
    const [hiresExits] = movementCards(
      result('6.26', [
        point('hire:2026-01', 2),
        point('exit:2026-01', 0),
        point('hire:2026-02', 1),
        point('exit:2026-02', 4),
      ]),
    );
    expect(hiresExits).toMatchObject({
      body: 'area',
      categories: [{ key: '2026-01' }, { key: '2026-02' }],
      series: [
        {
          points: [
            { key: 'hire:2026-01', value: 2 },
            { key: 'hire:2026-02', value: 1 },
          ],
        },
        {
          points: [
            { key: 'exit:2026-01', value: 0 },
            { key: 'exit:2026-02', value: 4 },
          ],
        },
      ],
    });
    const [rate] = movementCards(result('6.28', [point('2026-02', 24, { opening: 10, closing: 10, rate: 0.1308 })]));
    expect(rate).toMatchObject({
      body: 'line',
      series: [{ points: [{ key: '2026-02', value: 0.1308, text: '13.08%', hint: '离职 24 人 · 期初 10 · 期末 10' }] }],
    });
  });

  it('双环按 parent 配对，用服务端键和原始计数；同名与空值不代换编码', () => {
    const points = [
      point(parent, 4, { parent: null, label: '合成类型' }),
      point(child, 4, { parent, label: '空' }),
      point('["retirement"]', 2, { parent: null, label: '退休' }),
      point('["retirement",null]', 2, { parent: '["retirement"]', label: '空' }),
    ];
    for (const code of ['6.29', '6.30'] as const)
      expect(movementCards(result(code, points, 6))[0]).toMatchObject({
        body: 'nested-pie',
        points: points.map(({ key, parent, count }) => ({ key, parent, value: count })),
        options: [
          { key: parent },
          { key: child, label: '合成类型 → 空' },
          { key: '["retirement"]' },
          {
            key: '["retirement",null]',
            label: '退休 → 空',
          },
        ],
      });
  });

  it('编制绑定投影与回执键，保留 null、负缺编和按分析范围统计的临时口径', () => {
    const row = {
      orgId: filters.departmentId,
      localCapacity: null,
      inclusiveCapacity: 30,
      pendingIn: 7,
      pendingOut: 3,
      vacancy: -2,
      executionRate: 1.0667,
    };
    const [table] = movementCards(result('3.1.36', [point(capacity, 28, { label: '合成编制部门', ...row })]));
    expect(table).toMatchObject({
      body: 'table',
      table: { total: 1, rows: [{ key: capacity, count: 28, label: '合成编制部门', ...row }] },
    });
    expect(cellText('executionRate', row.executionRate)).toBe('106.67%');
    expect(cellText('executionRate', null)).toBe('—');
  });

  it('6.32 单人样本为未转正实习生的真实回执只产生占位模型', () => {
    expect(movementCards(result('6.32', [point(filters.departmentId, 1, { ratio: 1 })], 1))).toEqual([
      {
        code: '6.32',
        name: '入职一个月内离职各部门人数占比',
        body: 'unavailable',
        text: '统计口径暂不可用',
      },
    ]);
    expect(movementDetailUrl('6.32', filters, 1, filters.departmentId)).toBeNull();
  });

  it('只发送适用筛选和原样编码的组；必选组为空时没有请求 URL', () => {
    expect(movementOverviewUrl({ asOf: filters.asOf, departmentId: '' })).toBe(
      '/api/tenant/analytics/hr-movement?asOf=2026-10-26',
    );
    const pairs = [
      ['6.25', '2026-02'],
      ['6.26', 'exit:2026-02'],
      ['6.28', '2026-02'],
      ['6.29', child],
      ['3.1.36', capacity],
    ] as const;
    for (const [code, group] of pairs) {
      const expected = new URLSearchParams({ ...filters, group, page: '2', pageSize: '20' });
      expect(movementDetailUrl(code, filters, 2, group)).toBe(
        '/api/tenant/analytics/hr-movement/components/' + code + '?' + expected,
      );
    }
    for (const code of ['6.25', '6.26', '6.28', '3.1.36'] as const)
      expect(movementDetailUrl(code, filters, 1)).toBeNull();
    expect(movementDetailUrl('6.27', filters, 1)).not.toContain('group=');
  });
});

it('AC-FE-R2f-11 沿用看板错误分类、可重试状态及未知组件文案', () => {
  const cases = [
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围', false],
    [403, 'FORBIDDEN', '无权查看该组件', false],
    [404, 'NOT_FOUND', '组件不存在', false],
    [413, 'PAYLOAD_TOO_LARGE', '请缩小筛选范围后重试', false],
    [429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', true],
    [503, 'UNAVAILABLE', '明细加载失败，请重试', true],
  ] as const;
  for (const [status, code, text, retry] of cases) {
    const error = new ApiError(status, code, 'unknown', '');
    expect(boardErrorText(error, true, '组件不存在')).toBe(text);
    expect(canRetryRead(error)).toBe(retry);
  }
});
