import { describe, expect, it } from 'vitest';
import { EXIT_BUTTONS } from './exit.js';
import {
  EXIT_IMPORT_BUTTON,
  EXIT_IMPORT_ROW_LIMIT,
  duplicateEmployeeNoRows,
  exitImportEffectiveDate,
  validateExitImportBlacklist,
  validateExitImportDates,
} from './exit-import.js';

const TODAY = '2026-11-05';
const dates = (entryDate: string, lastWorkDate: string) => validateExitImportDates({ entryDate, lastWorkDate }, TODAY);
const reasons = (issues: readonly { reason: string }[]) => issues.map((issue) => issue.reason);

describe('F-139a 历史离职导入行字段纯校验', () => {
  it('按钮独立于五个离职按钮，批量上限 100', () => {
    expect(EXIT_IMPORT_BUTTON).toBe('Employment.DimissionImport');
    expect(Object.values(EXIT_BUTTONS)).not.toContain(EXIT_IMPORT_BUTTON);
    expect(EXIT_IMPORT_ROW_LIMIT).toBe(100);
  });

  it('离职生效日 = 最后工作日 + 1（跨月 / 跨年 / 闰日）', () => {
    expect(exitImportEffectiveDate('2025-06-30')).toBe('2025-07-01');
    expect(exitImportEffectiveDate('2025-12-31')).toBe('2026-01-01');
    expect(exitImportEffectiveDate('2024-02-28')).toBe('2024-02-29');
  });

  it('合法区间无问题；H = L 允许（一天在职）', () => {
    expect(dates('2023-03-01', '2025-06-30')).toEqual([]);
    expect(dates('2025-06-30', '2025-06-30')).toEqual([]);
  });

  it('H > L：EXIT_IMPORT_RANGE_INVERTED', () => {
    expect(reasons(dates('2025-07-01', '2025-06-30'))).toEqual(['EXIT_IMPORT_RANGE_INVERTED']);
  });

  it('L 为今天或之后：EXIT_IMPORT_NOT_HISTORICAL（L = 今天也拒绝）；昨天放行', () => {
    expect(reasons(dates('2023-03-01', TODAY))).toEqual(['EXIT_IMPORT_NOT_HISTORICAL']);
    expect(reasons(dates('2023-03-01', '2026-11-30'))).toEqual(['EXIT_IMPORT_NOT_HISTORICAL']);
    expect(dates('2023-03-01', '2026-11-04')).toEqual([]);
  });

  it('日期格式非法或不存在：VALIDATION_FAILED 并指出字段，不再判区间', () => {
    expect(dates('2023-02-30', '2025-06-30')).toEqual([
      expect.objectContaining({ reason: 'VALIDATION_FAILED', field: 'entryDate' }),
    ]);
    expect(dates('2023-03-01', '2025/06/30')).toEqual([
      expect.objectContaining({ reason: 'VALIDATION_FAILED', field: 'lastWorkDate' }),
    ]);
    expect(dates('', '')).toHaveLength(2);
  });

  it('批内重复工号：两行都命中，大小写与首尾空白按同一工号', () => {
    const rows = [
      { rowNo: 1, employeeNo: 'H0001' },
      { rowNo: 2, employeeNo: 'H0002' },
      { rowNo: 3, employeeNo: ' H0001 ' },
      { rowNo: 4, employeeNo: 'h0002' },
      { rowNo: 5, employeeNo: 'H0005' },
    ];
    expect([...duplicateEmployeeNoRows(rows)].sort()).toEqual([1, 2, 3, 4]);
    expect(duplicateEmployeeNoRows([{ rowNo: 1, employeeNo: 'H0001' }]).size).toBe(0);
  });

  it('加黑三项：勾选必须有原因；截止日须不早于离职生效日；不勾选时三项被忽略', () => {
    const E = '2025-07-01';
    const check = (input: object) => reasons(validateExitImportBlacklist({ addToBlacklist: true, ...input }, E));
    expect(check({})).toEqual(['EXIT_BLACKLIST_REASON_REQUIRED']);
    expect(check({ blacklistReason: 'instability' })).toEqual([]);
    expect(check({ blacklistReason: 'instability', blacklistExpiryDate: '2025-06-30' })).toEqual([
      'EXIT_BLACKLIST_EXPIRY_BEFORE_EFFECTIVE',
    ]);
    expect(check({ blacklistReason: 'instability', blacklistExpiryDate: E })).toEqual([]);
    expect(validateExitImportBlacklist({ addToBlacklist: false, blacklistExpiryDate: '1999-01-01' }, E)).toEqual([]);
  });
});
