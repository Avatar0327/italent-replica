import { describe, expect, it } from 'vitest';
import { cellText, initialFilters, reportOf, reportUrl, tablesOf } from './model.js';

describe('AC-FE-R2f-07 员工结构报表适配', () => {
  it('两张报表默认以租户时点查询内部员工，包含下级，可显式关掉且不带 B49 参数或分页', () => {
    const date = '2026-10-13';
    expect(initialFilters('position', date)).toEqual({
      asOf: date,
      employType: 'internal',
      departmentIncludeChildren: 'true',
    });
    for (const code of ['quality', 'position']) {
      const report = reportOf(code)!;
      const url = reportUrl(
        report,
        {
          ...initialFilters(code, date),
          departmentId: '10000000-0000-4000-8000-000000000002',
          departmentIncludeChildren: 'false',
          employmentForm: 'ZZ_FER2F_FORM',
          employmentType: 'ZZ_FER2F_CATEGORY',
        },
        2,
      );
      expect(url).toBe(
        `/api/tenant/analytics/hr-structure/reports/${code}?asOf=${date}&employType=internal&` +
          'departmentId=10000000-0000-4000-8000-000000000002&departmentIncludeChildren=false',
      );
    }
  });

  it('动态列按回执顺序，合计取回执，占比保留最多两位，平均年龄和司龄保留回执精度', () => {
    const columns = [
      { key: 'source:ZZ_FER2F_推荐:ratio', label: 'ZZ_FER2F_推荐:ratio' },
      { key: 'category:ZZ_FER2F_类别', label: 'ZZ_FER2F_类别' },
      { key: 'employType:intern:ratio', label: '实习生占比' },
      { key: 'avgAge', label: '平均年龄' },
      { key: 'avgTenure', label: '平均司龄' },
    ];
    const cells = { 'source:ZZ_FER2F_推荐:ratio': 3, 'employType:intern:ratio': 0.1667, avgAge: 25, avgTenure: 1.2 };
    const summary = { 'source:ZZ_FER2F_推荐:ratio': 8, 'employType:intern:ratio': 0.25, avgAge: 24.6, avgTenure: null };
    const [table] = tablesOf('position', {
      columns,
      rows: [{ organizationName: 'ZZ_FER2F_组织', cells }],
      summary: { cells: summary },
      hasDataPermission: true,
    });
    expect(table!.columns.slice(1)).toEqual(columns);
    expect(table!.rows).toEqual([{ ...cells, _label: 'ZZ_FER2F_组织' }]);
    expect(table!.summary).toEqual({ ...summary, _label: '合计' });
    expect(columns.map(({ key }) => cellText(key, cells[key as keyof typeof cells]))).toEqual([
      '3',
      '—',
      '16.67%',
      '25',
      '1.2',
    ]);
    expect(columns.map(({ key }) => cellText(key, summary[key as keyof typeof summary]))).toEqual([
      '8',
      '—',
      '25%',
      '24.6',
      '—',
    ]);
  });
});
