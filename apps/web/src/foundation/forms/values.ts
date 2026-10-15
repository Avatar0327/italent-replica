// F-142（DEC-502②）：字段投影、空值归一与重读回填的唯一实现；各页面不再各写一份 pick / equal / 回填。
export type Values = Record<string, unknown>;

/** 空字符串、null、undefined、空数组都是“没填”：比较时按同一个空值处理。 */
export const isBlank = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

const isPlain = (value: unknown): value is Values =>
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;

function canonical(value: unknown): unknown {
  if (isBlank(value)) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlain(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !isBlank(value[key]))
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

/** 两个字段值是否相同：空值之间互等，对象不看键序；数组保持顺序（顺序是业务含义）。 */
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** 按字段从记录取值：缺失时取兜底，再缺为 null。只投影，不改写空值本身（发送形态由页面 DTO 决定）。 */
export function projectFields(record: Values | undefined, fields: readonly string[], fallback: Values = {}): Values {
  return Object.fromEntries(fields.map((field) => [field, record?.[field] ?? fallback[field] ?? null]));
}

/** 相对打开时基线改过的字段。 */
export function changedFields(values: Values, baseline: Values, fields: readonly string[]) {
  return fields.filter((field) => !sameValue(values[field], baseline[field]));
}

export interface RefillInput {
  values: Values;
  latest?: Values;
  /** 相对打开时基线改过的字段（内核 editedFields）。 */
  edited: readonly string[];
  /** 当前可提交（可见且可编辑）的字段。 */
  submittable: readonly string[];
}
/**
 * 重读回填（claude_fe_rules b）：有重读结果时，没改过的字段与当前不可提交的字段一律取最新记录，
 * 只有“改过且当前可提交”的字段保留草稿。没有重读结果时原样返回同一个引用。
 */
export function refillDraft({ values, latest, edited, submittable }: RefillInput) {
  if (!latest) return values;
  const mine = (field: string) => edited.includes(field) && submittable.includes(field);
  const refill = Object.keys(latest).filter((field) => !mine(field));
  return { ...values, ...Object.fromEntries(refill.map((field) => [field, latest[field]])) };
}

/** 复合字段部分转只读时，以服务端结构为准；只把仍可编辑的子字段从同一稳定行的草稿投影回来。 */
export function editableRows(latest: Values[], draft: Values[], key: string, fields: readonly string[]): Values[] {
  return latest.map((row) => ({
    ...row,
    ...Object.fromEntries(
      Object.entries(draft.find((item) => row[key] !== undefined && item[key] === row[key]) ?? {}).filter(([field]) =>
        fields.includes(field),
      ),
    ),
  }));
}
