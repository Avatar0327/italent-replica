/**
 * 审批变量与审批矩阵的领域规则（F-326 S1，设计 §2；纯函数，前后端共用，禁止 IO）。
 * 公共变量 / 应用变量的编码前缀规则分开写、分开校验，不共用一个正则（设计 §2.2）。
 */

export const VARIABLE_SCOPES = ['public', 'application'] as const;
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

export const VARIABLE_DATA_TYPES = [
  'string',
  'integer',
  'decimal',
  'datetime',
  'boolean',
  'person',
  'persons',
] as const;
export type VariableDataType = (typeof VARIABLE_DATA_TYPES)[number];

/** 公共变量适用范围：存三项的非空子集，“全部”存三项全集（设计 §2.1）。 */
export const VARIABLE_USAGE_SCOPES = ['process', 'business_rule', 'message_template'] as const;
export type VariableUsageScope = (typeof VARIABLE_USAGE_SCOPES)[number];

/** 变量与矩阵共用的状态：无删除，只启停（设计 §2.5）。 */
export const VARIABLE_STATUSES = ['draft', 'enabled', 'disabled'] as const;
export type VariableStatus = (typeof VARIABLE_STATUSES)[number];

export const MATRIX_COLUMN_KINDS = ['condition', 'role'] as const;
export const MATRIX_DIMENSIONS = ['department', 'position', 'job'] as const;

// ───────── 文本字段统一校验（设计 §2.1） ─────────

export interface TextRule {
  /** 上限，按 UTF-16 码元计（即 JS 字符串 length，配对代理算 2）。 */
  readonly max: number;
  readonly multiline: boolean;
}

export const VARIABLE_TEXT_FIELDS = {
  variableName: { max: 100, multiline: false },
  matrixName: { max: 100, multiline: false },
  matrixColumnName: { max: 50, multiline: false },
  matrixDescription: { max: 255, multiline: true },
  variableDescription: { max: 32766, multiline: true },
  stringDefaultValue: { max: 1000, multiline: true },
} as const satisfies Record<string, TextRule>;

export type TextViolation = 'TEXT_MALFORMED' | 'TEXT_CONTROL_CHAR' | 'TEXT_TOO_LONG';

// 带 u 标志按码点匹配：配对代理是一个增补平面码点不会命中，命中的只有未配对代理码元。
// 不用 String.prototype.isWellFormed()：tsconfig.base.json 的 lib 是 ES2023，没有它的类型。
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
// eslint-disable-next-line no-control-regex -- 校验控制字符正是本规则的目的
const CONTROL_SINGLE_LINE = /[\u0000-\u001F\u007F]/;
// eslint-disable-next-line no-control-regex -- 同上；多行字段放行 \t \n \r
const CONTROL_MULTI_LINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** 规则依次判定：良构 → 控制字符 → 长度。未配对代理会让 JSON 转义膨胀到 6 字节，必须先拒（设计 §2.1 末段）。 */
export function textViolation(value: string, rule: TextRule): TextViolation | null {
  if (LONE_SURROGATE.test(value)) return 'TEXT_MALFORMED';
  if ((rule.multiline ? CONTROL_MULTI_LINE : CONTROL_SINGLE_LINE).test(value)) return 'TEXT_CONTROL_CHAR';
  if (value.length > rule.max) return 'TEXT_TOO_LONG';
  return null;
}

// ───────── 编码 ─────────

export const PUBLIC_VARIABLE_PREFIX = 'Global.B.';
export const APPLICATION_VARIABLE_PREFIX = 'B.';

/** 公共变量后缀字母开头（实测样例都以字母开头）；应用变量后缀可数字开头、可纯数字（实测 B.2 / B.19 / B.ee）。 */
const PUBLIC_SUFFIX = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const APPLICATION_SUFFIX = /^[A-Za-z0-9_]{1,64}$/;
const MATRIX_CODE = /^[A-Za-z0-9_]{1,64}$/;

export type VariableCodeViolation = 'CODE_PREFIX_PROVIDED' | 'CODE_SUFFIX_INVALID';

/** 客户端只传后缀；自带任一类前缀（含点号）报错，不悄悄剥掉。 */
export function variableCodeViolation(scope: VariableScope, suffix: string): VariableCodeViolation | null {
  if (suffix.startsWith(PUBLIC_VARIABLE_PREFIX) || suffix.startsWith(APPLICATION_VARIABLE_PREFIX)) {
    return 'CODE_PREFIX_PROVIDED';
  }
  const pattern = scope === 'public' ? PUBLIC_SUFFIX : APPLICATION_SUFFIX;
  return pattern.test(suffix) ? null : 'CODE_SUFFIX_INVALID';
}

/** 前缀 + 后缀；调用前须先过 variableCodeViolation。 */
export function variableCodeOf(scope: VariableScope, suffix: string): string {
  return (scope === 'public' ? PUBLIC_VARIABLE_PREFIX : APPLICATION_VARIABLE_PREFIX) + suffix;
}

export function matrixCodeViolation(code: string): 'CODE_SUFFIX_INVALID' | null {
  return MATRIX_CODE.test(code) ? null : 'CODE_SUFFIX_INVALID';
}

// ───────── 默认值（设计 §2.3，仅形态；人员存在性、在职口径由 S2 读库复核） ─────────

export type DefaultValueViolation = 'DEFAULT_VALUE_TYPE' | TextViolation;

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
export const PERSONS_DEFAULT_MAX = 100;
const DECIMAL_MAX_DIGITS = 18;

const isUserId = (value: unknown): value is string => typeof value === 'string' && USER_ID.test(value);

function decimalOk(value: unknown): boolean {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return false;
  return (
    value
      .replace(/^-/, '')
      .replace('.', '')
      .replace(/^0+(?=\d)/, '').length <= DECIMAL_MAX_DIGITS
  );
}

function datetimeOk(value: unknown): boolean {
  return typeof value === 'string' && ISO_DATETIME.test(value) && !Number.isNaN(Date.parse(value));
}

function personsOk(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > PERSONS_DEFAULT_MAX) return false;
  return value.every(isUserId) && new Set(value).size === value.length;
}

/** null 表示未设置默认值：任何类型都允许（人员类启用时必须非空，属启用条件，不在此处）。 */
export function defaultValueViolation(dataType: VariableDataType, value: unknown): DefaultValueViolation | null {
  if (value === null || value === undefined) return null;
  const wrong = 'DEFAULT_VALUE_TYPE';
  switch (dataType) {
    case 'string':
      return typeof value === 'string' ? textViolation(value, VARIABLE_TEXT_FIELDS.stringDefaultValue) : wrong;
    case 'integer':
      return Number.isSafeInteger(value) ? null : wrong;
    case 'decimal':
      return decimalOk(value) ? null : wrong;
    case 'datetime':
      return datetimeOk(value) ? null : wrong;
    case 'boolean':
      return typeof value === 'boolean' ? null : wrong;
    case 'person':
      return isUserId(value) ? null : wrong;
    case 'persons':
      return personsOk(value) ? null : wrong;
  }
}

/** 公共变量适用范围：非空、无未知项、无重复项。 */
export function usageScopesViolation(scopes: readonly string[]): 'USAGE_SCOPES_INVALID' | null {
  const known = scopes.every((s) => (VARIABLE_USAGE_SCOPES as readonly string[]).includes(s));
  return scopes.length > 0 && known && new Set(scopes).size === scopes.length ? null : 'USAGE_SCOPES_INVALID';
}

// ───────── 状态机（设计 §2.5） ─────────

export type VariableStatusAction = 'enable' | 'disable';

/** 新建时可选“保存为草稿”或“保存并启用”。 */
export function initialVariableStatus(enableNow: boolean): VariableStatus {
  return enableNow ? 'enabled' : 'draft';
}

/** 草稿→启用→停用⇄启用；草稿不能直接停用，停用不能回草稿；不合法返回 null。 */
export function statusAfter(from: VariableStatus, action: VariableStatusAction): VariableStatus | null {
  if (action === 'enable') return from === 'enabled' ? null : 'enabled';
  return from === 'enabled' ? 'disabled' : null;
}

// ───────── 矩阵结构上限（设计 §2.1 规模上限） ─────────

export const MATRIX_LIMITS = {
  conditionColumns: 5,
  roleColumns: 10,
  rows: 500,
  conditionCellIds: 50,
  roleCellIds: 100,
  totalCellIds: 20000,
} as const;
