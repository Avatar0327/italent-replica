/**
 * F-493 历史离职人员导入：请求体解析与行形状校验（设计 §3.2、§3.3 第 1 步）。
 * 只做不读库的判断：整批拒绝的条件、必填 / 长度 / 日期 / 邮箱 / 性别民族政治面貌选项。读库的引用、区间、写入在执行器里。
 * 一行 = rowNo + 25 个键（B～Z），键必须齐全，值为 string | null；其余一律行级报告。
 */
import {
  EXIT_IMPORT_COLUMNS,
  EXIT_IMPORT_ROW_LIMIT,
  PROFILE_GENDER_OPTIONS,
  PROFILE_NATION_OPTIONS,
  PROFILE_POLITICAL_STATUS_OPTIONS,
  checkProfileOption,
  normalizeExitImportDate,
  type ExitImportReason,
  type ExitImportRowKey,
} from '@italent/domain';
import { z } from 'zod';
import { rawImportRows } from '../../audit/record.js';
import { AppError } from '../../errors.js';

/** 单个值的整批上限（设计 §3.2）：防止撑爆明细表；超长的正常文本按行级 TOO_LONG 报。 */
const VALUE_MAX = 2000;
const FILE_NAME_MAX = 255;

export type RowError = { readonly column: string | null; readonly reason: ExitImportReason };
export type ImportRowInput = { readonly rowNo: number } & Readonly<Record<ExitImportRowKey, string | null>>;
export interface ExitImportBody {
  readonly fileName: string;
  readonly rows: readonly ImportRowInput[];
}

const KEYS = EXIT_IMPORT_COLUMNS.flatMap((c) => (c.key ? [c.key] : []));
const cell = z.string().max(VALUE_MAX).nullable();
const rowSchema = z.strictObject({
  rowNo: z.int().min(1).max(1_000_000),
  ...(Object.fromEntries(KEYS.map((key) => [key, cell])) as Record<ExitImportRowKey, typeof cell>),
});
const bodySchema = z.strictObject({ fileName: z.string(), rows: z.array(rowSchema).min(1) });

// eslint-disable-next-line no-control-regex -- 文件名里的控制字符要删掉（通知按纯文本渲染，设计 §3.2）
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** 值只去首尾空白，空白串当作未填（null）；日期保留原文，由后续步骤规整。 */
const clean = (value: string | null): string | null => {
  const text = value?.trim() ?? '';
  return text === '' ? null : text;
};

export function parseExitImportBody(raw: unknown): ExitImportBody {
  // 行数超限先于逐行校验：1001 行的错误不应淹没在 zod 的数千条问题里
  if (rawImportRows(raw, 'rows').length > EXIT_IMPORT_ROW_LIMIT)
    throw new AppError('VALIDATION_FAILED', `单次最多导入 ${EXIT_IMPORT_ROW_LIMIT} 行`, {
      reason: 'BATCH_LIMIT_EXCEEDED',
      limit: EXIT_IMPORT_ROW_LIMIT,
    });
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  const fileName = parsed.data.fileName.replace(CONTROL, '').trim();
  if (fileName === '' || fileName.length > FILE_NAME_MAX)
    throw new AppError('VALIDATION_FAILED', `文件名须为 1～${FILE_NAME_MAX} 个字符`, { reason: 'FILE_NAME_INVALID' });
  const rows = parsed.data.rows.map((row) => ({
    rowNo: row.rowNo,
    ...(Object.fromEntries(KEYS.map((key) => [key, clean(row[key])])) as Record<ExitImportRowKey, string | null>),
  }));
  if (new Set(rows.map((row) => row.rowNo)).size !== rows.length)
    throw new AppError('VALIDATION_FAILED', '行号不能重复', { reason: 'DUPLICATE_ROW_NO' });
  return { fileName, rows: rows.sort((a, b) => a.rowNo - b.rowNo) };
}

const letterOf = (key: ExitImportRowKey) => EXIT_IMPORT_COLUMNS.find((c) => c.key === key)!.letter;
const REQUIRED = EXIT_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key!);
/** 按列字母取 TOO_LONG 文案里的长度上限（错误文件用）；没有单列上限的列为 undefined。 */
export const exitImportLimitOf = (columnLetter: string | null): number | undefined => {
  const column = EXIT_IMPORT_COLUMNS.find((c) => c.letter === columnLetter);
  return column?.key ? LIMITS[column.key] : undefined;
};
/** 有长度上限的列（其余列的上限 = 2000，已由整批规则挡住）：姓名 / 部门编码 / 名称匹配列 / 字典名称。 */
const LIMITS: Partial<Record<ExitImportRowKey, number>> = {
  name: 200,
  departmentCode: 100,
  positionName: 200,
  postName: 200,
  levelName: 200,
  exitTypeName: 200,
  exitReasonName: 200,
  whereaboutsName: 200,
};
const DATE_KEYS: readonly ExitImportRowKey[] = ['entryDate', 'workDate', 'birthday', 'lastWorkDate'];
const OPTIONS: readonly [ExitImportRowKey, readonly string[]][] = [
  ['gender', PROFILE_GENDER_OPTIONS],
  ['nation', PROFILE_NATION_OPTIONS],
  ['politicalStatus', PROFILE_POLITICAL_STATUS_OPTIONS],
];
const emailRule = z.email().max(320);

/** 第 1 步：同一步内所有列的错误一起报（设计 §3.3）；列顺序即模板顺序。 */
export function shapeErrors(row: ImportRowInput): RowError[] {
  const errors: RowError[] = [];
  const add = (key: ExitImportRowKey, reason: ExitImportReason) => errors.push({ column: letterOf(key), reason });
  for (const key of KEYS) {
    const value = row[key];
    if (value === null) {
      if (REQUIRED.includes(key)) add(key, 'REQUIRED');
      continue;
    }
    const limit = LIMITS[key];
    if (limit !== undefined && value.length > limit) add(key, 'TOO_LONG');
    else if (DATE_KEYS.includes(key) && normalizeExitImportDate(value) === null) add(key, 'INVALID_DATE');
    else if ((key === 'email' || key === 'personalEmail') && !emailRule.safeParse(value.toLowerCase()).success)
      add(key, 'INVALID_EMAIL');
  }
  for (const [key, options] of OPTIONS) {
    if (row[key] !== null && !checkProfileOption(options, row[key]).ok) add(key, 'OPTION_NOT_FOUND');
  }
  // 按模板列顺序输出，便于错误文件逐列对照
  const order = (e: RowError) => EXIT_IMPORT_COLUMNS.findIndex((c) => c.letter === e.column);
  return errors.sort((a, b) => order(a) - order(b));
}

/** 规整后的邮箱键（C 列）：a / b / c 三类比较都用它。 */
export const emailKey = (value: string): string => value.trim().toLowerCase();
export const isoOf = (value: string | null): string | null => (value === null ? null : normalizeExitImportDate(value));
