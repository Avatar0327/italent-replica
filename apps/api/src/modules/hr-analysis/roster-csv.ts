import { ROSTER_EXPORT_MAX_ROWS, rosterCellText, type RosterColumn } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { Row } from '../personnel/store.js';

/** UTF-8 BOM：Excel 直接打开不乱码。 */
const BOM = '﻿';
/** 以这些字符开头的单元格会被表格软件当公式执行，前置单引号中和（CSV 注入）。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function cell(text: string): string {
  const safe = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** 表头 + 数据行（列与列表一致：由调用方传入同一份可见列）。 */
export function rosterCsv(columns: readonly RosterColumn[], items: readonly Row[]): string {
  const lines = [
    columns.map((column) => cell(column.label)).join(','),
    ...items.map((item) => columns.map((column) => cell(rosterCellText(column.key, item[column.key]))).join(',')),
  ];
  return BOM + lines.join('\r\n') + '\r\n';
}

export function assertExportable(total: number) {
  if (total > ROSTER_EXPORT_MAX_ROWS)
    throw new AppError('VALIDATION_FAILED', `导出最多 ${ROSTER_EXPORT_MAX_ROWS} 行，请缩小筛选范围`, {
      reason: 'EXPORT_ROW_LIMIT',
    });
}
