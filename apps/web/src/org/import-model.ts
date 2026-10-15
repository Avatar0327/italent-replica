import { slotKey } from '../foundation/forms/slot.js';
import { importText as m } from './messages.js';

/** 导入是新建型命令：集合路径作恢复槽，不带文件名或入口；结果未知时锁定，重开仍锁定（F-142，DEC-502①e/g）。 */
export const orgImportPath = '/api/tenant/org/import';
export const orgImportResource = slotKey(orgImportPath);
export const orgImportTemplate = '/templates/org-import.json';
/** 与接口 rows.max(100) 一致；超出时前端先拦，不发请求。 */
export const orgImportLimit = 100;
/** 接口必填列（apps/api 组织导入 importRow）；其余列由服务端整批校验。 */
const requiredColumns = ['sourceCode', 'code', 'name', 'parentId'];

export type ImportRow = Record<string, unknown>;
export interface OrgImportResult {
  sourceCode: string;
  code: string;
  status: 'created' | 'updated' | 'conflict';
  orgId?: string;
  reason?: string | null;
}
const statuses = ['created', 'updated', 'conflict'];

function rowProblem(row: unknown, index: number) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return m.rowInvalid(index + 1);
  const missing = requiredColumns.find((key) => {
    const value = (row as ImportRow)[key];
    return typeof value !== 'string' || !value.trim();
  });
  return missing ? m.rowMissing(index + 1, missing) : undefined;
}
/** 读取模板格式的 JSON（{ rows: [...] }）：只做行数与必填列的前置检查，行内容原样提交，由服务端整批校验。 */
export function parseOrgImport(text: string): { rows: ImportRow[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: m.invalidJson };
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return { error: m.noRows };
  if (rows.length > orgImportLimit) return { error: m.tooMany(orgImportLimit) };
  const problem = rows.map(rowProblem).find(Boolean);
  return problem ? { error: problem } : { rows: rows as ImportRow[] };
}

function validResult(item: unknown, row: ImportRow | undefined): item is OrgImportResult {
  const result = item as Partial<OrgImportResult> | null;
  return (
    !!result &&
    !!row &&
    result.sourceCode === row.sourceCode &&
    typeof result.code === 'string' &&
    statuses.includes(String(result.status)) &&
    (result.orgId === undefined || typeof result.orgId === 'string') &&
    (result.reason === undefined || result.reason === null || typeof result.reason === 'string')
  );
}
/**
 * 回执按接口真实形状核对：200 { results: [...] }，与提交行逐行对应（同序、同 sourceCode）。
 * 不符时返回 undefined，调用方据此按结果未知处理（锁定），不当作成功。
 */
export function orgImportReceipt(rows: readonly ImportRow[], receipt: unknown): OrgImportResult[] | undefined {
  const results = (receipt as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== rows.length) return undefined;
  return results.every((item, index) => validResult(item, rows[index])) ? results : undefined;
}
