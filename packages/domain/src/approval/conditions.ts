/**
 * 发起条件：字段路径 + 运算符 + 值，外加高级表达式（`14` §1.1，REQ-APV-001）。
 * 只支持白名单字段与 and / or / not / 括号的布尔组合；通用表达式引擎属 R3-T00（DEC-024），此处是其扩展点。
 */
import {
  CONDITION_OPERATORS,
  type ConditionField,
  type ConditionItem,
  type ConditionOperator,
  type ProcessCondition,
} from './types.js';

export const MAX_CONDITION_ITEMS = 50;

export interface ConditionContext {
  /** 白名单字段路径 → 实际值（虚拟仿真数据或业务快照）。 */
  readonly values: Readonly<Record<string, unknown>>;
  /** 组织字段取值 → 行政维度祖先链（含自身），供“包含下级”判断。 */
  readonly orgAncestors: Readonly<Record<string, readonly string[]>>;
}

export interface ItemResult extends ConditionItem {
  readonly actual: unknown;
  readonly result: boolean;
}

export interface ConditionResult {
  readonly result: boolean;
  readonly expression: string;
  readonly items: readonly ItemResult[];
}

type Token = { kind: 'no'; value: number } | { kind: 'op'; value: 'and' | 'or' | 'not' | '(' | ')' };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  for (const raw of expression.toLowerCase().match(/\d+|and|or|not|\(|\)|\S+/g) ?? []) {
    if (/^\d+$/.test(raw)) tokens.push({ kind: 'no', value: Number(raw) });
    else if (['and', 'or', 'not', '(', ')'].includes(raw)) tokens.push({ kind: 'op', value: raw as 'and' });
    else return null;
  }
  return tokens;
}

/** 递归下降：expr := term (or term)*；term := factor (and factor)*；factor := not factor | ( expr ) | 编号。 */
function parse(tokens: Token[], lookup: (no: number) => boolean | undefined): boolean | undefined {
  let index = 0;
  const peek = () => tokens[index];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()?.value === value;
  const factor = (): boolean | undefined => {
    const token = peek();
    if (!token) return undefined;
    if (isOp('not')) {
      index++;
      const inner = factor();
      return inner === undefined ? undefined : !inner;
    }
    if (isOp('(')) {
      index++;
      const inner = expr();
      if (!isOp(')')) return undefined;
      index++;
      return inner;
    }
    if (token.kind !== 'no') return undefined;
    index++;
    return lookup(token.value);
  };
  const term = (): boolean | undefined => {
    let value = factor();
    while (value !== undefined && isOp('and')) {
      index++;
      const right = factor();
      value = right === undefined ? undefined : value && right;
    }
    return value;
  };
  const expr = (): boolean | undefined => {
    let value = term();
    while (value !== undefined && isOp('or')) {
      index++;
      const right = term();
      value = right === undefined ? undefined : value || right;
    }
    return value;
  };
  const value = expr();
  return index === tokens.length ? value : undefined;
}

export function defaultExpression(items: readonly ConditionItem[]): string {
  return items.map((item) => String(item.no)).join(' and ');
}

/** 保存时的结构校验：字段在白名单、运算符适配字段类型、表达式只引用已有条目。 */
export function conditionViolations(condition: ProcessCondition, fields: readonly ConditionField[]): string[] {
  const violations: string[] = [];
  const known = new Map(fields.map((field) => [field.path, field]));
  const numbers = new Set<number>();
  if (condition.items.length > MAX_CONDITION_ITEMS) violations.push(`发起条件最多 ${MAX_CONDITION_ITEMS} 条`);
  for (const item of condition.items) {
    if (!Number.isSafeInteger(item.no) || item.no < 1 || numbers.has(item.no)) {
      violations.push(`条件编号 ${item.no} 不合法或重复`);
    }
    numbers.add(item.no);
    const field = known.get(item.field);
    if (!field) {
      violations.push(`条件字段 ${item.field} 不在白名单内`);
      continue;
    }
    if (!(CONDITION_OPERATORS as readonly string[]).includes(item.operator)) {
      violations.push(`条件 ${item.no} 运算符不合法`);
    } else if (item.operator === 'in_org_tree' && field.kind !== 'org') {
      violations.push(`条件 ${item.no}：只有组织字段支持“包含下级”`);
    }
    violations.push(...valueViolations(item));
  }
  if (condition.items.length) {
    const tokens = tokenize(condition.expression || defaultExpression(condition.items));
    const valid = tokens && parse(tokens, (no) => (numbers.has(no) ? true : undefined)) !== undefined;
    if (!valid) violations.push('高级表达式不合法或引用了不存在的条件编号');
  } else if (condition.expression.trim()) violations.push('没有条件时不能填写高级表达式');
  return violations;
}

function valueViolations(item: ConditionItem): string[] {
  const list = ['in', 'not_in'].includes(item.operator);
  const none = ['is_empty', 'not_empty'].includes(item.operator);
  if (none) return item.value === null ? [] : [`条件 ${item.no} 不应填写值`];
  if (list) {
    return Array.isArray(item.value) && item.value.length > 0 && item.value.every((v) => typeof v === 'string')
      ? []
      : [`条件 ${item.no} 需要非空的值列表`];
  }
  return typeof item.value === 'string' ? [] : [`条件 ${item.no} 需要一个值`];
}

function empty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function itemResult(item: ConditionItem, context: ConditionContext): boolean {
  const actual = context.values[item.field];
  const text = empty(actual) ? null : String(actual as string);
  const value = item.value;
  const operations: Record<ConditionOperator, () => boolean> = {
    eq: () => text !== null && text === value,
    ne: () => text !== value,
    in: () => text !== null && Array.isArray(value) && value.includes(text),
    not_in: () => text === null || !Array.isArray(value) || !value.includes(text),
    is_empty: () => text === null,
    not_empty: () => text !== null,
    in_org_tree: () =>
      text !== null && typeof value === 'string' && (context.orgAncestors[text] ?? [text]).includes(value),
  };
  return operations[item.operator]();
}

/** 无条件 = 满足（是否允许发布由 DEC-018 的兜底标记控制）。 */
export function evaluateCondition(condition: ProcessCondition, context: ConditionContext): ConditionResult {
  const items = condition.items.map((item) => ({
    ...item,
    actual: context.values[item.field] ?? null,
    result: itemResult(item, context),
  }));
  if (!items.length) return { result: true, expression: '', items };
  const expression = condition.expression || defaultExpression(condition.items);
  const byNo = new Map(items.map((item) => [item.no, item.result]));
  const tokens = tokenize(expression);
  return { result: (tokens && parse(tokens, (no) => byNo.get(no))) === true, expression, items };
}
