import { describe, expect, it } from 'vitest';
import * as exitImport from './exit-import.js';
import { EXIT_BUTTONS } from './exit.js';
import { EXIT_IMPORT_BUTTON, EXIT_IMPORT_ROW_LIMIT, exitImportEffectiveDate } from './exit-import.js';

describe('F-493 S3a 历史离职导入领域常量', () => {
  it('按钮独立于五个离职按钮，单批上限 1000（设计 §4.1）', () => {
    expect(EXIT_IMPORT_BUTTON).toBe('Employment.DimissionImport');
    expect(Object.values(EXIT_BUTTONS)).not.toContain(EXIT_IMPORT_BUTTON);
    expect(EXIT_IMPORT_ROW_LIMIT).toBe(1000);
  });

  it('离职生效日 = 最后工作日 + 1（跨月 / 跨年 / 闰日）', () => {
    expect(exitImportEffectiveDate('2025-06-30')).toBe('2025-07-01');
    expect(exitImportEffectiveDate('2025-12-31')).toBe('2026-01-01');
    expect(exitImportEffectiveDate('2024-02-28')).toBe('2024-02-29');
  });

  it('旧同步导入的工号 / 日期 / 加黑纯校验已删除（DEC-402 不留兼容）', () => {
    for (const name of ['duplicateEmployeeNoRows', 'validateExitImportDates', 'validateExitImportBlacklist'])
      expect(name in exitImport, name).toBe(false);
  });
});
