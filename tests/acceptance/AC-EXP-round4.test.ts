/**
 * AC-EXP 第四轮回归（astra 第三轮审查 → DEC-228，PR #90；R3e 按 #89-4 改）：
 * `对象.字段` 后紧挨着的 `-名字`，合并后的完整名是已存在字段才是一个字段名，否则按减法（原站实测不加空格也相减）；
 * 不再提示“如需相减，请在减号两侧加空格”。Def 变量、数字之间的 a-b 仍是减法。
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

/** 三条入口失败码相同、位置相同，文案都不再含“如需相减，请在减号两侧加空格”（#89-4）。返回保存校验的结果。 */
function expectFailureInAllEntries(formula: string, code: string): Entry {
  const [validation, ...others] = [viaValidation(formula), viaSingle(formula), viaBatch(formula)];
  expect(validation).toMatchObject({ ok: false, code });
  for (const entry of others) {
    expect(entry).toMatchObject({ ok: false, code, line: validation!.line, column: validation!.column });
  }
  for (const entry of [validation!, ...others]) expect(entry.message).not.toContain(HINT);
  return validation!;
}

describe('#89-4 词法 / 语法：字段引用后的连字符按字段目录定型，否则是减号', () => {
  it('两个字段相减加不加空格都得 3（旧口径 DEC-228：不加空格报带提示的 UNKNOWN_FIELD）', () => {
    expectValueInAllEntries('盘点对象.得分 - 盘点对象.基准', num(3));
    expectValueInAllEntries('盘点对象.得分-盘点对象.基准', num(3));
  });

  it('字段减数字、字段减 Def 变量不加空格也是减法', () => {
    expectValueInAllEntries('盘点对象.得分-1', num(4));
    expectValueInAllEntries('盘点对象.得分 - 1', num(4));
    expectValueInAllEntries('Def(基准值, 2); 盘点对象.得分-基准值', num(3));
    expectValueInAllEntries('Def(基准值, 2); 盘点对象.得分 - 基准值', num(3));
  });

  it('右侧不存在时按减法报右侧的未知字段，三条入口位置一致', () => {
    const failure = expectFailureInAllEntries('盘点对象.得分-盘点对象.不存在', 'UNKNOWN_FIELD');
    expect(failure).toMatchObject({ line: 1, column: 9, message: expect.stringContaining('盘点对象.不存在') });
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
        e1: [
          {
            startAt: new Date('2026-09-10T00:00:00Z'),
            endAt: new Date('2026-09-20T00:00:00Z'),
            reportGeneratedAt: new Date('2026-09-21T00:00:00Z'),
            fields: { '问卷-他评总分': 4.2, 角色名称: '上级' },
          },
        ],
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
  it.each([
    '盘点对象.得分-转换为数字("2")',
    '盘点对象.得分-转换为数字 ("2")',
    '盘点对象.得分-转换为数字（"2"）',
    '盘点对象.得分 - 转换为数字("2")',
    '盘点对象.得分 - 转换为数字 ("2")',
    '盘点对象.得分 - 转换为数字（"2"）',
  ])('%s → 3（旧口径 DEC-228：不加空格时括号处报语法错误）', (formula) => {
    expectValueInAllEntries(formula, num(3));
  });

  it('对象名与“.”之间有空白：加不加空格都是减法', () => {
    expectValueInAllEntries('盘点对象.得分-盘点对象 .基准', num(3));
    expectValueInAllEntries('盘点对象.得分 - 盘点对象 .基准', num(3));
    expectValueInAllEntries('盘点对象 . 得分 - 盘点对象 . 基准', num(3));
  });
});

describe('保存校验：传入字段目录时报未知字段；三条入口对静态错误一致', () => {
  it('计算规则保存（orderComputationItems）同样报 UNKNOWN_FIELD（不再提示加空格），计算项目的目标字段视为已知', () => {
    const rejected = orderComputationItems([{ field: TARGET, priority: 1, formula: '盘点对象.得分-盘点对象.不存在' }], {
      isKnownField,
    });
    expect(rejected).toMatchObject({
      ok: false,
      failure: { code: 'UNKNOWN_FIELD', field: TARGET, line: 1, column: 9 },
    });
    if (!rejected.ok) expect(rejected.failure.message).not.toContain(HINT);
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
    const failure = expectFailureInAllEntries('Def(x, y); Def(y, 1); x', 'UNKNOWN_FIELD');
    expect(failure).toMatchObject({ line: 1, column: 8 });
  });

  it('不传字段目录时只查语法、函数名、参数个数，并返回引用到的字段供调用方自查（连字符按减法）', () => {
    expect(validateFormula('盘点对象.得分-盘点对象.基准')).toMatchObject({
      ok: true,
      fields: ['盘点对象.得分', '盘点对象.基准'],
    });
  });

  it('中文引号、未走到的分支里的未知函数与参数个数错误：三条入口失败码与位置相同', () => {
    expect(expectFailureInAllEntries('盘点对象.得分 = “高”', 'CHINESE_QUOTE')).toMatchObject({ column: 11 });
    expect(expectFailureInAllEntries('如果 真 那么 1 否则 不存在的函数(1)', 'UNKNOWN_FUNCTION')).toMatchObject({
      column: 14,
    });
    expectFailureInAllEntries('如果 真 那么 1 否则 ToNumber(1, 2)', 'ARGUMENT_COUNT');
  });
});
