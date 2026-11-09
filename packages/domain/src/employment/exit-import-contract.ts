/**
 * F-493 S2 导入契约（先红桩：常量为空、函数返回中性值，真实实现在下一提交）。
 */
export type ExitImportRowKey = string;

export interface ExitImportColumn {
  readonly letter: string;
  readonly name: string;
  readonly required: boolean;
  readonly key: ExitImportRowKey | null;
}

export const EXIT_IMPORT_COLUMNS: readonly ExitImportColumn[] = [];
export const EXIT_IMPORT_BODY_LIMIT = 0;
export const EXIT_IMPORT_MAX_ATTEMPTS = 0;
export const EXIT_IMPORT_FILE_TTL_DAYS = 0;
export const EXIT_IMPORT_HISTORY_PAGE_SIZE = 0;
export const EXIT_IMPORT_REASONS: readonly string[] = [];

export function normalizeExitImportDate(_text: string): string | null {
  return null;
}

export function exitImportErrorText(_column: string | null, _reason: string, _value?: string | null, _limit?: number) {
  return '';
}
