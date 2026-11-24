import { CONTRACT_BOARD_COMPONENTS, SEGMENT_NONE } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../foundation/client.js';
import {
  appliedContractFilters,
  contractCards,
  contractDetailTable,
  contractDetailUrl,
  contractOverviewUrl,
  initialContractFilters,
  validContractFilters,
} from './contract-board-model.js';
import { boardErrorText, canRetryRead } from './model.js';

const today = '2026-10-01';
const companyId = '10000000-0000-4000-8000-000000000071';
const typeId = '10000000-0000-4000-8000-000000000072';

describe('AC-FE-R2f-09 合同看板适配', () => {
  it('变动日期默认全年，A/D 共用白名单，明细附带原组键和分页', () => {
    const initial = initialContractFilters(today);
    expect(initial).toEqual({ asOf: today, changeFrom: '2026-01-01', changeTo: '2026-12-31' });
    const filters = { ...initial, changeFrom: '', companyId, typeId, termType: 'fixed', unsupported: 'ignored' };
    const overview = new URL(contractOverviewUrl(filters), 'http://localhost');
    expect(overview.pathname).toBe('/api/tenant/analytics/contract-board');
    expect(Object.fromEntries(overview.searchParams)).toEqual({
      asOf: today,
      changeTo: '2026-12-31',
      companyId,
      typeId,
      termType: 'fixed',
    });
    expect(appliedContractFilters(filters, today).changeFrom).toBe('2026-01-01');
    const asOf = '2026-10-02';
    const detail = new URL(
      contractDetailUrl('signByTermType', { ...filters, asOf }, 2, SEGMENT_NONE),
      'http://localhost',
    );
    expect(detail.pathname).toBe('/api/tenant/analytics/contract-board/components/signByTermType');
    expect(Object.fromEntries(detail.searchParams)).toEqual({
      ...Object.fromEntries(overview.searchParams),
      asOf,
      group: SEGMENT_NONE,
      page: '2',
      pageSize: '20',
    });
    const key = 'ZZ_FER2F_S5_集团 & +/一';
    expect(
      new URL(contractDetailUrl('signByCompany', filters, 1, key), 'http://localhost').searchParams.get('group'),
    ).toBe(key);
    expect(contractDetailUrl('changeCreate', filters, 1)).not.toContain('group=');
  });

  it('校验实际日期及顺序、主数据 UUID、三类期限；空分组仅用于下钻', () => {
    expect(validContractFilters({ companyId, typeId, termType: 'task' }, today)).toBe(true);
    expect(validContractFilters({ changeFrom: '2024-02-29' }, today)).toBe(true);
    const invalid: Record<string, string>[] = [
      { changeFrom: '2026-02-29' },
      { changeFrom: '2027-01-01' },
      { changeTo: '2025-12-31' },
      { changeTo: '2026-13-01' },
      { companyId: 'ZZ_FER2F_S5_公司名称' },
      { typeId: 'ZZ_FER2F_S5_类型名' },
      { termType: SEGMENT_NONE },
    ];
    for (const filters of invalid) expect(validContractFilters(filters, today)).toBe(false);

    const edge = initialContractFilters('9999-12-01');
    expect(validContractFilters(edge, edge.asOf)).toBe(true);
    expect(contractOverviewUrl(edge)).not.toContain('changeTo=');
  });

  it('绑定八个编码与回执顺序，保留全组总数、服务端占比和空期限 0', () => {
    const components = CONTRACT_BOARD_COMPONENTS.map((component) => ({
      ...component,
      value: component.kind === 'groups' ? 8 : 0,
      groups:
        component.code === 'signByCompany'
          ? [
              { key: companyId, label: 'ZZ_FER2F_S5_公司乙', count: 2, ratio: 0.125 },
              { key: typeId, label: 'ZZ_FER2F_S5_公司甲', count: 1, ratio: 0.0625 },
            ]
          : component.code === 'signByTermType'
            ? [{ key: SEGMENT_NONE, label: '空', count: 0 }]
            : null,
    })).reverse();
    const cards = contractCards({ asOf: today, hasDataPermission: true, components });
    expect(cards.map(({ code, kind }) => [code, kind])).toEqual(
      CONTRACT_BOARD_COMPONENTS.map(({ code, kind }) => [code, kind]),
    );
    expect(cards.find(({ code }) => code === 'signByCompany')).toMatchObject({
      text: '8',
      points: [
        { key: companyId, label: 'ZZ_FER2F_S5_公司乙', value: 2, text: '2 人 · 12.5%' },
        { key: typeId, label: 'ZZ_FER2F_S5_公司甲', value: 1, text: '1 人 · 6.25%' },
      ],
    });
    expect(cards.find(({ code }) => code === 'signByTermType')?.points).toEqual([
      { key: SEGMENT_NONE, label: '空', value: 0, text: '0 人' },
    ]);
    expect(cards.at(-1)).toMatchObject({ code: '3.1.17', text: '0' });
  });

  it('变动明细使用申请单 ID，签署和到期使用合同记录 ID，保留空部门 ID', () => {
    const items = [{ id: 'ZZ_FER2F_S5_记录', employeeId: 'ZZ_FER2F_S5_员工', organizationId: null }];
    for (const component of CONTRACT_BOARD_COMPONENTS) {
      const table = contractDetailTable({
        ...component,
        asOf: today,
        hasDataPermission: true,
        group: null,
        page: 2,
        pageSize: 20,
        total: 27,
        items,
      });
      expect(table.columns.map(({ label }) => label)).toEqual([
        component.code.startsWith('change') ? '申请单 ID' : '合同记录 ID',
        '员工 ID',
        '部门 ID',
      ]);
      expect(table.rows).toEqual(items);
      expect(table.total).toBe(27);
    }
  });
});

describe('AC-FE-R2f-11 合同看板复用读取错误语义', () => {
  it.each([
    [400, 'VALIDATION_FAILED', '请检查筛选条件和日期范围', false],
    [404, 'NOT_FOUND', '组件不存在', false],
    [413, 'PAYLOAD_TOO_LARGE', '请缩小筛选范围后重试', false],
    [429, 'RATE_LIMITED', '请求过于频繁，请稍后重试', true],
    [503, 'UNAVAILABLE', '明细加载失败，请重试', true],
    [0, 'NETWORK_ERROR', '明细加载失败，请重试', true],
  ])('%i %s', (status, code, message, retry) => {
    const error = new ApiError(status, code, 'fields', 'ZZ_FER2F_S5_服务端提示');
    expect(boardErrorText(error, true, '组件不存在')).toBe(message);
    expect(canRetryRead(error)).toBe(retry);
  });
});
