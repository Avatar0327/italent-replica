/**
 * F-493 S3c 历史离职人员导入的下载文件（设计 §3.1、§8.2、§8.3）：模板与错误文件的 xlsx 装配、错误文件的权限复核与按字段裁剪。
 * 路由只做编排；S3d 的“原文件下载”复用这里的 requireExitImportDownloadAccess 与 viewableColumns / dataValue。
 * 单元格只写文本（statWorkbook 的 inlineStr），没有公式；空值不写格。
 */
import { and, asc, eq, exitImportRows, inArray, type Tx } from '@italent/db';
import {
  EXIT_IMPORT_BUTTON,
  EXIT_IMPORT_COLUMNS,
  exitImportErrorText,
  normalizeExitImportDate,
  PERSONNEL_OBJECT,
  SUBSETS,
  tenantLocalDate,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { statWorkbook, StatSheet } from '../analytics/stat-xlsx.js';
import { getModuleViewableFields, resolveModuleScope } from '../permission/module-access.js';
import { EMPLOYEE_OBJECT, EMPLOYMENT_OBJECT, requireEmploymentWrite, type EmploymentContext } from './context.js';
import { exitImportLimitOf } from './exit-import-shape.js';

export const ERROR_FILE_NAME = '下载导入错误报告.xlsx';
export const TEMPLATE_FILE_NAME = '历史离职人员导入模板.xlsx';

/** 第 1 行：A～Z 共 26 个列名，模板、错误文件、（S3d）原文件共用同一份常量。 */
function headerSheet(): StatSheet {
  const sheet = new StatSheet();
  for (const column of EXIT_IMPORT_COLUMNS) sheet.set(`${column.letter}1`, column.name);
  return sheet;
}

export const templateWorkbook = (): Buffer => statWorkbook(headerSheet());

/**
 * 下载入口权限复核（设计 §8.2）：每次下载都按提交人“当前”权限判，不豁免提交人。
 * 任职功能权由 functionContext 判过；这里补导入按钮（只判命令权 commandOnly：撤字段查看权不拦下载，由 viewableColumns 把对应列置空）。
 * 任职对象不查数据范围：模板不含数据，错误文件只给提交人本人的批次。
 */
export async function requireExitImportButton(ctx: EmploymentContext): Promise<void> {
  await requireEmploymentWrite(ctx, 'create', {}, EXIT_IMPORT_BUTTON, EMPLOYMENT_OBJECT, { commandOnly: true });
}

/** 错误文件：人员、档案两个对象都必须是显式“看全部”范围（fail-closed，设计 §8.2）。 */
export async function requireExitImportDownloadAccess(deps: TenantRouteDeps, ctx: EmploymentContext): Promise<void> {
  if (!ctx.authorize) return;
  await requireExitImportButton(ctx);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  for (const object of [EMPLOYEE_OBJECT, PERSONNEL_OBJECT]) {
    const scope = await resolveModuleScope(deps, ctx, today, object);
    if (!scope?.all) throw new AppError('FORBIDDEN', '下载导入文件需要人员与档案对象的“全部数据”范围');
  }
}

/** 列字母 → 权限对象与字段（Z 离职说明永远可见，不在表内）。 */
const RECORD = EMPLOYMENT_OBJECT;
const EDUCATION = SUBSETS.education.objectCode;
const FIELD_OF: Readonly<Record<string, readonly [object: string, field: string]>> = {
  B: [EMPLOYEE_OBJECT, 'name'],
  C: [PERSONNEL_OBJECT, 'email'],
  D: [RECORD, 'departmentId'],
  E: [RECORD, 'effectiveDate'],
  F: [RECORD, 'positionId'],
  G: [RECORD, 'postId'],
  H: [RECORD, 'levelId'],
  I: [PERSONNEL_OBJECT, 'workDate'],
  J: [RECORD, 'place'],
  K: [PERSONNEL_OBJECT, 'idNumber'],
  L: [PERSONNEL_OBJECT, 'mobilePhone'],
  M: [PERSONNEL_OBJECT, 'backupMail'],
  N: [PERSONNEL_OBJECT, 'gender'],
  O: [PERSONNEL_OBJECT, 'birthday'],
  P: [PERSONNEL_OBJECT, 'nation'],
  Q: [PERSONNEL_OBJECT, 'politicalStatus'],
  R: [PERSONNEL_OBJECT, 'householdAddress'],
  S: [PERSONNEL_OBJECT, 'registAddress'],
  T: [EDUCATION, 'school'],
  U: [EDUCATION, 'major'],
  V: [RECORD, 'lastWorkDate'],
  W: [RECORD, 'exitTypeCode'],
  X: [RECORD, 'reasonCode'],
  Y: [RECORD, 'whereaboutsCode'],
};

/** 提交人当前有查看权的列字母（设计 §8.2：按当前字段权裁剪，原始值不外泄）。 */
export async function viewableColumns(deps: TenantRouteDeps, ctx: EmploymentContext): Promise<ReadonlySet<string>> {
  const objects = [...new Set(Object.values(FIELD_OF).map(([object]) => object))];
  const viewable = new Map<string, ReadonlySet<string> | undefined>();
  for (const object of objects) viewable.set(object, await getModuleViewableFields(deps, ctx, object));
  const shown = new Set<string>(['A', 'Z']);
  for (const [letter, [object, field]] of Object.entries(FIELD_OF)) {
    const fields = viewable.get(object);
    if (fields === undefined || fields.has(field)) shown.add(letter);
  }
  return shown;
}

const DATE_COLUMNS = new Set(['E', 'I', 'O', 'V']);
/** 日期列规整成 yyyy/mm/dd，规整不了保留原文。 */
function dataValue(letter: string, value: string | null): string | null {
  if (value === null || !DATE_COLUMNS.has(letter)) return value;
  const iso = normalizeExitImportDate(value);
  return iso ? iso.replaceAll('-', '/') : value;
}

export interface ErrorFileRow {
  readonly rowNo: number;
  readonly values: Readonly<Record<string, string | null>>;
  readonly errors: readonly { column: string | null; reason: string }[];
}

/** A 列：本行全部错误原文以「；」连接；无查看权的列换成 FIELD_HIDDEN 文案；整行级错误原样输出。 */
function errorCell(row: ErrorFileRow, shown: ReadonlySet<string>): string {
  const texts: string[] = [];
  for (const error of row.errors) {
    const hidden = error.column !== null && !shown.has(error.column);
    const text = hidden
      ? exitImportErrorText(error.column, 'FIELD_HIDDEN')
      : exitImportErrorText(
          error.column,
          error.reason as Parameters<typeof exitImportErrorText>[1],
          error.column ? (row.values[error.column] ?? '') : '',
          exitImportLimitOf(error.column),
        );
    if (!texts.includes(text)) texts.push(text);
  }
  return texts.join('；');
}

export function errorWorkbook(rows: readonly ErrorFileRow[], shown: ReadonlySet<string>): Buffer {
  const sheet = headerSheet();
  rows.forEach((row, index) => {
    const line = index + 2;
    sheet.set(`A${line}`, errorCell(row, shown));
    for (const column of EXIT_IMPORT_COLUMNS.slice(1))
      if (shown.has(column.letter))
        sheet.set(`${column.letter}${line}`, dataValue(column.letter, row.values[column.letter] ?? null));
  });
  return statWorkbook(sheet);
}

/** 一行的 25 个原始列：列字母 → 提交时的原文（B～Z；A 无来源）。 */
function rawValues(row: typeof exitImportRows.$inferSelect): Record<string, string | null> {
  return Object.fromEntries(
    EXIT_IMPORT_COLUMNS.filter((column) => column.key !== null).map((column) => [
      column.letter,
      (row as unknown as Record<string, string | null>)[column.key!] ?? null,
    ]),
  );
}

/** 错误文件的数据行：failed / created_with_error，按 rowNo；列字母 → 原始值。 */
export async function loadErrorFileRows(tx: Tx, tenantId: string, batchId: string): Promise<ErrorFileRow[]> {
  const rows = await tx
    .select()
    .from(exitImportRows)
    .where(
      and(
        eq(exitImportRows.tenantId, tenantId),
        eq(exitImportRows.batchId, batchId),
        inArray(exitImportRows.status, ['failed', 'created_with_error']),
      ),
    )
    .orderBy(asc(exitImportRows.rowNo));
  return rows.map((row) => ({ rowNo: row.rowNo, errors: row.errors, values: rawValues(row) }));
}

/** 原文件的数据行：批次全部行（成功、失败都在），按 rowNo。 */
export async function loadSourceFileRows(tx: Tx, tenantId: string, batchId: string): Promise<ErrorFileRow[]> {
  const rows = await tx
    .select()
    .from(exitImportRows)
    .where(and(eq(exitImportRows.tenantId, tenantId), eq(exitImportRows.batchId, batchId)))
    .orderBy(asc(exitImportRows.rowNo));
  return rows.map((row) => ({ rowNo: row.rowNo, errors: row.errors, values: rawValues(row) }));
}

/**
 * 原文件（设计 §8.4）：由明细行重建，不是用户上传的原始字节。A 列「导入结果」留空；B～Z 写提交的原文，
 * 日期列不规整（与错误文件不同，保持“所提交的样子”）；当前无查看权的列整列留空。
 */
export function sourceWorkbook(rows: readonly ErrorFileRow[], shown: ReadonlySet<string>): Buffer {
  const sheet = headerSheet();
  rows.forEach((row, index) => {
    for (const column of EXIT_IMPORT_COLUMNS.slice(1))
      if (shown.has(column.letter)) sheet.set(`${column.letter}${index + 2}`, row.values[column.letter] ?? null);
  });
  return statWorkbook(sheet);
}
