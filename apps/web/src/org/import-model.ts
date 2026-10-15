import { slotKey } from '../foundation/forms/slot.js';
import { importText as m } from './messages.js';

/** 导入是新建型命令：集合路径作恢复槽，不带文件名或入口；结果未知时锁定，重开仍锁定（F-142，DEC-502①e/g）。 */
export const orgImportPath = '/api/tenant/org/import';
export const orgImportResource = slotKey(orgImportPath);
export const orgImportTemplate = '/templates/org-import.json';
/** 冲突重读按 orgId 读原单最新版本（GET /api/tenant/org/organizations/:id，默认取当天）。 */
export const orgRecordPath = (orgId: string) => `/api/tenant/org/organizations/${encodeURIComponent(orgId)}`;
/** 与接口 rows.max(100) 一致；超出时前端先拦，不发请求。 */
export const orgImportLimit = 100;
/** 接口必填列（apps/api 组织导入 importRow），也是每行都要写的字段；其余列由服务端整批校验。 */
export const orgImportRequired = ['sourceCode', 'code', 'name', 'parentId'];
/** 行内控制项：服务端逐行校验字段写权时去掉的键（apps/api 组织导入 guard、writeFields）。 */
const controls = ['orgId', 'expectedRevision', 'addEmployment'];
/** 导入逐行预检所需的权限：数据操作权与字段写权（page-model.ts pageAccess 满足）。 */
export interface ImportGate {
  writes(operation: 'create' | 'update'): boolean;
  field(name: string): { editable: boolean };
}

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
  const missing = orgImportRequired.find((key) => {
    const value = (row as ImportRow)[key];
    return typeof value !== 'string' || !value.trim();
  });
  return missing ? m.rowMissing(index + 1, missing) : undefined;
}
/**
 * 逐行按接口口径预检写权（DEC-502①c）：有 orgId 的行是更新，否则是新建；该行除控制项外的每一列都须可写。
 * 带 expectedRevision 的更新行须同时写 orgId：版本冲突后前端按 orgId 重读最新版本（OrgImport），
 * 只靠原系统编码映射的行前端查不到目标，冲突后无法核对，所以先拦下。
 */
function rowDenied(row: ImportRow, index: number, gate: ImportGate) {
  if (row.expectedRevision !== undefined && row.orgId === undefined) return m.rowTarget(index + 1);
  const operation = row.orgId === undefined ? 'create' : 'update';
  if (!gate.writes(operation)) return m.rowOperation(index + 1, m.operations[operation]);
  const field = Object.keys(row).find((key) => !controls.includes(key) && !gate.field(key).editable);
  return field ? m.rowField(index + 1, field) : undefined;
}
/** 读取模板格式的 JSON（{ rows: [...] }）：做行数、必填列与逐行写权的前置检查，行内容原样提交，由服务端整批校验。 */
export function parseOrgImport(text: string, gate: ImportGate): { rows: ImportRow[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: m.invalidJson };
  }
  const rows = (parsed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0) return { error: m.noRows };
  if (rows.length > orgImportLimit) return { error: m.tooMany(orgImportLimit) };
  const problem =
    rows.map(rowProblem).find(Boolean) ?? (rows as ImportRow[]).map((row, i) => rowDenied(row, i, gate)).find(Boolean);
  return problem ? { error: problem } : { rows: rows as ImportRow[] };
}
/**
 * 版本冲突后的重读（F-142「重读 → 核对 → 显式重提」）：带 orgId 的更新行按原单最新版本改写 expectedRevision，
 * 其余列保持文件内容。读回须是同一组织、版本为正整数，否则按读取失败处理，表单保持冲突锁定。
 */
export async function rereadImportRows(rows: readonly ImportRow[], read: (orgId: string) => Promise<unknown>) {
  return Promise.all(
    rows.map(async (row) => {
      if (typeof row.orgId !== 'string') return row;
      const latest = (await read(row.orgId)) as { id?: unknown; revision?: unknown } | null;
      const revision = latest?.revision;
      if (latest?.id !== row.orgId.toLowerCase() || !Number.isSafeInteger(revision) || (revision as number) < 1)
        throw new Error(m.rereadInvalid);
      return { ...row, expectedRevision: revision as number };
    }),
  );
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
