/**
 * AC-EXP 第四轮回归（astra 第三轮审查 → DEC-228，PR #90）：
 * `对象.字段` 形式的字段引用里，连字符一律属于字段名；两个字段相减须在减号两侧加空格；Def 变量、数字之间的 a-b 仍是减法。
 * 保存校验（传入字段目录）、单公式求值、批量求值三条入口对同一公式同一解释、同一结果。
 */
import {
  createInMemoryPorts,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  orderComputationItems,
  validateFormula,
  type EvaluationResult,
  type InMemoryPortData,
  type SubjectReader,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor, PROJECT } from './AC-EXP-support.js';

const HINT = '如需相减，请在减号两侧加空格';
const FIELDS = { '盘点对象.得分': 5, '盘点对象.基准': 2, '盘点对象.得分-上级分': 4 };
const isKnownField = (path: string) => Object.hasOwn(FIELDS, path);
const TARGET = '盘点对象.结果';
const num = (value: number) => ({ kind: 'number', value });

interface Entry {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly code?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message?: string;
}

function viaValidation(formula: string): Entry {
  const result = validateFormula(formula, { isKnownField });
  if (result.ok) return { ok: true };
  const { code, line, column, message } = result.errors[0]!;
  return { ok: false, code, line, column, message };
}

function fromResult(result: EvaluationResult | undefined): Entry {
  if (!result) return { ok: false, code: 'MISSING' };
  if (result.ok) return { ok: true, value: result.value };
  const { code, line, column, message } = result.failure;
  return { ok: false, code, line, column, message };
}

function viaSingle(formula: string, subject: SubjectReader = inMemorySubject('e1', FIELDS)): Entry {
  return fromResult(evaluateFormula(formula, { subject, calendar: CALENDAR, project: PROJECT }));
}

function viaBatch(formula: string, subject: SubjectReader = inMemorySubject('e1', FIELDS)): Entry {
  const items = [{ field: TARGET, priority: 1, formula }];
  const batch = evaluateBatch(items, [subject], { calendar: CALENDAR, project: PROJECT });
  if (batch.ok) return fromResult(batch.results[subject.id]?.[TARGET]);
  const failure = batch.failure;
  if (failure.code === 'CYCLIC_DEPENDENCY') return { ok: false, code: failure.code, message: failure.message };
  return { ok: false, code: failure.code, line: failure.line, column: failure.column, message: failure.message };
}

function expectValueInAllEntries(formula: string, value: unknown): void {
  expect(viaValidation(formula)).toEqual({ ok: true });
  expect(viaSingle(formula)).toEqual({ ok: true, value });
  expect(viaBatch(formula)).toEqual({ ok: true, value });
}

/** 三条入口失败码相同、位置相同；withHint 时文案都含“如需相减，请在减号两侧加空格”。返回保存校验的结果。 */
function expectFailureInAllEntries(formula: string, code: string, withHint: boolean): Entry {
  const [validation, ...others] = [viaValidation(formula), viaSingle(formula), viaBatch(formula)];
  expect(validation).toMatchObject({ ok: false, code });
  for (const entry of others) {
    expect(entry).toMatchObject({ ok: false, code, line: validation!.line, column: validation!.column });
  }
  for (const entry of [validation!, ...others]) {
    if (withHint) expect(entry.message).toContain(HINT);
    else expect(entry.message).not.toContain(HINT);
  }
  return validation!;
}

describe('DEC-228 词法：字段引用里的连字符一律属于字段名', () => {
  it('两个字段相减加空格得 3；不加空格是一个字段名，三条入口都报带提示的 UNKNOWN_FIELD 并给出位置', () => {
    expectValueInAllEntries('盘点对象.得分 - 盘点对象.基准', num(3));
    const failure = expectFailureInAllEntries('盘点对象.得分-盘点对象.基准', 'UNKNOWN_FIELD', true);
    expect(failure).toMatchObject({
      line: 1,
      column: 1,
      message: expect.stringContaining('盘点对象.得分-盘点对象.基准'),
    });
  });

  it('A 为字段引用时整体按字段名解析：字段减数字、字段减 Def 变量同样须加空格', () => {
    expectFailureInAllEntries('盘点对象.得分-1', 'UNKNOWN_FIELD', true);
    expectValueInAllEntries('盘点对象.得分 - 1', num(4));
    expectFailureInAllEntries('Def(基准值, 2); 盘点对象.得分-基准值', 'UNKNOWN_FIELD', true);
    expectValueInAllEntries('Def(基准值, 2); 盘点对象.得分 - 基准值', num(3));
  });

  it('Def 变量、数字之间的 a-b 仍是减法', () => {
    expectValueInAllEntries('Def(a, 10); Def(b, 3); a-b', num(7));
    expectValueInAllEntries('Def(总分, 10); Def(上级分, 4); 总分-上级分', num(6));
    expectValueInAllEntries('Def(a, 10); a-3', num(7));
    expectValueInAllEntries('10-3', num(7));
  });
});

describe('原站连字符字段按完整字段读取，不误报循环', () => {
  it('盘点对象.得分-上级分 在三条入口都读完整字段', () => {
    expectValueInAllEntries('盘点对象.得分-上级分 + 1', num(5));
  });

  it('目标字段与连字符字段同前缀（盘点对象.得分 = 盘点对象.得分-上级分 + 1）不是自循环', () => {
    const items = [{ field: '盘点对象.得分', priority: 1, formula: '盘点对象.得分-上级分 + 1' }];
    const ordered = orderComputationItems(items, { isKnownField });
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.entries[0]?.dependsOn).toEqual([]);
    const batch = evaluateBatch(items, [inMemorySubject('e1', FIELDS)], { calendar: CALENDAR });
    expect(batch.ok).toBe(true);
    if (batch.ok) expect(batch.results.e1?.['盘点对象.得分']).toEqual({ ok: true, value: num(5) });
  });

  it('360结果.问卷-他评总分 在取数函数里按记录字段读取，保存校验不按对象字段目录误报', () => {
    const data: InMemoryPortData = {
      survey360: {
        e1: [{ startAt: new Date('2026-09-10T00:00:00Z'), fields: { '问卷-他评总分': 4.2, 角色名称: '上级' } }],
      },
    };
    const formula = 'Lastest360Cent(360结果.问卷-他评总分, 360结果.角色名称="上级")';
    const validated = validateFormula(formula, { isKnownField });
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.fields).toContain('360结果.问卷-他评总分');
    const single = evaluateFormula(formula, contextFor(FIELDS, { ports: data, subjectId: 'e1' }));
    expect(single).toEqual({ ok: true, value: num(4.2) });
    const items = [{ field: TARGET, priority: 1, formula }];
    const ports = createInMemoryPorts(data);
    const batch = evaluateBatch(items, [inMemorySubject('e1', FIELDS)], {
      calendar: CALENDAR,
      project: PROJECT,
      ports,
    });
    expect(batch.ok && batch.results.e1?.[TARGET]).toEqual({ ok: true, value: num(4.2) });
  });
});

describe('读取器抛异常：结构化 DATA_UNAVAILABLE，不改成别的解释', () => {
  const throwing: SubjectReader = {
    id: 'e1',
    resolveField: (path) => {
      if (path === '盘点对象.得分-基准') throw new Error('secret-reader-detail');
      if (path === '盘点对象.得分') return { status: 'found', value: 5 };
      if (path === '基准') return { status: 'found', value: 2 };
      return { status: 'unknown' };
    },
  };

  it('单公式求值与批量求值都返回 DATA_UNAVAILABLE，不拆成 盘点对象.得分 - 基准，也不透出异常内容', () => {
    for (const entry of [viaSingle('盘点对象.得分-基准', throwing), viaBatch('盘点对象.得分-基准', throwing)]) {
      expect(entry).toMatchObject({ ok: false, code: 'DATA_UNAVAILABLE', line: 1, column: 1 });
      expect(JSON.stringify(entry)).not.toContain('secret');
    }
  });
});

describe('带空白、全角括号的写法三条入口结果一致', () => {
  it.each(['盘点对象.得分-转换为数字("2")', '盘点对象.得分-转换为数字 ("2")', '盘点对象.得分-转换为数字（"2"）'])(
    '%s：连字符并入字段名，后面的括号是语法错误并提示加空格',
    (formula) => {
      expectFailureInAllEntries(formula, 'SYNTAX_ERROR', true);
    },
  );

  it.each(['盘点对象.得分 - 转换为数字("2")', '盘点对象.得分 - 转换为数字 ("2")', '盘点对象.得分 - 转换为数字（"2"）'])(
    '%s → 3',
    (formula) => {
      expectValueInAllEntries(formula, num(3));
    },
  );

  it('对象名与“.”之间有空白：不加空格仍是一个字段名，加空格是减法', () => {
    expectFailureInAllEntries('盘点对象.得分-盘点对象 .基准', 'UNKNOWN_FIELD', true);
    expectValueInAllEntries('盘点对象.得分 - 盘点对象 .基准', num(3));
    expectValueInAllEntries('盘点对象 . 得分 - 盘点对象 . 基准', num(3));
  });
});

describe('保存校验：传入字段目录时报未知字段；三条入口对静态错误一致', () => {
  it('计算规则保存（orderComputationItems）同样报带提示的 UNKNOWN_FIELD，计算项目的目标字段视为已知', () => {
    const rejected = orderComputationItems([{ field: TARGET, priority: 1, formula: '盘点对象.得分-盘点对象.基准' }], {
      isKnownField,
    });
    expect(rejected).toMatchObject({
      ok: false,
      failure: { code: 'UNKNOWN_FIELD', field: TARGET, line: 1, column: 1 },
    });
    if (!rejected.ok) expect(rejected.failure.message).toContain(HINT);
    const items = [
      { field: '盘点对象.甲', priority: 1, formula: '1' },
      { field: '盘点对象.乙', priority: 2, formula: '盘点对象.甲 + 甲' },
    ];
    expect(orderComputationItems(items, { isKnownField }).ok).toBe(true);
  });

  it('记录对象字段只在对应取数函数的参数里免检；取数函数参数里的对象字段照常检查', () => {
    const gld = '获取指定年度指定周期的绩效得分(考核结果.年度="2026",考核结果.周期名称="年度") ≥ 90';
    expect(validateFormula(gld, { isKnownField }).ok).toBe(true);
    expect(validateFormula('考核结果.年度 + 1', { isKnownField })).toMatchObject({
      ok: false,
      errors: [{ code: 'UNKNOWN_FIELD', line: 1, column: 1 }],
    });
    const mixed = 'PerformanceCent(考核结果.年度=盘点对象.不存在, 考核结果.周期名称="年度")';
    expect(validateFormula(mixed, { isKnownField })).toMatchObject({
      ok: false,
      errors: [{ code: 'UNKNOWN_FIELD', column: 25 }],
    });
  });

  it('Def 变量只在定义之后可用：先引用后定义按字段处理，三条入口一致', () => {
    const failure = expectFailureInAllEntries('Def(x, y); Def(y, 1); x', 'UNKNOWN_FIELD', false);
    expect(failure).toMatchObject({ line: 1, column: 8 });
  });

  it('不传字段目录时只查语法、函数名、参数个数，并返回引用到的字段供调用方自查', () => {
    expect(validateFormula('盘点对象.得分-盘点对象.基准')).toMatchObject({
      ok: true,
      fields: ['盘点对象.得分-盘点对象.基准'],
    });
  });

  it('中文引号、未走到的分支里的未知函数与参数个数错误：三条入口失败码与位置相同', () => {
    expect(expectFailureInAllEntries('盘点对象.得分 = “高”', 'CHINESE_QUOTE', false)).toMatchObject({ column: 11 });
    expect(expectFailureInAllEntries('如果 真 那么 1 否则 不存在的函数(1)', 'UNKNOWN_FUNCTION', false)).toMatchObject({
      column: 14,
    });
    expectFailureInAllEntries('如果 真 那么 1 否则 ToNumber(1, 2)', 'ARGUMENT_COUNT', false);
  });
});
