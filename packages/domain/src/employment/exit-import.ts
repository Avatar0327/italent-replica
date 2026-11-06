// 红提交占位：只导出接口形状，行为在实现提交里补全（F-139a）。
export const EXIT_IMPORT_BUTTON = 'Employment.DimissionImport';
export const EXIT_IMPORT_ROW_LIMIT = 100;
export interface ExitImportIssue {
  readonly field?: string;
  readonly reason: string;
  readonly message: string;
}
export const exitImportEffectiveDate = (lastWorkDate: string): string => lastWorkDate;
export const validateExitImportDates = (
  _row: { entryDate: string; lastWorkDate: string },
  _today: string,
): ExitImportIssue[] => [];
export const duplicateEmployeeNoRows = (
  _rows: readonly { rowNo: number; employeeNo: string }[],
): Set<number> => new Set();
export const validateExitImportBlacklist = (
  _row: { addToBlacklist?: boolean; blacklistReason?: string; blacklistExpiryDate?: string },
  _effectiveDate: string,
): ExitImportIssue[] => [];
