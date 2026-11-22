import { expect, it } from 'vitest';
import { catalogReportOf, cellText, initialFilters, reportOf, reportUrl, supportsStatExport } from './model.js';

const asOf = '2026-10-06';
const departmentId = '10000000-0000-4000-8000-000000000002';

it.each(['inflow', 'outflow', 'establishment'])('AC-FE-R2f-08 %s 只传时点、年度和含下级的部门', (code) => {
  const report = reportOf(code);
  const endpoint = `/api/tenant/analytics/hr-movement/reports/${code}`;
  expect(report?.endpoint, '数据分析应登记此统计报表端点').toBe(endpoint);
  expect(catalogReportOf(code)).toBeUndefined();
  expect(supportsStatExport(code)).toBe(false);
  const filters = initialFilters(code, asOf);
  expect(filters).toEqual({ asOf, year: '2026' });
  const url = new URL(
    reportUrl(
      report!,
      {
        ...filters,
        year: '2025',
        departmentId,
        departmentLabel: 'ZZ_FER2F_上级',
        departmentIncludeChildren: 'false',
        parentId: departmentId,
        month: '4',
        employType: 'internal',
      },
      2,
    ),
    'https://example.com',
  );
  expect(url.pathname).toBe(endpoint);
  expect(Object.fromEntries(url.searchParams)).toEqual({ asOf, year: '2025', departmentId });
});

it('AC-FE-R2f-08 组织编制执行率显示服务端百分比，零值与空值有别', () => {
  expect(cellText('executionRate', 0.1538), '执行率按服务端小数格式化').toBe('15.38%');
  expect(cellText('executionRate', 0)).toBe('0%');
  expect(cellText('executionRate', null)).toBe('—');
});
