import { ROSTER_EXPORT_MAX_ROWS, rosterCellText, type RosterColumn } from '@italent/domain';
import type { Context } from 'hono';
import type { ErrorBody } from '../../errors.js';
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

/**
 * 超限：422 + 机器可读 reason（总编排补充 6）。错误框架（ERROR_STATUS）没有 422 码、也不为这一处新造全局码，
 * 所以沿用既有错误码 VALIDATION_FAILED，只在本路由把 HTTP 状态定为 422；客户端按 code + details.reason 判断。
 */
export function exportLimitResponse(c: Context, total: number): Response {
  const body = {
    error: {
      code: 'VALIDATION_FAILED',
      message: `导出最多 ${ROSTER_EXPORT_MAX_ROWS} 行，请缩小筛选范围`,
      details: { reason: 'EXPORT_ROW_LIMIT', limit: ROSTER_EXPORT_MAX_ROWS, total },
    },
  } satisfies ErrorBody;
  return c.json(body, 422);
}
