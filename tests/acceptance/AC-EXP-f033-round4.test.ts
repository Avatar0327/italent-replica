/**
 * PR #108 第 4 轮（第 3 轮审查 GPT-6.1 Sol Ultra，head a61eed7）回归：保存检查与运行期的类型口径完全一致（DEC-287①）。
 * P2-1 Def 重新赋值：右侧按旧的类型环境求值，算完再登记新类型（与保存检查同序）。
 * P2-2 第 N 年 / 第 N 次：类型不确定的参数即使不可能是过滤条件、按 N 处理，保存时也给提示（DEC-287 补充，823a84c）。
 * P2-3 空值来源取统一推导：IF / 如果 没有命中且缺“否则”时带上来源类型；数值 IF 的空结果不当空日期（DEC-270②）。
 * 另有“保存 / 单公式 / 批量”一致性参数化测试：同一公式三条入口的类型判断与报错必须一致。
 */
import {
  createInMemoryPorts,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  validateFormula,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
  type StaticKind,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor, PROJECT } from './AC-EXP-support.js';

type FieldKind = (path: string) => StaticKind | undefined;

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });
const catalog =
  (kinds: Readonly<Record<string, StaticKind>>): FieldKind =>
  (path) =>
    kinds[path];

const PERF_PORTS: InMemoryPortData = {
  performance: {
    'emp-1': [
      { fields: { 年度: 2026, 周期名称: '年度', 得分: 90, 等级: 'A' }, modifiedAt: new Date('2026-01-01T00:00:00Z') },
      { fields: { 年度: 2024, 周期名称: '年度', 得分: 80, 等级: 'B' }, modifiedAt: new Date('2025-01-01T00:00:00Z') },
      { fields: { 年度: 2023, 周期名称: '年度', 得分: 70, 等级: 'C' }, modifiedAt: new Date('2024-01-01T00:00:00Z') },
    ],
  },
};
const ITEM = '盘点对象.结果';
/** emp-1 有考核结果，emp-2 没有：批量求值同时算两个对象，核对与逐个单公式求值的结果一致。 */
const SUBJECTS = ['emp-1', 'emp-2'] as const;

interface Paths {
  readonly save: { readonly errors: readonly string[]; readonly warnings: readonly string[] };
  readonly single: Readonly<Record<string, unknown>>;
  readonly batch: Readonly<Record<string, unknown>>;
}

/** 同一公式走三条入口：保存检查、单公式求值（每个对象）、批量求值（全部对象一批）。 */
function throughAllPaths(formula: string, fields: Record<string, PlainValue> = {}, fieldKind?: FieldKind): Paths {
  const validated = validateFormula(formula, { fieldKind });
  const save = validated.ok
    ? { errors: [], warnings: validated.warnings.map((warning) => warning.code) }
    : { errors: validated.errors.map((issue) => issue.code), warnings: [] };
  const single = Object.fromEntries(
    SUBJECTS.map((id) => {
      const context = { ...contextFor(fields, { ports: PERF_PORTS, subjectId: id }), fieldKind };
      return [id, valueOf(evaluateFormula(formula, context))];
    }),
  );
  const subjects = SUBJECTS.map((id) => inMemorySubject(id, fields));
  const ports = createInMemoryPorts(PERF_PORTS);
  const result = evaluateBatch([{ field: ITEM, priority: 1, formula }], subjects, {
    calendar: CALENDAR,
    project: PROJECT,
    ports,
    fieldKind,
  });
  const batch = Object.fromEntries(
    SUBJECTS.map((id) => [id, result.ok ? valueOf(result.results[id]![ITEM]!) : result.failure]),
  );
  return { save, single, batch };
}

interface Expected {
  /** 保存结果：报错码，或提示条数。 */
  readonly save: 'ARGUMENT_TYPE' | number;
  /** emp-1 的计算结果：值，或失败码。 */
  readonly result?: unknown;
}

/** 三条入口一致：保存报错时单公式与批量同码失败；否则批量与单公式逐对象相同，emp-1 符合预期。 */
function expectConsistent(paths: Paths, expected: Expected) {
  if (expected.save === 'ARGUMENT_TYPE') {
    expect(paths.save.errors).toEqual(['ARGUMENT_TYPE']);
    for (const id of SUBJECTS) {
      expect(paths.single[id]).toMatchObject({ code: 'ARGUMENT_TYPE' });
      expect(paths.batch[id]).toMatchObject({ code: 'ARGUMENT_TYPE' });
    }
    return;
  }
  expect(paths.save.errors).toEqual([]);
  expect(paths.save.warnings).toEqual(Array.from({ length: expected.save }, () => 'TYPE_UNCERTAIN'));
  expect(paths.batch).toEqual(paths.single);
  const result = expected.result as Record<string, unknown>;
  if ('code' in result) expect(paths.single['emp-1']).toMatchObject(result);
  else expect(paths.single['emp-1']).toEqual(result);
}

const warningsOf = (formula: string, fieldKind?: FieldKind) => {
  const validated = validateFormula(formula, { fieldKind });
  if (!validated.ok) throw new Error(`应能保存：${formula}（${validated.errors[0]?.message}）`);
  return validated.warnings;
};
const run = (formula: string, fields: Record<string, PlainValue> = {}) =>
  valueOf(evaluateFormula(formula, contextFor(fields, { ports: PERF_PORTS })));

const RECENT = 'PerformanceLastCent(n, 考核结果.周期名称="年度")';

describe('P2-1 Def 重新赋值：右侧按旧的类型环境求值，算完再登记（保存 / 单公式 / 批量一致）', () => {
  it.each([
    ['审查原例', `Def(n, 1); Def(n, ${RECENT} > 0); n`],
    ['右侧用 IF 包裹', `Def(n, 1); Def(n, IF(${RECENT} > 0, 真, 假)); n`],
    ['IF 的分支里取数', `Def(n, 1); Def(n, IF(真, ${RECENT} > 0, 假)); n`],
    ['右侧用 如果 包裹', `Def(n, 1); Def(n, 如果 ${RECENT} > 0 那么 真 否则 假); n`],
  ])('%s：%s → 真，保存无提示', (_label, formula) => {
    expectConsistent(throughAllPaths(formula), { save: 0, result: bool(true) });
  });

  it('反方向：旧值是是否型（过滤条件），新值是数值 → 右侧的同名变量仍按过滤条件', () => {
    const formula = 'Def(b, 真); Def(b, PerformanceLastCent(1, 考核结果.周期名称="年度", b)); b';
    expectConsistent(throughAllPaths(formula), { save: 0, result: num(90) });
  });

  it('右侧引用同名旧变量的空值：空值来源按旧类型（不确定），真正的空日期仍按 0001-01-01', () => {
    const formula = 'Def(d, 员工信息.出生日期); Def(d, Year(AddDays(d, 1))); d';
    expectConsistent(throughAllPaths(formula, { '员工信息.出生日期': null }), { save: 1, result: num(1) });
    const fieldKind = catalog({ '员工信息.出生日期': 'date' });
    expectConsistent(throughAllPaths(formula, { '员工信息.出生日期': null }, fieldKind), { save: 0, result: num(1) });
  });
});

describe('P2-2 类型不确定的参数按 N 处理时，保存也给提示（DEC-287 补充）', () => {
  it.each([
    ['PerformanceLastCent(IF(假, 2, Today()))', { code: 'TYPE_CONVERSION' }],
    ['PerformanceLastGrade(IF(假, 2, Today()))', { code: 'TYPE_CONVERSION' }],
    ['PerformanceNthCent(IF(假, 2, Today()), 考核结果.周期名称="年度")', { code: 'TYPE_CONVERSION' }],
    ['PerformanceNthGrade(IF(假, 2, Today()), 考核结果.周期名称="年度")', { code: 'TYPE_CONVERSION' }],
    ['PerformanceLastCent(IF(真, 2, Today()))', num(80)],
    ['PerformanceLastCent(IF(真, 1, "2"))', num(90)],
    ['PerformanceLastGrade(IF(假, 1, "2"))', text('B')],
    ['Def(k, IF(真, 1, "2")); PerformanceNthCent(k, 考核结果.周期名称="年度")', num(90)],
    ['Def(k, IF(假, 2, Today())); Def(m, k); PerformanceLastCent(m)', { code: 'TYPE_CONVERSION' }],
    ['PerformanceLastCent(Sum(1, 1))', num(80)],
    ['PerformanceNthGrade(Sum(1, 1), 考核结果.周期名称="年度")', text('B')],
  ] as const)('%s：保存提示“类型不确定，按 N 处理”；三条入口一致', (formula, result) => {
    const warnings = warningsOf(formula);
    expect(warnings.map((warning) => warning.code)).toEqual(['TYPE_UNCERTAIN']);
    expect(warnings[0]?.message).toMatch(/第 1 个参数类型不确定，按 N 处理/);
    expectConsistent(throughAllPaths(formula), { save: 1, result });
  });

  it('有字段类型目录、类型确定时不提示', () => {
    const fieldKind = catalog({ '盘点对象.N': 'number' });
    expect(warningsOf('PerformanceLastCent(盘点对象.N)', fieldKind)).toEqual([]);
    expect(warningsOf('PerformanceLastCent(IF(真, 盘点对象.N, 2))', fieldKind)).toEqual([]);
  });

  it('不确定的参数与确定的 N 同时出现：仍是两个 N，保存报错', () => {
    expectConsistent(throughAllPaths('PerformanceLastCent(1, Sum(1, 1))'), { save: 'ARGUMENT_TYPE' });
  });
});

describe('P2-3 空值来源取统一推导：IF / 如果 没有命中且缺“否则”时带上来源类型', () => {
  it.each([
    'Year(IF(假, Today(), IF(假, 1)))',
    'Year(如果 假 那么 Today() 否则 如果 假 那么 1)',
    'Year(IF(假, Today(), 如果 假 那么 1))',
    'Def(n, IF(假, 1)); Def(m, n); Year(IF(假, Today(), m))',
    'Def(n, 如果 假 那么 1); Def(m, n); Year(如果 假 那么 Today() 否则 m)',
    'Def(n, IF(假, Today(), IF(假, 1))); Year(AddDays(n, 1))',
    'DateFormat(如果 假 那么 Today() 否则 如果 假 那么 "a", "yyyy")',
  ])('%s → 保存提示，计算 TYPE_CONVERSION（不是 1 / 0001）', (formula) => {
    expectConsistent(throughAllPaths(formula), { save: 1, result: { code: 'TYPE_CONVERSION' } });
    expect(run(formula)).toMatchObject({ message: expect.stringMatching(/的空值不能作为日期/) });
  });

  it('没有命中时的空值来源：函数形式 IF 取“值”的类型；多段 如果 取最后一段（等同逐层嵌套的 否则 如果）', () => {
    expect(run('IF(假, 1)')).toEqual({ kind: 'empty', of: 'number' });
    expect(run('如果 假 那么 1')).toEqual({ kind: 'empty', of: 'number' });
    expect(run('如果 假 那么 Today() 否则 如果 假 那么 "a"')).toEqual({ kind: 'empty', of: 'text' });
    expect(run('如果 假 那么 1 否则 如果 假 那么 Today()')).toEqual({ kind: 'empty', of: 'date' });
    expect(run('Def(n, 如果 假 那么 1); n')).toEqual({ kind: 'empty', of: 'number' });
  });

  it('来源是日期的空值仍按 0001-01-01（DEC-270②）：各分支都是日期，或最后一段是日期', () => {
    expectConsistent(throughAllPaths('Year(IF(假, Today(), IF(假, Today())))'), { save: 0, result: num(1) });
    expectConsistent(throughAllPaths('Year(如果 假 那么 Today())'), { save: 0, result: num(1) });
    expectConsistent(throughAllPaths('Year(如果 假 那么 1 否则 如果 假 那么 Today())'), { save: 1, result: num(1) });
  });

  it('来源未知的空值（没有目录的字段）仍按 0001-01-01，保存时提示', () => {
    const fields = { '员工信息.出生日期': null };
    expectConsistent(throughAllPaths('Year(IF(假, 1, 员工信息.出生日期))', fields), { save: 1, result: num(1) });
  });
});

describe('保存 / 单公式 / 批量一致性：同一公式三条入口的类型判断与报错一致', () => {
  const boolKind = catalog({ '盘点对象.是否参与': 'boolean', '盘点对象.N': 'number', '盘点对象.得分': 'number' });
  const cases: readonly (readonly [string, string, Record<string, PlainValue>, FieldKind | undefined, Expected])[] = [
    [
      'Def 重新赋值：N → 过滤条件',
      `Def(n, 1); Def(n, ${RECENT} > 0); n`,
      {},
      undefined,
      { save: 0, result: bool(true) },
    ],
    [
      'Def 重新赋值：过滤条件 → N',
      'Def(b, 真); Def(b, PerformanceLastCent(1, 考核结果.周期名称="年度", b)); b',
      {},
      undefined,
      { save: 0, result: num(90) },
    ],
    [
      'Def 重新赋值：右侧经 如果',
      `Def(n, 1); Def(n, 如果 ${RECENT} > 0 那么 真 否则 假); n`,
      {},
      undefined,
      { save: 0, result: bool(true) },
    ],
    [
      '不确定 N（数值 / 日期）',
      'PerformanceLastCent(IF(假, 2, Today()))',
      {},
      undefined,
      {
        save: 1,
        result: { code: 'TYPE_CONVERSION' },
      },
    ],
    ['不确定 N（Sum）', 'PerformanceLastCent(Sum(1, 1))', {}, undefined, { save: 1, result: num(80) }],
    ['两个 N', 'PerformanceLastCent(1, Sum(1, 1))', {}, undefined, { save: 'ARGUMENT_TYPE' }],
    [
      '目录标明是否型的过滤条件',
      'PerformanceLastCent(1, 盘点对象.是否参与)',
      { '盘点对象.是否参与': true },
      boolKind,
      {
        save: 0,
        result: num(90),
      },
    ],
    [
      '目录标明数值的字段 N',
      'PerformanceLastCent(盘点对象.N)',
      { '盘点对象.N': 2 },
      boolKind,
      {
        save: 0,
        result: num(80),
      },
    ],
    [
      '数值 IF 的空值进日期参数',
      'Year(IF(假, Today(), IF(假, 1)))',
      {},
      undefined,
      {
        save: 1,
        result: { code: 'TYPE_CONVERSION' },
      },
    ],
    [
      '数值 如果 的空值进日期参数',
      'Year(如果 假 那么 Today() 否则 如果 假 那么 1)',
      {},
      undefined,
      {
        save: 1,
        result: { code: 'TYPE_CONVERSION' },
      },
    ],
    [
      '目录标为数值的空字段进日期参数',
      'Year(IF(假, Today(), 盘点对象.得分))',
      { '盘点对象.得分': null },
      boolKind,
      {
        save: 1,
        result: { code: 'TYPE_CONVERSION' },
      },
    ],
    ['日期 IF 的空值', 'Year(IF(假, Today(), IF(假, Today())))', {}, undefined, { save: 0, result: num(1) }],
    ['确定不是日期', 'Year(IF(真, 1, "abc"))', {}, undefined, { save: 'ARGUMENT_TYPE' }],
    [
      '取数结果经 Def 进日期参数',
      'Def(n, IF(真, 获取指定年度指定周期的绩效得分(考核结果.年度=1999, 考核结果.周期名称="年度"), "abc")); Year(AddDays(n, 1))',
      {},
      undefined,
      { save: 'ARGUMENT_TYPE' },
    ],
  ];

  it.each(cases)('%s：%s', (_label, formula, fields, fieldKind, expected) => {
    expectConsistent(throughAllPaths(formula, fields, fieldKind), expected);
  });
});
