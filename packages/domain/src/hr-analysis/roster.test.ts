import { describe, expect, it } from 'vitest';
import { ROSTER_COLUMNS, ROSTER_FIXED_COLUMNS, rosterCellText, tenureYears } from './roster.js';

describe('时点花名册列与取值（BE-12a）', () => {
  it('除“人员”固定列外共 49 列，key 与标签都不重复，固定列是姓名 + 工号', () => {
    expect(ROSTER_COLUMNS).toHaveLength(49);
    expect(ROSTER_FIXED_COLUMNS.map((column) => column.label)).toEqual(['姓名', '工号']);
    const all = [...ROSTER_FIXED_COLUMNS, ...ROSTER_COLUMNS];
    expect(new Set(all.map((column) => column.key)).size).toBe(all.length);
    expect(new Set(all.map((column) => column.label)).size).toBe(all.length);
    expect(ROSTER_COLUMNS[0]?.label).toBe('职级');
    expect(ROSTER_COLUMNS.at(-1)?.label).toBe('实际终止时间');
  });

  it('每列至少声明一条字段权来源；直线经理邮箱须同时有任职与人员两处权限', () => {
    for (const column of ROSTER_COLUMNS) expect(column.gate.length, column.key).toBeGreaterThan(0);
    expect(ROSTER_COLUMNS.find((column) => column.key === 'directManagerEmail')?.gate).toEqual([
      ['record', 'directManagerId'],
      ['person', 'workEmail'],
    ]);
  });

  it('累计司龄 / 工龄 = (asOf − 起算日) / 365，1 位小数向下舍位；起算日空或晚于 asOf 为空', () => {
    expect(tenureYears('2025-01-01', '2025-07-01')).toBe('0.4');
    expect(tenureYears('2012-07-01', '2025-07-01')).toBe('13.0');
    expect(tenureYears('2025-07-01', '2025-07-01')).toBe('0.0');
    expect(tenureYears('2025-07-02', '2025-07-01')).toBeNull();
    expect(tenureYears(null, '2025-07-01')).toBeNull();
  });

  it('导出单元格：状态、期限类型、布尔转中文，空为空串', () => {
    expect(rosterCellText('employeeStatus', 2)).toBe('试用');
    expect(rosterCellText('employeeStatus', 3)).toBe('正式');
    expect(rosterCellText('contractTermType', 'indefinite')).toBe('无固定期限');
    expect(rosterCellText('hasProbation', true)).toBe('是');
    expect(rosterCellText('hasProbation', false)).toBe('否');
    expect(rosterCellText('gender', null)).toBe('');
    expect(rosterCellText('age', 34)).toBe('34');
  });
});
