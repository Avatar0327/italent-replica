/**
 * F-482 三张统计报表导出的验收夹具：读 xlsx、两种下载方式的对照、导出操作日志查询。
 * 期望值由各用例手写；这里只放“怎么取文件、怎么读文件”，不重复实现被测逻辑。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { evaluateFormula, formulaCells, readXlsx, type Xlsx } from './support/xlsx-read.js';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export type ExportMode = 'data' | 'formula';
type Get = (path: string) => Promise<Response>;

/** 页面已运行的筛选原样带上，再加下载方式。 */
export const exportPath = (base: string, code: string, query: string, mode: ExportMode | string) =>
  `${base}/reports/${code}/export?${[query, `mode=${mode}`].filter(Boolean).join('&')}`;

/** 取一个导出文件：断言 200 与文件头，返回解析结果与响应头。 */
export async function downloadXlsx(get: Get, path: string, fileName: string) {
  const response = await get(path);
  expect(
    response.status,
    await response
      .clone()
      .text()
      .catch(() => ''),
  ).toBe(200);
  expect(response.headers.get('content-type')).toContain(XLSX_TYPE);
  const disposition = response.headers.get('content-disposition') ?? '';
  expect(decodeURIComponent(disposition), '文件名 = 报表名.xlsx').toContain(fileName);
  return { book: readXlsx(Buffer.from(await response.arrayBuffer())), disposition };
}

/** 全部字符串单元格（升序去重），用来断言“文件里没有多余文字”。 */
export const stringsOf = (book: Xlsx) =>
  [...new Set([...book.cells.values()].filter((cell) => cell.type === 's').map((cell) => String(cell.value)))].sort();

/** 某段文字所在的单元格引用（找不到抛错）。 */
export function refOf(book: Xlsx, prefix: string): string {
  const hit = [...book.cells].find(([, cell]) => cell.type === 's' && String(cell.value).startsWith(prefix));
  if (!hit) throw new Error(`文件里没有以「${prefix}」开头的单元格`);
  return hit[0];
}

/**
 * 两种下载方式数值一致：同一批单元格、同一批值；公式版的每个公式按引用重新算一遍，等于它的缓存值，
 * 也等于数据版同一格的值（离职率不取整，用 1e-12 容差）。
 */
export function expectModesEqual(data: Xlsx, formula: Xlsx) {
  expect([...formula.cells.keys()].sort()).toEqual([...data.cells.keys()].sort());
  for (const [ref, cell] of formula.cells) {
    const plain = data.cells.get(ref)!;
    expect(plain.formula, `${ref} 数据版不带公式`).toBeUndefined();
    expect(cell.type, `${ref} 类型`).toBe(plain.type);
    if (cell.type === 's') expect(cell.value, ref).toBe(plain.value);
    else expect(cell.value as number, ref).toBeCloseTo(plain.value as number, 12);
  }
  for (const [ref, cell] of formulaCells(formula))
    expect(evaluateFormula(formula, cell.formula!), `${ref} 公式 ${cell.formula} 的结果`).toBeCloseTo(
      cell.value as number,
      12,
    );
}

export interface OperationLogRow {
  actor_user_id: string | null;
  behavior: string;
  object_type: string;
  object_id: string | null;
  summary: string;
  total_count: number;
  result: string;
  attachment: Record<string, unknown> | null;
  occurred_at: string | Date;
}

/** 导出操作日志（租户内，按对象类型 + 行为），按时间升序。读取放进该租户的 withTenant。 */
export function exportLogs(db: Db, tenantId: string, objectType: string) {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT actor_user_id, behavior, object_type, object_id, summary, total_count,
        result, attachment, occurred_at FROM audit_operation_logs
      WHERE tenant_id = ${tenantId} AND object_type = ${objectType} AND behavior = 'export' ORDER BY occurred_at, id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as OperationLogRow[];
  });
}
