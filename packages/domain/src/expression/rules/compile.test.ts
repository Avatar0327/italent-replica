/**
 * R3-T05 B1：compileRuleSet（设计 §3.2 发码表、§3.3 编译与规模、Q-SC-23）。
 * 发码结果既断言公式文本，也交给 R3-T00 引擎真实求值，证明空值守卫与引擎语义一致。
 */
import { describe, expect, it } from 'vitest';
import { evaluateBatch, evaluateFormula } from '../engine.js';
import { tokenize } from '../lexer.js';
import type { FieldLookup } from '../ports.js';
import type { ExpressionFieldKind, PlainValue } from '../values.js';
import { compileRuleSet, RULE_COMPILER_VERSION, RULE_LIMITS, type RuleFieldCatalog } from './compile.js';
import type { RuleConditionRow, RuleFieldRef, RuleOperator, RuleSet } from './types.js';

const NUMBER: RuleFieldRef = { object: 'review_object', code: 'score', path: '盘点对象.得分', kind: 'number' };
const GRID: RuleFieldRef = {
  object: 'review_object',
  code: 'grid',
  path: '盘点对象.绩效_潜力九宫格位置_after',
  kind: 'number',
};
const TEXT: RuleFieldRef = { object: 'employee', code: 'name', path: '员工.姓名', kind: 'text' };
const DATE: RuleFieldRef = { object: 'employment', code: 'entry', path: '任职.入职日期', kind: 'date' };
const FLAG: RuleFieldRef = { object: 'employee', code: 'flag', path: '员工.是否关键', kind: 'boolean' };
const OPTION: RuleFieldRef = {
  object: 'successor',
  code: 'level',
  path: '继任者.职级',
  kind: 'option',
  optionDomain: [
    { value: 'P5', label: '职级5', enabled: true },
    { value: 'P6', label: '职级6', enabled: false },
  ],
};
const MULTI: RuleFieldRef = { object: 'employee', code: 'tags', path: '员工.标签', kind: 'multi_option' };
const ALL_FIELDS = [NUMBER, GRID, TEXT, DATE, FLAG, OPTION, MULTI];

const catalog: RuleFieldCatalog = {
  resolve: (object, code) => ALL_FIELDS.find((field) => field.object === object && field.code === code),
};

const fieldRow = (
  rowNo: number,
  field: RuleFieldRef,
  operator: RuleOperator,
  values?: RuleConditionRow['values'],
): RuleConditionRow => ({ rowNo, kind: 'field', field, operator, ...(values ? { values } : {}) });
const aggRow = (rowNo: number, operator: RuleOperator, values?: RuleConditionRow['values']): RuleConditionRow => ({
  rowNo,
  kind: 'aggregate',
  operator,
  ...(values ? { values } : {}),
});
const one = (row: RuleConditionRow): RuleSet => ({ rows: [row], expression: String(row.rowNo) });

const compiled = (ruleSet: RuleSet, options?: Parameters<typeof compileRuleSet>[2]) => {
  const result = compileRuleSet(ruleSet, catalog, options);
  if (!result.ok) throw new Error(`应当编译成功：${JSON.stringify(result.errors)}`);
  return result;
};
const errorsOf = (ruleSet: RuleSet, options?: Parameters<typeof compileRuleSet>[2]) => {
  const result = compileRuleSet(ruleSet, catalog, options);
  if (result.ok) throw new Error(`应当编译失败：${result.compiled.formula}`);
  return result.errors;
};
const formulaOf = (row: RuleConditionRow, options?: Parameters<typeof compileRuleSet>[2]) =>
  compiled(one(row), options).compiled.formula;

const KINDS: Readonly<Record<string, ExpressionFieldKind>> = Object.fromEntries([
  ...ALL_FIELDS.map((field): [string, ExpressionFieldKind] => [
    field.path,
    field.kind === 'option' || field.kind === 'multi_option' ? 'text' : field.kind,
  ]),
  ['行1.值', 'number'],
  ['行2.值', 'number'],
  ['行3.值', 'number'],
]);

/** 用引擎真实求值：null 表示该字段为空（宿主注入 EMPTY）。 */
function run(formula: string, fields: Record<string, PlainValue>, forbidden: readonly string[] = []) {
  const subject = {
    id: 'subject-1',
    resolveField(path: string): FieldLookup {
      if (forbidden.includes(path)) return { status: 'forbidden' };
      if (!Object.hasOwn(fields, path)) return { status: 'unknown' };
      return { status: 'found', value: fields[path] };
    },
  };
  return evaluateFormula(formula, {
    subject,
    calendar: { today: '2026-10-09', timeZone: 'Asia/Shanghai' },
    fieldKind: (path) => KINDS[path],
  });
}
const matches = (formula: string, fields: Record<string, PlainValue>) => {
  const result = run(formula, fields);
  if (!result.ok) throw new Error(`求值失败：${result.failure.code}`);
  return result.value.kind === 'number' ? result.value.value === 1 : undefined;
};

describe('发码表（§3.2）：公式文本', () => {
  const f = NUMBER.path;
  it.each([
    ['is_empty', undefined, `IF((IsEmpty(${f})), 1, 0)`],
    ['not_empty', undefined, `IF((not IsEmpty(${f})), 1, 0)`],
    ['eq', [5], `IF((not IsEmpty(${f}) and ${f} = 5), 1, 0)`],
    ['eq', [4, 5], `IF((not IsEmpty(${f}) and IN(${f}, 4, 5)), 1, 0)`],
    ['ne', [5], `IF((not IsEmpty(${f}) and ${f} != 5), 1, 0)`],
    ['ne', [4, 5], `IF((not IsEmpty(${f}) and NOTIN(${f}, 4, 5)), 1, 0)`],
    ['gt', [3], `IF((not IsEmpty(${f}) and ${f} > 3), 1, 0)`],
    ['lt', [3], `IF((not IsEmpty(${f}) and ${f} < 3), 1, 0)`],
    ['ge', [3], `IF((not IsEmpty(${f}) and ${f} >= 3), 1, 0)`],
    ['le', [3], `IF((not IsEmpty(${f}) and ${f} <= 3), 1, 0)`],
    ['between', [1, 9], `IF((not IsEmpty(${f}) and ${f} >= 1 and ${f} <= 9), 1, 0)`],
  ] as const)('number %s %j', (operator, values, expected) => {
    expect(formulaOf(fieldRow(1, NUMBER, operator, values))).toBe(expected);
  });

  it('设计 §3.2 样例：T06 九宫格 / 风险 1 and 2 / 健康度绿化率 ≥ 30%', () => {
    expect(formulaOf(fieldRow(1, GRID, 'eq', [7, 8, 9]))).toBe(
      'IF((not IsEmpty(盘点对象.绩效_潜力九宫格位置_after) and IN(盘点对象.绩效_潜力九宫格位置_after, 7, 8, 9)), 1, 0)',
    );
    expect(
      compiled({ rows: [aggRow(1, 'not_empty'), aggRow(2, 'not_empty')], expression: '1 and 2' }).compiled.formula,
    ).toBe('IF((not IsEmpty(行1.值)) and (not IsEmpty(行2.值)), 1, 0)');
    expect(formulaOf(aggRow(1, 'ge', [0.3]))).toBe('IF((not IsEmpty(行1.值) and 行1.值 >= 0.3), 1, 0)');
  });

  it('字面量：number 十进制（负数、小数、绝不出现科学计数法）；text / option 双引号；date "YYYY-MM-DD"；boolean 真假', () => {
    expect(formulaOf(aggRow(1, 'gt', [-2.5]))).toContain('行1.值 > -2.5');
    expect(formulaOf(aggRow(1, 'gt', [0.0000001]))).toContain('行1.值 > 0.0000001');
    expect(formulaOf(aggRow(1, 'lt', [1e21]))).toContain('行1.值 < 1000000000000000000000');
    expect(formulaOf(aggRow(1, 'lt', [-0]))).toContain('行1.值 < 0)');
    expect(formulaOf(fieldRow(1, TEXT, 'eq', ['张三']))).toBe(
      'IF((not IsEmpty(员工.姓名) and 员工.姓名 = "张三"), 1, 0)',
    );
    expect(formulaOf(fieldRow(1, OPTION, 'eq', ['P5', 'P6']))).toBe(
      'IF((not IsEmpty(继任者.职级) and IN(继任者.职级, "P5", "P6")), 1, 0)',
    );
    expect(formulaOf(fieldRow(1, DATE, 'ge', ['2024-02-29']))).toBe(
      'IF((not IsEmpty(任职.入职日期) and 任职.入职日期 >= "2024-02-29"), 1, 0)',
    );
    expect(formulaOf(fieldRow(1, FLAG, 'eq', [true]))).toBe(
      'IF((not IsEmpty(员工.是否关键) and 员工.是否关键 = true), 1, 0)',
    );
  });

  it('组合：and 先于 or，括号保留语义；同一行多次引用', () => {
    const rows = [aggRow(1, 'not_empty'), aggRow(2, 'is_empty'), aggRow(3, 'ge', [1])];
    expect(compiled({ rows, expression: '1 or 2 and 3' }).compiled.formula).toBe(
      'IF((not IsEmpty(行1.值)) or (IsEmpty(行2.值)) and (not IsEmpty(行3.值) and 行3.值 >= 1), 1, 0)',
    );
    expect(compiled({ rows, expression: '(1 or 2) and 3' }).compiled.formula).toBe(
      'IF(((not IsEmpty(行1.值)) or (IsEmpty(行2.值))) and (not IsEmpty(行3.值) and 行3.值 >= 1), 1, 0)',
    );
  });
});

describe('空值守卫（R3-06）：引擎真实求值', () => {
  const cases: readonly [RuleOperator, RuleConditionRow['values'], boolean, boolean][] = [
    // [运算符, 值, 字段为空时是否匹配, 字段 = 5 时是否匹配]
    ['is_empty', undefined, true, false],
    ['not_empty', undefined, false, true],
    ['eq', [5], false, true],
    ['eq', [4, 5], false, true],
    ['eq', [4], false, false],
    ['ne', [5], false, false],
    ['ne', [4], false, true],
    ['ne', [4, 6], false, true],
    ['ne', [4, 5], false, false],
    ['gt', [3], false, true],
    ['lt', [3], false, false],
    ['lt', [9], false, true],
    ['ge', [5], false, true],
    ['le', [5], false, true],
    ['le', [4], false, false],
    ['between', [1, 9], false, true],
    ['between', [6, 9], false, false],
  ];

  it.each(cases)('number %s %j：为空 → %s，=5 → %s', (operator, values, whenEmpty, whenFive) => {
    const { formula } = compiled(one(fieldRow(1, NUMBER, operator, values))).compiled;
    expect(matches(formula, { [NUMBER.path]: null })).toBe(whenEmpty);
    expect(matches(formula, { [NUMBER.path]: 5 })).toBe(whenFive);
  });

  it('零值不是空值：0 满足 ne 1 / le 0，而空值不满足（避免 != 0 误命中）', () => {
    const ne = compiled(one(aggRow(1, 'ne', [1]))).compiled.formula;
    expect(matches(ne, { '行1.值': 0 })).toBe(true);
    expect(matches(ne, { '行1.值': null })).toBe(false);
    const le = compiled(one(aggRow(1, 'le', [0]))).compiled.formula;
    expect(matches(le, { '行1.值': 0 })).toBe(true);
    expect(matches(le, { '行1.值': null })).toBe(false);
  });

  it('空文本按空：text 的 is_empty 为真，eq 不命中', () => {
    const isEmpty = compiled(one(fieldRow(1, TEXT, 'is_empty'))).compiled.formula;
    const eq = compiled(one(fieldRow(1, TEXT, 'eq', ['张三']))).compiled.formula;
    expect(matches(isEmpty, { [TEXT.path]: '' })).toBe(true);
    expect(matches(eq, { [TEXT.path]: '' })).toBe(false);
    expect(matches(eq, { [TEXT.path]: '张三' })).toBe(true);
  });

  it('option 比较经 unwrapOption，按字符串值；date / boolean 同样带守卫', () => {
    const option = compiled(one(fieldRow(1, OPTION, 'eq', ['P5']))).compiled.formula;
    expect(matches(option, { [OPTION.path]: { optionValue: 'P5', label: '职级5' } })).toBe(true);
    expect(matches(option, { [OPTION.path]: { optionValue: 'P6', label: '职级6' } })).toBe(false);
    expect(matches(option, { [OPTION.path]: null })).toBe(false);

    const date = compiled(one(fieldRow(1, DATE, 'ge', ['2024-01-01']))).compiled.formula;
    expect(matches(date, { [DATE.path]: new Date('2024-06-01T00:00:00+08:00') })).toBe(true);
    expect(matches(date, { [DATE.path]: new Date('2023-06-01T00:00:00+08:00') })).toBe(false);
    expect(matches(date, { [DATE.path]: null })).toBe(false);

    const flag = compiled(one(fieldRow(1, FLAG, 'ne', [true]))).compiled.formula;
    expect(matches(flag, { [FLAG.path]: false })).toBe(true);
    expect(matches(flag, { [FLAG.path]: true })).toBe(false);
    expect(matches(flag, { [FLAG.path]: null })).toBe(false);
  });

  it('批量求值路径与逐人求值一致（宿主按页批量算时同样守卫空值）', () => {
    const { formula } = compiled(one(fieldRow(1, NUMBER, 'ne', [4]))).compiled;
    const subject = (id: string, value: PlainValue) => ({
      id,
      resolveField: (path: string): FieldLookup =>
        path === NUMBER.path ? { status: 'found', value } : { status: 'unknown' },
    });
    const subjects = [subject('empty', null), subject('four', 4), subject('five', 5), subject('zero', 0)];
    const batch = evaluateBatch([{ field: '盘点对象.命中', priority: 1, formula }], subjects, {
      calendar: { today: '2026-10-09', timeZone: 'Asia/Shanghai' },
      fieldKind: (path) => KINDS[path],
    });
    if (!batch.ok) throw new Error('批量求值应当成功');
    const hit = (id: string) => {
      const result = batch.results[id]!['盘点对象.命中']!;
      return result.ok && result.value.kind === 'number' ? result.value.value : undefined;
    };
    expect(['empty', 'four', 'five', 'zero'].map(hit)).toEqual([0, 0, 1, 1]);
    for (const [id, value] of [
      ['empty', null],
      ['four', 4],
      ['five', 5],
      ['zero', 0],
    ] as const) {
      expect(matches(formula, { [NUMBER.path]: value })).toBe(hit(id) === 1);
    }
  });

  it('组合求值：and / or 优先级与括号', () => {
    const rows = [aggRow(1, 'ge', [10]), aggRow(2, 'ge', [5]), aggRow(3, 'is_empty')];
    const evalWith = (expression: string, v1: number | null, v2: number | null, v3: number | null) =>
      matches(compiled({ rows, expression }).compiled.formula, { '行1.值': v1, '行2.值': v2, '行3.值': v3 });
    expect(evalWith('1 or 2 and 3', 10, 0, 1)).toBe(true); // 1 或 (2 且 3)
    expect(evalWith('(1 or 2) and 3', 10, 0, 1)).toBe(false);
    expect(evalWith('(1 or 2) and 3', 10, 0, null)).toBe(true);
    expect(evalWith('1 and 2', null, 9, null)).toBe(false);
    expect(evalWith('1 and 2 and 1', 10, 5, null)).toBe(true);
  });
});

describe('多选字段（Q-SC-23）', () => {
  it('取证前一律拒绝：任何运算符都是 400 RULE_FIELD_NOT_ALLOWED，定位到行', () => {
    for (const operator of ['is_empty', 'not_empty', 'eq', 'ne'] as const) {
      const values = operator === 'eq' || operator === 'ne' ? ['a'] : undefined;
      expect(errorsOf(one(fieldRow(3, MULTI, operator, values)))).toEqual([
        { code: 'RULE_FIELD_NOT_ALLOWED', rowNo: 3 },
      ]);
    }
  });

  describe('放开后（allowMultiOption）用 "|v|" 编码 + Contains', () => {
    const open = { allowMultiOption: true } as const;
    const f = MULTI.path;
    it('发码', () => {
      expect(formulaOf(fieldRow(1, MULTI, 'eq', ['a']), open)).toBe(
        `IF((not IsEmpty(${f}) and Contains(${f}, "|a|")), 1, 0)`,
      );
      expect(formulaOf(fieldRow(1, MULTI, 'eq', ['a', 'b']), open)).toBe(
        `IF((not IsEmpty(${f}) and (Contains(${f}, "|a|") or Contains(${f}, "|b|"))), 1, 0)`,
      );
      expect(formulaOf(fieldRow(1, MULTI, 'ne', ['a']), open)).toBe(
        `IF((not IsEmpty(${f}) and not (Contains(${f}, "|a|"))), 1, 0)`,
      );
      expect(formulaOf(fieldRow(1, MULTI, 'ne', ['a', 'b']), open)).toBe(
        `IF((not IsEmpty(${f}) and not (Contains(${f}, "|a|") or Contains(${f}, "|b|"))), 1, 0)`,
      );
    });

    it('求值：空 / 非空 / 含任一 / 不含；无选中（null）一律不满足，is_empty 除外', () => {
      const isEmpty = compiled(one(fieldRow(1, MULTI, 'is_empty')), open).compiled.formula;
      const notEmpty = compiled(one(fieldRow(1, MULTI, 'not_empty')), open).compiled.formula;
      const any = compiled(one(fieldRow(1, MULTI, 'eq', ['a', 'c'])), open).compiled.formula;
      const none = compiled(one(fieldRow(1, MULTI, 'ne', ['a', 'c'])), open).compiled.formula;
      expect(matches(isEmpty, { [f]: null })).toBe(true);
      expect(matches(isEmpty, { [f]: '|a|b|' })).toBe(false);
      expect(matches(notEmpty, { [f]: '|a|b|' })).toBe(true);
      expect(matches(any, { [f]: '|a|b|' })).toBe(true);
      expect(matches(any, { [f]: '|b|' })).toBe(false);
      expect(matches(any, { [f]: '|ab|' })).toBe(false); // 竖线边界：a 不匹配 ab
      expect(matches(any, { [f]: null })).toBe(false);
      expect(matches(none, { [f]: '|b|' })).toBe(true);
      expect(matches(none, { [f]: '|a|b|' })).toBe(false);
      expect(matches(none, { [f]: null })).toBe(false);
    });

    it('值内含 | " 或换行 → RULE_LITERAL_INVALID', () => {
      for (const bad of ['a|b', 'a"b', 'a\nb', 'a\rb']) {
        expect(errorsOf(one(fieldRow(2, MULTI, 'eq', [bad])), open)).toEqual([
          { code: 'RULE_LITERAL_INVALID', rowNo: 2 },
        ]);
      }
    });
  });
});

describe('字面量安全（scanString 无转义）', () => {
  it.each(['a"b', 'a\nb', 'a\rb', '"'])('text / option 值 %j → RULE_LITERAL_INVALID 定位到行', (bad) => {
    expect(errorsOf(one(fieldRow(4, TEXT, 'eq', [bad])))).toEqual([{ code: 'RULE_LITERAL_INVALID', rowNo: 4 }]);
    expect(errorsOf(one(fieldRow(4, TEXT, 'ne', ['ok', bad])))).toEqual([{ code: 'RULE_LITERAL_INVALID', rowNo: 4 }]);
  });

  it('中文引号、反斜杠、竖线等字符在文本值里是普通字符，不破坏公式', () => {
    const { formula } = compiled(one(fieldRow(1, TEXT, 'eq', ['“甲”\\|，；(']))).compiled;
    expect(matches(formula, { [TEXT.path]: '“甲”\\|，；(' })).toBe(true);
  });

  it('值里的注入尝试只是一个文本值：")) or (1 = 1" 被引号包住且被拒绝', () => {
    expect(errorsOf(one(fieldRow(1, TEXT, 'eq', ['x") or (1 = 1 or ("']))).map((e) => e.code)).toEqual([
      'RULE_LITERAL_INVALID',
    ]);
  });

  it('错误里不带任何值', () => {
    expect(JSON.stringify(errorsOf(one(fieldRow(1, TEXT, 'eq', ['机密"值']))))).not.toContain('机密');
  });
});

describe('逐行校验（RULE_ROW_INVALID n + reason）', () => {
  const reasonOf = (row: RuleConditionRow, options?: Parameters<typeof compileRuleSet>[2]) =>
    errorsOf(one(row), options).map((e) => `${e.code}:${e.rowNo}:${e.reason}`);

  it('字段不存在 / 与目录不一致 / 路径不合法 / 缺失', () => {
    expect(reasonOf(fieldRow(1, { ...NUMBER, code: 'missing' }, 'eq', [1]))).toEqual([
      'RULE_ROW_INVALID:1:FIELD_UNKNOWN',
    ]);
    expect(reasonOf(fieldRow(1, { ...NUMBER, kind: 'text' }, 'eq', ['1']))).toEqual([
      'RULE_ROW_INVALID:1:FIELD_MISMATCH',
    ]);
    expect(reasonOf(fieldRow(1, { ...NUMBER, path: '盘点对象.其他' }, 'eq', [1]))).toEqual([
      'RULE_ROW_INVALID:1:FIELD_MISMATCH',
    ]);
    expect(reasonOf({ rowNo: 1, kind: 'field', operator: 'not_empty' })).toEqual(['RULE_ROW_INVALID:1:FIELD_MISSING']);
  });

  it('引擎词法认不出的路径（如纯数字对象名）按行定位为 ENGINE，不透出引擎文案', () => {
    const digits: RuleFieldRef = { ...NUMBER, code: 'digits', path: '360.得分' };
    const result = compileRuleSet(one(fieldRow(1, digits, 'not_empty')), { resolve: () => digits });
    expect(result).toEqual({ ok: false, errors: [{ code: 'RULE_ROW_INVALID', rowNo: 1, reason: 'ENGINE' }] });
  });

  it('目录给出的路径含运算符 / 引号 / 空白等字符时拒绝，不拼进公式', () => {
    const evil: RuleFieldRef = { ...NUMBER, code: 'evil', path: '盘点对象.a) or (1 = 1' };
    const evilCatalog: RuleFieldCatalog = { resolve: () => evil };
    const result = compileRuleSet(one(fieldRow(1, evil, 'not_empty')), evilCatalog);
    expect(result).toEqual({
      ok: false,
      errors: [{ code: 'RULE_ROW_INVALID', rowNo: 1, reason: 'FIELD_PATH_INVALID' }],
    });
  });

  it('运算符与字段类型不匹配：文本只能 = ≠ 空；多选以外的布尔 / 选项同理', () => {
    expect(reasonOf(fieldRow(1, TEXT, 'gt', ['a']))).toEqual(['RULE_ROW_INVALID:1:OPERATOR_INVALID']);
    expect(reasonOf(fieldRow(1, OPTION, 'between', ['P5', 'P6']))).toEqual(['RULE_ROW_INVALID:1:OPERATOR_INVALID']);
    expect(reasonOf(fieldRow(1, FLAG, 'ge', [true]))).toEqual(['RULE_ROW_INVALID:1:OPERATOR_INVALID']);
    expect(
      reasonOf({ rowNo: 1, kind: 'field', field: NUMBER, operator: 'bogus' as RuleOperator, values: [1] }),
    ).toEqual(['RULE_ROW_INVALID:1:OPERATOR_INVALID']);
  });

  it('值个数：gt / lt / ge / le 恰 1 个，between 恰 2 个，eq / ne 至少 1 个', () => {
    expect(reasonOf(aggRow(1, 'gt', [1, 2]))).toEqual(['RULE_ROW_INVALID:1:VALUE_COUNT']);
    expect(reasonOf(aggRow(1, 'between', [1]))).toEqual(['RULE_ROW_INVALID:1:VALUE_COUNT']);
    expect(reasonOf(aggRow(1, 'between', [1, 2, 3]))).toEqual(['RULE_ROW_INVALID:1:VALUE_COUNT']);
  });

  it('值类型：number 行不收文本 / NaN / Infinity；text 行不收数字；date 须是真实日历日；option 须是字符串且在选项域内', () => {
    expect(reasonOf(aggRow(1, 'gt', ['1'] as never))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(aggRow(1, 'gt', [Number.NaN]))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(aggRow(1, 'gt', [Number.POSITIVE_INFINITY]))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, TEXT, 'eq', [1]))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, DATE, 'ge', ['2025-02-30']))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, DATE, 'ge', ['2025/02/03']))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, DATE, 'ge', [20250203]))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, FLAG, 'eq', ['true']))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, OPTION, 'eq', [5]))).toEqual(['RULE_ROW_INVALID:1:VALUE_TYPE']);
    expect(reasonOf(fieldRow(1, OPTION, 'eq', ['P9']))).toEqual(['RULE_ROW_INVALID:1:OPTION_UNKNOWN']);
  });

  it('选项域内的值（含已停用项）可编译：已有规则里的停用选项不阻断重新编译', () => {
    expect(formulaOf(fieldRow(1, OPTION, 'eq', ['P6']))).toContain('= "P6"');
  });

  it('is_empty / not_empty 忽略多余的值', () => {
    expect(formulaOf(aggRow(1, 'is_empty', [1, 2]))).toBe('IF((IsEmpty(行1.值)), 1, 0)');
  });

  it('行号须为正整数且不重复；多个行错误一并返回（按行号排序）', () => {
    const rows = [aggRow(2, 'gt', [1, 2]), aggRow(1, 'between', [1]), { ...aggRow(2, 'is_empty') }];
    expect(errorsOf({ rows, expression: '1 and 2' })).toEqual([
      { code: 'RULE_ROW_INVALID', rowNo: 1, reason: 'VALUE_COUNT' },
      { code: 'RULE_ROW_INVALID', rowNo: 2, reason: 'ROW_NO_INVALID' },
    ]);
    for (const bad of [0, -1, 1.5]) {
      expect(errorsOf({ rows: [aggRow(1, 'not_empty'), aggRow(bad, 'is_empty')], expression: '1' })).toEqual([
        { code: 'RULE_ROW_INVALID', rowNo: bad, reason: 'ROW_NO_INVALID' },
      ]);
    }
  });
});

describe('值列为空（DEC-305④）：常量 false + 警告，不阻断保存', () => {
  it.each(['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'between'] as const)('%s 无值 → false', (operator) => {
    const result = compiled(one(aggRow(1, operator)));
    expect(result.compiled.formula).toBe('IF((false), 1, 0)');
    expect(result.compiled.constantFalseRows).toEqual([1]);
    expect(result.warnings).toEqual([{ code: 'RULE_ROW_VALUE_MISSING', rowNo: 1 }]);
    expect(matches(result.compiled.formula, {})).toBe(false);
  });

  it('空数组等同无值；is_empty / not_empty 不受影响', () => {
    expect(compiled(one(aggRow(1, 'ge', []))).compiled.constantFalseRows).toEqual([1]);
    expect(compiled(one(aggRow(1, 'is_empty'))).compiled.constantFalseRows).toEqual([]);
    expect(compiled(one(aggRow(1, 'not_empty'))).warnings).toEqual([]);
  });

  it('未被引用的常量 false 行也记入 constantFalseRows', () => {
    const result = compiled({ rows: [aggRow(1, 'not_empty'), aggRow(2, 'gt')], expression: '1' });
    expect(result.compiled.constantFalseRows).toEqual([2]);
  });
});

describe('组合表达式与引用', () => {
  const rows = [aggRow(1, 'not_empty'), aggRow(2, 'not_empty'), aggRow(3, 'not_empty')];

  it('RULE_ROW_UNKNOWN：引用了不存在的行', () => {
    expect(errorsOf({ rows, expression: '1 and 4' })).toEqual([{ code: 'RULE_ROW_UNKNOWN', rowNo: 4, offset: 6 }]);
    expect(errorsOf({ rows: [], expression: '1' })).toEqual([{ code: 'RULE_ROW_UNKNOWN', rowNo: 1, offset: 0 }]);
  });

  it('语法错误带偏移；空表达式也是语法错误', () => {
    expect(errorsOf({ rows, expression: '1 and' })).toEqual([{ code: 'RULE_EXPRESSION_SYNTAX', offset: 5 }]);
    expect(errorsOf({ rows, expression: '' })).toEqual([{ code: 'RULE_EXPRESSION_SYNTAX', offset: 0 }]);
  });

  it('行错误与表达式错误一并返回，行错误在前', () => {
    expect(errorsOf({ rows: [aggRow(1, 'gt', [1, 2])], expression: '1 and' })).toEqual([
      { code: 'RULE_ROW_INVALID', rowNo: 1, reason: 'VALUE_COUNT' },
      { code: 'RULE_EXPRESSION_SYNTAX', offset: 5 },
    ]);
  });

  it('referencedRows 去重升序；未引用行进 unreferencedRows 并给警告（Q09 暂按警告）', () => {
    const result = compiled({ rows, expression: '3 or 1 and 3' });
    expect(result.compiled.referencedRows).toEqual([1, 3]);
    expect(result.compiled.unreferencedRows).toEqual([2]);
    expect(result.warnings).toEqual([{ code: 'RULE_ROW_UNREFERENCED', rowNo: 2 }]);
  });

  it('未引用的行同样做类型校验', () => {
    expect(errorsOf({ rows: [aggRow(1, 'not_empty'), aggRow(2, 'gt', [1, 2])], expression: '1' })).toEqual([
      { code: 'RULE_ROW_INVALID', rowNo: 2, reason: 'VALUE_COUNT' },
    ]);
  });

  it('rowSpans：每次引用一个区间，切出的子串就是该行发码；同一行多处引用 → 多区间', () => {
    const { compiled: result } = compiled({ rows, expression: '1 and (2 or 1)' });
    expect(result.rowSpans.map((span) => span.rowNo)).toEqual([1, 2, 1]);
    for (const span of result.rowSpans) {
      expect(result.formula.slice(span.start, span.end)).toBe('(not IsEmpty(行' + span.rowNo + '.值))');
    }
    expect(result.formula).toBe('IF((not IsEmpty(行1.值)) and ((not IsEmpty(行2.值)) or (not IsEmpty(行1.值))), 1, 0)');
  });

  it('rowSpans 对带守卫的行同样切出整行（括号即子式本身）', () => {
    const { compiled: result } = compiled({
      rows: [fieldRow(1, NUMBER, 'eq', [1, 2]), aggRow(2, 'is_empty')],
      expression: '1 or 2',
    });
    expect(result.formula.slice(result.rowSpans[0]!.start, result.rowSpans[0]!.end)).toBe(
      '(not IsEmpty(盘点对象.得分) and IN(盘点对象.得分, 1, 2))',
    );
    expect(result.formula.slice(result.rowSpans[1]!.start, result.rowSpans[1]!.end)).toBe('(IsEmpty(行2.值))');
  });

  it('compilerVersion 随结果带出；编译确定且不改输入', () => {
    const ruleSet: RuleSet = Object.freeze({ rows: Object.freeze(rows), expression: '1 and 2' });
    const first = compiled(ruleSet);
    expect(first.compiled.compilerVersion).toBe(RULE_COMPILER_VERSION);
    expect(RULE_COMPILER_VERSION).toMatch(/^\S+$/);
    expect(compiled(ruleSet)).toEqual(first);
  });
});

describe('规模上限（§3.3 第 3 条）', () => {
  it('行数 ≤ 50：50 通过，51 → RULE_TOO_LARGE（整体错误，不再逐行校验）', () => {
    const many = (n: number): RuleSet => ({
      rows: Array.from({ length: n }, (_, i) => aggRow(i + 1, 'not_empty')),
      expression: '1',
    });
    expect(RULE_LIMITS.maxRows).toBe(50);
    expect(compiled(many(50)).compiled.referencedRows).toEqual([1]);
    expect(errorsOf(many(51))).toEqual([{ code: 'RULE_TOO_LARGE' }]);
  });

  it('每行候选值 ≤ 20：20 通过，21 → RULE_TOO_LARGE 定位到行', () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(RULE_LIMITS.maxValuesPerRow).toBe(20);
    expect(compiled(one(aggRow(1, 'eq', values(20)))).compiled.constantFalseRows).toEqual([]);
    expect(errorsOf(one(aggRow(7, 'eq', values(21))))).toEqual([{ code: 'RULE_TOO_LARGE', rowNo: 7 }]);
  });

  it('括号嵌套 ≤ 20：超限报 RULE_TOO_LARGE（带偏移）', () => {
    const rows = [aggRow(1, 'not_empty')];
    expect(compiled({ rows, expression: `${'('.repeat(20)}1${')'.repeat(20)}` }).compiled.referencedRows).toEqual([1]);
    expect(errorsOf({ rows, expression: `${'('.repeat(21)}1${')'.repeat(21)}` })).toEqual([
      { code: 'RULE_TOO_LARGE', offset: 20 },
    ]);
  });

  it('发码后超过引擎 4000 字符 → RULE_TOO_LARGE（不是引擎语法错误）', () => {
    const wide = Array.from({ length: 20 }, (_, i) => `${'字'.repeat(200)}${i}`);
    expect(errorsOf(one(fieldRow(1, TEXT, 'eq', wide)))).toEqual([{ code: 'RULE_TOO_LARGE' }]);
  });

  it('发码后超过引擎 800 词 → RULE_TOO_LARGE', () => {
    const rows = [aggRow(1, 'not_empty')];
    const expression = Array.from({ length: 150 }, () => '1').join(' and ');
    expect(errorsOf({ rows, expression })).toEqual([{ code: 'RULE_TOO_LARGE' }]);
  });

  it('接近上限的合法规则能通过引擎校验', () => {
    const rows = Array.from({ length: 50 }, (_, i) => aggRow(i + 1, 'not_empty'));
    const expression = Array.from({ length: 50 }, (_, i) => String(i + 1)).join(' or ');
    expect(compiled({ rows, expression }).compiled.referencedRows).toHaveLength(50);
  });
});

describe('数值字面量精确展开（第 2 轮 P2：科学计数法分支不得舍入）', () => {
  const VALUES = [
    0.0000001234567890123456,
    1e-21,
    -1e-21,
    1.5e-7,
    Number.MIN_VALUE,
    1e21,
    123456789012345680000,
    -1.2345e25,
    1e300,
    Number.MAX_VALUE,
    0.1,
    -0.000001,
    42,
  ];
  const literalIn = (formula: string, path: string): string => {
    const hit = new RegExp(`${path} (?:=|!=|<=|>=|<|>) (-?[0-9.]+)\\)`).exec(formula);
    if (!hit) throw new Error(`公式里找不到比较字面量：${formula}`);
    return hit[1]!;
  };

  it.each(VALUES)('%s 发码后文本与原数值逐位相等（Number(文本) === 原值，无科学计数法）', (value) => {
    const formula = formulaOf(aggRow(1, 'eq', [value]));
    const literal = literalIn(formula, '行1.值');
    expect(literal).not.toMatch(/e/i);
    expect(Number(literal)).toBe(value);
  });

  it('审查反例一：阈值 0.0000001234567890123456 不再被舍入到 20 位小数', () => {
    const formula = formulaOf(aggRow(1, 'eq', [0.0000001234567890123456]));
    expect(formula).toContain('行1.值 = 0.0000001234567890123456)');
    expect(matches(formula, { '行1.值': 0.0000001234567890123456 })).toBe(true);
  });

  it('审查反例二：ge [1e-21] 对度量 0 不命中（不能被编译成 >= 0）', () => {
    const formula = formulaOf(aggRow(1, 'ge', [1e-21]));
    expect(formula).toContain('行1.值 >= 0.000000000000000000001)');
    expect(matches(formula, { '行1.值': 0 })).toBe(false);
    expect(matches(formula, { '行1.值': 1e-21 })).toBe(true);
  });

  it('批量求值路径同样精确：一批对象里只有与阈值逐位相等的那个命中 eq', () => {
    const target = 0.0000001234567890123456;
    const { formula } = compiled(one(fieldRow(1, NUMBER, 'eq', [target]))).compiled;
    const subject = (id: string, value: PlainValue) => ({
      id,
      resolveField: (path: string): FieldLookup =>
        path === NUMBER.path ? { status: 'found', value } : { status: 'unknown' },
    });
    const subjects = [
      subject('exact', target),
      subject('rounded', 0.00000012345678901235), // 旧实现舍入后的值
      subject('zero', 0),
      subject('empty', null),
    ];
    const batch = evaluateBatch([{ field: '盘点对象.命中', priority: 1, formula }], subjects, {
      calendar: { today: '2026-10-09', timeZone: 'Asia/Shanghai' },
      fieldKind: (path) => KINDS[path],
    });
    if (!batch.ok) throw new Error('批量求值应当成功');
    const hit = (id: string) => {
      const result = batch.results[id]!['盘点对象.命中']!;
      return result.ok && result.value.kind === 'number' ? result.value.value : undefined;
    };
    expect(['exact', 'rounded', 'zero', 'empty'].map(hit)).toEqual([1, 0, 0, 0]);
  });

  describe.each(VALUES)('值 %s：aggregate 行与 number 字段行的匹配结果与数值比较一致', (value) => {
    const other = value === 42 ? 7 : 42;
    const cases: readonly [string, RuleConditionRow['values'], RuleOperator, boolean][] = [
      ['eq 单值', [value], 'eq', true],
      ['eq 多候选 IN', [other, value], 'eq', true],
      ['ne 单值', [value], 'ne', false],
      ['ne 多候选 NOTIN', [other, value], 'ne', false],
      ['gt', [value], 'gt', false],
      ['lt', [value], 'lt', false],
      ['ge', [value], 'ge', true],
      ['le', [value], 'le', true],
      ['between', [value, value], 'between', true],
    ];
    it.each(cases)('%s：注入同值', (_label, values, operator, expected) => {
      const aggregate = compiled(one(aggRow(1, operator, values))).compiled.formula;
      expect(matches(aggregate, { '行1.值': value })).toBe(expected);
      const field = compiled(one(fieldRow(1, NUMBER, operator, values))).compiled.formula;
      expect(matches(field, { [NUMBER.path]: value })).toBe(expected);
    });
  });
});

describe('每行候选值上限对所有运算符统一生效（第 2 轮 P3）', () => {
  const tooMany = Array.from({ length: 21 }, (_, i) => i);
  it.each(['is_empty', 'not_empty'] as const)('%s 带 21 个值 → RULE_TOO_LARGE 定位到行', (operator) => {
    expect(errorsOf(one(aggRow(3, operator, tooMany)))).toEqual([{ code: 'RULE_TOO_LARGE', rowNo: 3 }]);
  });

  it('20 个值的 is_empty 仍可编译（多余的值被忽略）', () => {
    expect(formulaOf(aggRow(1, 'is_empty', tooMany.slice(0, 20)))).toBe('IF((IsEmpty(行1.值)), 1, 0)');
  });
});

describe('option 值的引号 / 换行同样拒绝（第 2 轮 P3）', () => {
  it.each(['P5"', 'P5\nP6', 'P5\r'])('option 值 %j → RULE_LITERAL_INVALID', (bad) => {
    expect(errorsOf(one(fieldRow(4, OPTION, 'eq', [bad])))).toEqual([{ code: 'RULE_LITERAL_INVALID', rowNo: 4 }]);
    expect(errorsOf(one(fieldRow(4, OPTION, 'ne', ['P5', bad])))).toEqual([{ code: 'RULE_LITERAL_INVALID', rowNo: 4 }]);
  });
});

describe('引擎规模边界精确值（第 2 轮 P3）：4000 / 4001 字符，800 / 801 词', () => {
  const textRule = (padding: number) => one(fieldRow(1, TEXT, 'eq', ['字'.repeat(padding)]));
  const baseLength = compiled(textRule(0)).compiled.formula.length;

  it('公式恰 4000 字符通过，4001 字符 → RULE_TOO_LARGE', () => {
    const ok = compiled(textRule(4000 - baseLength)).compiled.formula;
    expect(ok).toHaveLength(4000);
    expect(errorsOf(textRule(4001 - baseLength))).toEqual([{ code: 'RULE_TOO_LARGE' }]);
  });

  // 引用行 1（not_empty）a 次、行 2（is_empty）b 次：词数 = 7 + 10a + 9b（含 eof，与引擎同口径）
  const tokenRule = (a: number, b: number): RuleSet => ({
    rows: [aggRow(1, 'not_empty'), aggRow(2, 'is_empty')],
    expression: [...Array.from({ length: a }, () => '1'), ...Array.from({ length: b }, () => '2')].join(' and '),
  });

  it('公式恰 800 词通过，801 词 → RULE_TOO_LARGE', () => {
    expect(tokenize(compiled(tokenRule(1, 87)).compiled.formula)).toHaveLength(800);
    expect(errorsOf(tokenRule(2, 86))).toEqual([{ code: 'RULE_TOO_LARGE' }]);
  });
});

describe('超长平铺表达式不抛未捕获异常（第 2 轮 P3）', () => {
  const rows = [aggRow(1, 'not_empty')];
  it.each(['or', 'and'] as const)('15 万个 1 用 %s 连接 → 规范错误码，不是 RangeError', (op) => {
    const expression = Array.from({ length: 150_000 }, () => '1').join(` ${op} `);
    const result = compileRuleSet({ rows, expression }, catalog);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((e) => e.code)).toEqual(['RULE_TOO_LARGE']);
  });

  it('括号内的超长平铺同样安全', () => {
    const expression = `(${Array.from({ length: 150_000 }, () => '1').join(' or ')})`;
    expect(compileRuleSet({ rows, expression }, catalog).ok).toBe(false);
  });
});
