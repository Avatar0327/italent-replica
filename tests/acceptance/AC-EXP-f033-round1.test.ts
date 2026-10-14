/**
 * PR #108 第 1 轮审查（GPT-6.1 Sol Ultra）回归：
 * P2-1 日期参数的保存检查不能被 Def 变量 / IF 绕过（DEC-270②），并可接字段类型目录；
 * P2-2 第 N 年 / 第 N 次的 N 写成字段、变量或算式时仍是 N，不能被当成过滤条件；
 * P3-1 循环提示列出同一强连通分量里的全部环（DEC-274）；
 * P3-2 舍入只纠正浮点表示误差，不把 16 位有效数字的输入压成 15 位。
 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  orderComputationItems,
  validateFormula,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
  type StaticKind,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const codesOf = (formula: string, options?: Parameters<typeof validateFormula>[1]) => {
  const validated = validateFormula(formula, options);
  return validated.ok ? [] : validated.errors.map((issue) => issue.code);
};

const EMPTY_PERF = 'PerformanceCent(考核结果.年度=1999, 考核结果.周期名称="年度")';
const PERF_PORTS: InMemoryPortData = {
  performance: {
    'emp-1': [
      { fields: { 年度: 2026, 周期名称: '年度', 得分: 90 }, modifiedAt: new Date('2026-01-01T00:00:00Z') },
      { fields: { 年度: 2024, 周期名称: '年度', 得分: 80 }, modifiedAt: new Date('2025-01-01T00:00:00Z') },
      { fields: { 年度: 2023, 周期名称: '年度', 得分: 70 }, modifiedAt: new Date('2024-01-01T00:00:00Z') },
    ],
  },
};

describe('P2-1 日期参数保存检查：Def 变量与 IF 的静态类型参与检查（DEC-270②）', () => {
  it.each([
    ['Def(n, 1); AddDays(n, 1)'],
    ['AddDays(IF(真, 1, 2), 1)'],
    [`Def(n, ${EMPTY_PERF}); Year(AddDays(n, 1))`],
    ['Def(a, 1); Def(b, a); AddDays(b, 1)'],
    ['AddDays(如果 真 那么 1 否则 2, 1)'],
    ['Year(IF(真, "abc", "def"))'],
  ])('%s → 保存检查 ARGUMENT_TYPE', (formula) => {
    expect(codesOf(formula)).toEqual(['ARGUMENT_TYPE']);
  });

  it('Def(n, 取数函数) 后 Year(AddDays(n, 1))：保存不通过，单公式与批量计算都不会返回 1', () => {
    const formula = `Def(n, ${EMPTY_PERF}); Year(AddDays(n, 1))`;
    expect(valueOf(evaluateFormula(formula, contextFor({}, { ports: PERF_PORTS })))).toMatchObject({
      code: 'ARGUMENT_TYPE',
    });
    const batch = evaluateBatch([{ field: '盘点对象.a', priority: 1, formula }], [inMemorySubject('emp-1', {})], {
      calendar: CALENDAR,
    });
    expect(batch).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE' } });
  });

  it.each([
    'Def(d, Today()); Year(AddDays(d, 1))',
    'Year(IF(真, Today(), "2020/01/01"))',
    'Year(如果 真 那么 Today() 否则 "2020/01/01")',
    'Def(d, 员工信息.出生日期); Year(AddDays(d, 1))',
    'Year(IF(真, 员工信息.出生日期, 1))',
  ])('能确定为日期或类型不确定时照常通过：%s', (formula) => {
    expect(codesOf(formula)).toEqual([]);
  });

  it('真正的空日期字段仍按 0001-01-01 计算（DEC-270②）', () => {
    const fields = { '员工信息.出生日期': null };
    expect(valueOf(evaluateFormula('Def(d, 员工信息.出生日期); Year(AddDays(d, 1))', contextFor(fields)))).toEqual(
      num(1),
    );
  });

  describe('字段类型目录 fieldKind：字段类型能确定的也参与检查', () => {
    const KINDS: Readonly<Record<string, StaticKind>> = {
      '盘点对象.得分': 'number',
      '盘点对象.备注': 'text',
      '员工信息.入职日期': 'date',
    };
    const fieldKind = (path: string) => KINDS[path];

    it.each(['AddDays(盘点对象.得分, 1)', 'Year(盘点对象.备注)', 'Def(x, 盘点对象.得分); AddDays(x, 1)'])(
      '%s → ARGUMENT_TYPE',
      (formula) => {
        expect(codesOf(formula, { fieldKind })).toEqual(['ARGUMENT_TYPE']);
      },
    );

    it('日期字段、目录里没有的字段照常通过；取数函数参数里的记录字段不按对象字段目录检查', () => {
      expect(codesOf('AddDays(员工信息.入职日期, 1)', { fieldKind })).toEqual([]);
      expect(codesOf('AddDays(员工信息.出生日期, 1)', { fieldKind })).toEqual([]);
      const recordKind = (path: string): StaticKind | undefined => (path === '考核结果.年度' ? 'number' : undefined);
      const formula = 'PerformanceCent(Year(考核结果.年度) = 2026, 考核结果.周期名称="年度")';
      expect(codesOf(formula, { fieldKind: recordKind })).toEqual([]);
    });

    it('目录读取出错时不拦截（类型未知），也不抛异常', () => {
      const broken = () => {
        throw new Error('目录不可用');
      };
      expect(codesOf('AddDays(盘点对象.得分, 1)', { fieldKind: broken })).toEqual([]);
    });

    it('计算项目排序（保存 / 启用）同样使用字段类型目录', () => {
      const ordered = orderComputationItems(
        [{ field: '盘点对象.a', priority: 1, formula: 'AddDays(盘点对象.得分, 1)' }],
        {
          fieldKind,
        },
      );
      expect(ordered).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE' } });
    });
  });
});

describe('P2-2 第 N 年 / 第 N 次：N 写成字段、变量或算式仍是 N（经公共取参）', () => {
  const run = (formula: string, fields: Record<string, PlainValue>, forbidden?: readonly string[]) =>
    valueOf(evaluateFormula(formula, contextFor(fields, { ports: PERF_PORTS, forbidden })));

  it.each([
    ['PerformanceLastCent(盘点对象.N)', num(80)],
    ['PerformanceLastCent(盘点对象.N + 0)', num(80)],
    ['PerformanceLastCent(盘点对象.N, 考核结果.周期名称="年度")', num(80)],
    ['Def(k, 盘点对象.N); PerformanceLastCent(k)', num(80)],
    ['PerformanceNthCent(盘点对象.N, 考核结果.周期名称="年度")', num(80)],
    ['PerformanceNthCent(考核结果.周期名称="年度", 盘点对象.N)', num(80)],
  ] as const)('盘点对象.N = 2：%s', (formula, expected) => {
    expect(run(formula, { '盘点对象.N': 2 })).toEqual(expected);
  });

  it('等级函数同口径', () => {
    const ports: InMemoryPortData = {
      performance: {
        'emp-1': [
          { fields: { 年度: 2026, 周期名称: '年度', 等级: 'A' }, modifiedAt: new Date('2026-01-01T00:00:00Z') },
          { fields: { 年度: 2024, 周期名称: '年度', 等级: 'B' }, modifiedAt: new Date('2025-01-01T00:00:00Z') },
        ],
      },
    };
    const fields = { '盘点对象.N': 2 };
    for (const formula of [
      'PerformanceLastGrade(盘点对象.N)',
      'PerformanceNthGrade(盘点对象.N, 考核结果.周期名称="年度")',
    ]) {
      expect(valueOf(evaluateFormula(formula, contextFor(fields, { ports }))), formula).toEqual(text('B'));
    }
  });

  it.each([
    'PerformanceLastCent(盘点对象.N)',
    'PerformanceLastGrade(盘点对象.N)',
    'PerformanceNthCent(盘点对象.N, 考核结果.周期名称="年度")',
    'PerformanceNthGrade(盘点对象.N, 考核结果.周期名称="年度")',
  ])('N 为空 → EMPTY_IN_ARITHMETIC（DEC-270①）：%s', (formula) => {
    expect(run(formula, { '盘点对象.N': null })).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
  });

  it.each([
    'PerformanceLastCent(盘点对象.N)',
    'PerformanceLastGrade(盘点对象.N)',
    'PerformanceNthCent(盘点对象.N, 考核结果.周期名称="年度")',
    'PerformanceNthGrade(盘点对象.N, 考核结果.周期名称="年度")',
  ])('N 字段无权读取 → FIELD_FORBIDDEN，不泄露取数结果：%s', (formula) => {
    const failure = run(formula, { '盘点对象.N': 2 }, ['盘点对象.N']);
    expect(failure).toMatchObject({ code: 'FIELD_FORBIDDEN' });
    expect(JSON.stringify(failure)).not.toContain('80');
  });

  it('考核结果字段仍按日期字段识别（不会被当成第二个 N）：行里没有该日期 → 不参与，结果为空', () => {
    expect(run('PerformanceNthCent(1, 考核结果.周期名称="年度", 考核结果.考核日期)', {})).toEqual({
      kind: 'empty',
      of: 'number',
    });
  });
});

// DEC-287②（第 3 轮清单补充）：改为每个强连通分量报一条代表环，同组的成环项目全部标出（C 不再被说成“依赖成环”）
describe('P3-1 同一强连通分量里的成环项目全部标出（DEC-274 / DEC-287②）', () => {
  it('A = B + C、B = A、C = A：代表环 A→B→A，成环项目 A、B、C', () => {
    const items = [
      { field: '盘点对象.A', priority: 1, formula: '盘点对象.B + 盘点对象.C' },
      { field: '盘点对象.B', priority: 1, formula: '盘点对象.A' },
      { field: '盘点对象.C', priority: 1, formula: '盘点对象.A' },
    ];
    const ordered = orderComputationItems(items);
    if (!ordered.ok) throw new Error('应允许保存');
    expect(ordered.cycles).toEqual([['盘点对象.A', '盘点对象.B', '盘点对象.A']]);
    expect(ordered.cycleMembers).toEqual(['盘点对象.A', '盘点对象.B', '盘点对象.C']);
    expect(ordered.warnings.join('\n')).not.toContain('盘点对象.C 依赖成环的项目');
    const batch = evaluateBatch(items, [inMemorySubject('e1', {})], { calendar: CALENDAR });
    expect(batch).toMatchObject({
      ok: false,
      failure: {
        message: '计算失败：循环依赖 盘点对象.A→盘点对象.B→盘点对象.A（同组成环项目还有 盘点对象.C）',
        members: ['盘点对象.A', '盘点对象.B', '盘点对象.C'],
      },
    });
  });
});

// 第 3 轮清单 P3：改为按输入值的十进制表示精确舍入，不再做 1 个 ULP 的修正（见 AC-EXP-f033-round3）
describe('P3-2 舍入按输入值精确舍入（不把 16 位有效数字压成 15 位）', () => {
  const run = (formula: string) => valueOf(evaluateFormula(formula, contextFor({})));

  it.each([
    ['RoundDown(2.999999999999999)', 2],
    ['Round(1234567890123456)', 1234567890123456],
    ['RoundUP(1234567890123456)', 1234567890123456],
    // 1.1 * 3 的输入值是 3.3000000000000003，精确向上舍入到 1 位为 3.4（第 3 轮起不再修正浮点尾差）
    ['RoundUP(1.1 * 3, 1)', 3.4],
    ['Round(2.345, 2)', 2.35],
    ['Round(1.005, 2)', 1.01],
    ['RoundDown(0.1 + 0.2, 1)', 0.3],
  ] as const)('%s = %s', (formula, expected) => {
    expect(run(formula)).toEqual(num(expected));
  });
});
