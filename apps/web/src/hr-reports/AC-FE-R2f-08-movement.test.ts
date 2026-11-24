import { expect, it } from 'vitest';
import {
  catalogReportOf,
  cellText,
  initialFilters,
  reportOf,
  reportUrl,
  supportsStatExport,
  tablesOf,
} from './model.js';

const asOf = '2026-10-06';
const root = '10000000-0000-4000-8000-000000000002';
const parent = '10000000-0000-4000-8000-000000000003';

it('AC-FE-R2f-08 年度流动使用已有统计端点，带已应用的部门及下钻节点', () => {
  const report = reportOf('flow');
  expect(report?.endpoint, '员工流动统计应登记现有年度报表端点').toBe('/api/tenant/analytics/hr-movement/reports/flow');
  expect(catalogReportOf('flow')).toBeUndefined();
  expect(supportsStatExport('flow')).toBe(false);
  expect(initialFilters('flow', asOf)).toEqual({ asOf, year: '2026' });
  const url = reportUrl(
    report!,
    {
      asOf,
      year: '2025',
      month: '8',
      departmentId: root,
      departmentLabel: 'ZZ_FER2F_部门',
      departmentIncludeChildren: 'false',
      parentId: parent,
    },
    2,
  );
  expect(Object.fromEntries(new URLSearchParams(url.split('?')[1]))).toEqual({
    asOf,
    year: '2025',
    departmentId: root,
    parentId: parent,
  });
});

it.each(['monthly', 'institution'])('AC-FE-R2f-08 %s 共用目录报表及下载，白名单按端点区分', (code) => {
  const report = reportOf(code)!;
  expect(report).toBe(catalogReportOf(code));
  const filters = {
    ...initialFilters(code, asOf),
    month: '5',
    departmentId: root,
    departmentLabel: 'ZZ_FER2F_部门',
    departmentIncludeChildren: 'true',
    parentId: parent,
  };
  const url = reportUrl(report, filters, 1, true, 'formula');
  expect(Object.fromEntries(new URLSearchParams(url.split('?')[1]))).toEqual({
    asOf,
    year: '2026',
    departmentId: root,
    ...(code === 'institution' ? { month: '5' } : {}),
    mode: 'formula',
  });
});

it('AC-FE-R2f-08 年初 100 → 年底 120 按服务端比例显示 18.2%，保留合计与空值', () => {
  const cells = { yearStart: 100, yearEnd: 120, growthRate: 0.1818 };
  const summary = { yearStart: 250, yearEnd: 250, growthRate: 0 };
  const [table] = tablesOf('flow', {
    asOf,
    year: 2026,
    month: null,
    hasDataPermission: true,
    tables: [
      {
        key: 'flow',
        columns: [{ key: 'growthRate', label: '绝对增长率' }],
        rows: [{ key: parent, label: 'ZZ_FER2F_同名组织', cells }],
        summary: { cells: summary },
      },
    ],
  });
  expect(cellText('growthRate', table!.rows[0]?.growthRate), '按接口小数显示一位百分比').toBe('18.2%');
  expect(cellText('growthRate', table!.summary?.growthRate)).toBe('0.0%');
  expect(cellText('rate', null)).toBe('—');
});
