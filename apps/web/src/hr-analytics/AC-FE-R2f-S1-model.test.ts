import { HR_DASHBOARD_INDICATORS, type HrDashboardCode } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { cellText } from '../hr-reports/model.js';
import { detailTable, indicatorGroups, validAsOf } from './model.js';

describe('AC-FE-R2f-02 B48 只读适配', () => {
  it('按设计分区，不将空值或真实零值互换', () => {
    const indicators = HR_DASHBOARD_INDICATORS.map((item) => ({
      ...item,
      value: item.no === 6 ? null : 0,
    })).reverse();
    const groups = indicatorGroups(indicators);
    expect(groups.map(({ items }) => items.length)).toEqual([4, 4, 6, 5, 4]);
    expect(groups.flatMap(({ items }) => items.map(({ no }) => no))).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 1),
    );
    expect(cellText('value', groups[1]?.items[1]?.value)).toBe('—');
    expect(cellText('value', groups[0]?.items[0]?.value)).toBe('0');
  });

  const subjects: [HrDashboardCode, string, boolean][] = [
    ['regularEmployees', '员工 ID', false],
    ['pendingEntries', '记录 ID', true],
    ['contractExpiring30', '合同记录 ID', true],
    ['contractOverdue', '合同记录 ID', true],
    ['regularizationInProgress', '申请单 ID', true],
    ['contractApproving', '申请单 ID', true],
    ['offerApproving', 'Offer ID', true],
    ['departmentNoHrbp', '部门 ID', true],
  ];
  it.each(subjects)('%s 明细列按主体展示，保持 employeeId 为 null', (code, label, showEmployee) => {
    const indicator = HR_DASHBOARD_INDICATORS.find((item) => item.code === code)!;
    const items = [{ id: 'ZZ_FER2F_record', employeeId: null }];
    const result = detailTable({
      ...indicator,
      asOf: '2026-01-06',
      hasDataPermission: true,
      total: 1,
      page: 1,
      pageSize: 20,
      items,
    });
    expect(result.columns.map((column) => column.label)).toEqual(showEmployee ? [label, '员工 ID'] : [label]);
    expect(result.rows).toEqual(items);
  });
});

it('AC-FE-R2f-11 时点校验与看板接口历法和极值一致', () => {
  const valid = ['0001-01-02', '2024-02-29', '9999-12-01'];
  const invalid = ['', '0000-01-02', '0001-01-01', '2025-02-29', '2026-03-32', '9999-12-02', '2026-3-01'];
  expect(valid.every(validAsOf)).toBe(true);
  expect(invalid.some(validAsOf)).toBe(false);
});
