/**
 * F-493 S2 历史离职人员导入契约：模板列、上限常量、行级原因码与错误文案、日期规整。
 * docs/08_设计/F-493_历史离职人员导入对齐北森_设计.md §3.1（26 列）、§3.2（日期）、§3.3（原因码与原文）、§5、§6.3。
 * 前端解析、后端错误文件与模板下载共用这一个常量（自查第 7 条）；本文件只放纯数据与纯函数，执行逻辑在 apps/api。
 */
import { isIsoDate } from '../audit/retention.js';

/** 请求体键（B～Z 共 25 个，A「导入结果」不进报文）。 */
export type ExitImportRowKey =
  | 'name' | 'email' | 'departmentCode' | 'entryDate' | 'positionName' | 'postName' | 'levelName' | 'workDate'
  | 'place' | 'idNumber' | 'mobilePhone' | 'personalEmail' | 'gender' | 'birthday' | 'nation' | 'politicalStatus'
  | 'householdAddress' | 'registAddress' | 'school' | 'major' | 'lastWorkDate' | 'exitTypeName' | 'exitReasonName'
  | 'whereaboutsName' | 'exitNote'; // prettier-ignore

export interface ExitImportColumn {
  readonly letter: string;
  /** 模板第 1 行的列名原文，必填列带「*」。 */
  readonly name: string;
  readonly required: boolean;
  /** A 列不写入、不进报文，键为 null。 */
  readonly key: ExitImportRowKey | null;
}

const column = (letter: string, name: string, key: ExitImportRowKey | null): ExitImportColumn => ({
  letter,
  name,
  required: name.startsWith('*'),
  key,
});

export const EXIT_IMPORT_COLUMNS: readonly ExitImportColumn[] = [
  column('A', '导入结果', null),
  column('B', '*姓名', 'name'),
  column('C', '*电子邮件', 'email'),
  column('D', '*部门编码', 'departmentCode'),
  column('E', '*入职日期', 'entryDate'),
  column('F', '职位名称', 'positionName'),
  column('G', '职务名称', 'postName'),
  column('H', '职级', 'levelName'),
  column('I', '参加工作日期', 'workDate'),
  column('J', '工作地点', 'place'),
  column('K', '身份证号', 'idNumber'),
  column('L', '手机号码', 'mobilePhone'),
  column('M', '个人邮箱', 'personalEmail'),
  column('N', '性别', 'gender'),
  column('O', '出生日期', 'birthday'),
  column('P', '民族', 'nation'),
  column('Q', '政治面貌', 'politicalStatus'),
  column('R', '户籍所在地', 'householdAddress'),
  column('S', '籍贯', 'registAddress'),
  column('T', '毕业学校', 'school'),
  column('U', '专业', 'major'),
  column('V', '*最后工作日', 'lastWorkDate'),
  column('W', '离职类型', 'exitTypeName'),
  column('X', '离职原因', 'exitReasonName'),
  column('Y', '离职后去向', 'whereaboutsName'),
  column('Z', '离职说明', 'exitNote'),
];

/** 请求体上限 1 MiB（设计 §5）：app.ts 的 limitBody 例外与前端预判共用。 */
export const EXIT_IMPORT_BODY_LIMIT = 1024 * 1024;
/** 系统错误重试上限（设计 §6.3）：达到后仍失败，剩余行记 SYSTEM_ERROR。 */
export const EXIT_IMPORT_MAX_ATTEMPTS = 5;
/** 批次完成后错误文件与原文件保留天数（DEC-840①，设计 §8.3）。 */
export const EXIT_IMPORT_FILE_TTL_DAYS = 15;
/** 导入历史每页条数（设计 §8.4）。 */
export const EXIT_IMPORT_HISTORY_PAGE_SIZE = 15;

/** 行级原因码（设计 §3.3）；errors 只存列字母和原因码，不存值。新增原因码必须同时补文案（单测逐个核对）。 */
export const EXIT_IMPORT_REASONS = [
  'REQUIRED',
  'TOO_LONG',
  'INVALID_DATE',
  'INVALID_EMAIL',
  'INVALID_FORMAT',
  'REFERENCE_NOT_FOUND',
  'OPTION_NOT_FOUND',
  'REFERENCE_AMBIGUOUS',
  'REFERENCE_DISABLED',
  'DEPARTMENT_NOT_FOUNDED',
  'RANGE_INVERTED',
  'NOT_HISTORICAL',
  'NOT_SUPPORTED',
  'EMAIL_IN_EMPLOYEE',
  'EMAIL_DUPLICATE_IN_FILE',
  'LOGIN_TAKEN',
  'FIELD_HIDDEN',
  'SUBMITTER_FORBIDDEN',
  'SYSTEM_ERROR',
] as const;
export type ExitImportReason = (typeof EXIT_IMPORT_REASONS)[number];

const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;

/** 日期规整（设计 §3.2）：只接受 yyyy-mm-dd、yyyy/mm/dd、yyyy/m/d（去首尾空白），日期必须真实存在；否则 null。 */
export function normalizeExitImportDate(text: string): string | null {
  const value = text.trim();
  const match = DATE_ISO.exec(value) ?? DATE_SLASH.exec(value);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** 日期列的错误值显示：规整成功取 yyyy/mm/dd，规整不了取原文。 */
const DATE_COLUMNS = new Set(['E', 'I', 'O', 'V']);
const displayValue = (letter: string, value: string): string => {
  if (!DATE_COLUMNS.has(letter)) return value;
  const iso = normalizeExitImportDate(value);
  return iso ? iso.replaceAll('-', '/') : value;
};

/** 不属于任何一列的原因（提交人权限、系统错误）：原文不带 `[列名]：` 前缀。 */
const ROW_LEVEL_TEXT: Readonly<Partial<Record<ExitImportReason, string>>> = {
  SUBMITTER_FORBIDDEN: '提交人已无导入权限，本行未导入',
  SYSTEM_ERROR: '系统处理中断，本行未导入，请重新导入',
};

/** 带值的后缀：`<列名>【<值>】<后缀>`。TOO_LONG 的上限由调用方按字段传入。 */
const VALUE_SUFFIX: Readonly<Partial<Record<ExitImportReason, (limit: number | undefined) => string>>> = {
  TOO_LONG: (limit) => `长度不能超过${limit ?? '?'}个字符`,
  INVALID_DATE: () => '不是有效日期，请按yyyy/mm/dd填写',
  INVALID_EMAIL: () => '格式不正确',
  INVALID_FORMAT: () => '格式不正确',
  REFERENCE_NOT_FOUND: () => '不存在或者已被删除，请检查',
  OPTION_NOT_FOUND: () => '不存在或者已被删除，请检查',
  REFERENCE_AMBIGUOUS: () => '对应多条记录，请检查',
  REFERENCE_DISABLED: () => '已停用，请检查',
  DEPARTMENT_NOT_FOUNDED: () => '早于部门的设立日期，请检查',
  RANGE_INVERTED: () => '不能早于入职日期',
  NOT_HISTORICAL: () => '必须早于今天，今天及以后的离职请走离职流程',
  NOT_SUPPORTED: () => '暂不支持导入，请清空后再导入',
  EMAIL_IN_EMPLOYEE: () => '在员工信息中已存在，不允许导入',
  EMAIL_DUPLICATE_IN_FILE: () => '在导入文件中重复出现，无法导入',
};

/**
 * 错误文件 A 列的原文（设计 §3.3，F-496 N5 格式）：`[<列名>]：<列名>【<值>】<后缀>`；
 * 必填、b 类、无查看权限三种没有“【值】”。一行多条错误由调用方用「；」连接。
 * 编程错误（原因码未登记、带列原因码没给列或给了未知列）直接抛错，不静默输出空文案。
 */
export function exitImportErrorText(
  columnLetter: string | null,
  reason: string,
  value: string | null = '',
  limit?: number,
): string {
  if (!(EXIT_IMPORT_REASONS as readonly string[]).includes(reason)) throw new Error(`未登记的导入原因码：${reason}`);
  const known = reason as ExitImportReason;
  const rowLevel = ROW_LEVEL_TEXT[known];
  if (rowLevel) return rowLevel;
  const found = EXIT_IMPORT_COLUMNS.find((c) => c.letter === columnLetter);
  if (!found) throw new Error(`原因码 ${reason} 需要有效的列字母，收到：${String(columnLetter)}`);
  const prefix = `[${found.name}]：`;
  if (known === 'REQUIRED') return `${prefix}${found.name}不能为空`;
  if (known === 'LOGIN_TAKEN') return `${prefix}当前邮箱已被使用，请更换邮箱`;
  if (known === 'FIELD_HIDDEN') return `${prefix}无查看权限，错误原因已隐藏`;
  return `${prefix}${found.name}【${displayValue(found.letter, value ?? '')}】${VALUE_SUFFIX[known]!(limit)}`;
}
