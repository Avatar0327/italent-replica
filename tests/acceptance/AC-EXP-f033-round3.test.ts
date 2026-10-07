/**
 * PR #108 第 3 轮（第 2 轮审查 GPT-6.1 Sol Ultra，修法按 DEC-287）回归：
 * P2-1 日期参数检查只认统一类型推导：确定不是日期 → 保存报错；不确定 → 保存提示（不阻断）；运行期非日期来源的空值
 *      不按 0001-01-01（DEC-270② 只针对真正的空日期）。
 * P2-2 第 N 年 / 第 N 次的参数角色只认推导类型：是否型 → 过滤条件，确定不是是否型 → N，不确定 → 位置规则并提示。
 * P2-3 循环依赖改用强连通分量（线性时间），每组一条代表环，成环项目全部标出；超过上限明确“已截断”。
 * P3   舍入按输入值的十进制表示精确舍入。
 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  orderComputationItems,
  validateFormula,
  type ComputationItem,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
  type StaticKind,
  type ValidationOptions,
} from '@italent/domain';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });

const errorsOf = (formula: string, options?: ValidationOptions) => {
  const validated = validateFormula(formula, options);
  return validated.ok ? [] : validated.errors.map((issue) => issue.code);
};
const warningsOf = (formula: string, options?: ValidationOptions) => {
  const validated = validateFormula(formula, options);
  if (!validated.ok) throw new Error(`应能保存：${formula}（${validated.errors[0]?.message}）`);
  return validated.warnings;
};
const catalog =
  (kinds: Readonly<Record<string, StaticKind>>) =>
  (path: string): StaticKind | undefined =>
    kinds[path];

const EMPTY_PERF = '获取指定年度指定周期的绩效得分(考核结果.年度=1999, 考核结果.周期名称="年度")';
const PERF_PORTS: InMemoryPortData = {
  performance: {
    'emp-1': [
      { fields: { 年度: 2026, 周期名称: '年度', 得分: 90, 等级: 'A' }, modifiedAt: new Date('2026-01-01T00:00:00Z') },
      { fields: { 年度: 2024, 周期名称: '年度', 得分: 80, 等级: 'B' }, modifiedAt: new Date('2025-01-01T00:00:00Z') },
      { fields: { 年度: 2023, 周期名称: '年度', 得分: 70, 等级: 'C' }, modifiedAt: new Date('2024-01-01T00:00:00Z') },
    ],
  },
};
const run = (
  formula: string,
  fields: Record<string, PlainValue> = {},
  extra: Partial<EvaluationContext> & { forbidden?: readonly string[] } = {},
) => {
  const { forbidden, ...rest } = extra;
  return valueOf(evaluateFormula(formula, { ...contextFor(fields, { ports: PERF_PORTS, forbidden }), ...rest }));
};

describe('P2-1 日期参数：确定不是日期 → 保存报错（含 IF 各分支都不是日期）', () => {
  it.each([
    'Year(IF(真, 1, "abc"))',
    `Def(n, IF(真, ${EMPTY_PERF}, "abc")); Year(AddDays(n, 1))`,
    'Year(如果 真 那么 1 否则 "abc")',
    'AddDays(IF(真, 1, IF(假, "a", 真)), 1)',
    'Def(n, IF(真, 1, "a")); Def(m, n); DateFormat(m, "yyyy")',
    'Year(Sum(1, 2))',
  ])('%s → ARGUMENT_TYPE', (formula) => {
    expect(errorsOf(formula)).toEqual(['ARGUMENT_TYPE']);
  });

  it(`Def(n, IF(真, 取数, "abc")); Year(AddDays(n, 1))：保存、单公式、批量都失败，不会算出 1`, () => {
    const formula = `Def(n, IF(真, ${EMPTY_PERF}, "abc")); Year(AddDays(n, 1))`;
    expect(run(formula)).toMatchObject({ code: 'ARGUMENT_TYPE' });
    const batch = evaluateBatch([{ field: '盘点对象.a', priority: 1, formula }], [inMemorySubject('emp-1', {})], {
      calendar: CALENDAR,
    });
    expect(batch).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE' } });
  });

  it('字段类型目录给出确定的非日期类型：保存报错；单公式求值带目录时同一结论', () => {
    const fieldKind = catalog({ '盘点对象.得分': 'number' });
    expect(errorsOf('Year(盘点对象.得分)', { fieldKind })).toEqual(['ARGUMENT_TYPE']);
    expect(run('Year(盘点对象.得分)', { '盘点对象.得分': null }, { fieldKind })).toMatchObject({
      code: 'ARGUMENT_TYPE',
    });
  });
});

describe('P2-1 日期参数：不确定 → 保存提示（不阻断），不静默放行', () => {
  it.each([
    'Year(IF(真, Today(), 员工信息.出生日期))',
    'Year(IF(真, Today(), 1))',
    'Year(员工信息.出生日期)',
    'Def(d, 员工信息.出生日期); AddDays(d, 1)',
    'Year(获取人事子集的指定字段数据(教育经历.毕业日期))',
  ])('%s → 能保存，带 TYPE_UNCERTAIN 提示', (formula) => {
    const warnings = warningsOf(formula);
    expect(warnings.map((warning) => warning.code)).toEqual(['TYPE_UNCERTAIN']);
    expect(warnings[0]?.message).toContain('类型不确定');
    expect(warnings[0]).toMatchObject({ line: 1, column: expect.any(Number) });
  });

  it('确定是日期：不报错、不提示', () => {
    expect(warningsOf('Year(IF(真, Today(), "2020/01/01"))')).toEqual([]);
    expect(warningsOf('Def(d, Today()); Year(AddDays(d, 1))')).toEqual([]);
    expect(warningsOf('Year(员工信息.入职日期)', { fieldKind: catalog({ '员工信息.入职日期': 'date' }) })).toEqual([]);
  });

  it('计算规则保存（orderComputationItems）同样给出提示、允许保存', () => {
    const ordered = orderComputationItems([{ field: '盘点对象.年', priority: 1, formula: 'Year(员工信息.出生日期)' }]);
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.warnings.join('\n')).toMatch(/盘点对象\.年.*类型不确定/);
  });
});

describe('P2-1 运行期：数值函数的空结果不当空日期（DEC-270② 只针对真正的空日期）', () => {
  it('数值取数函数取不到时的空值带来源类型', () => {
    expect(run(EMPTY_PERF)).toEqual({ kind: 'empty', of: 'number' });
  });

  it.each([
    `Year(IF(假, Today(), ${EMPTY_PERF}))`,
    `Def(n, IF(假, Today(), ${EMPTY_PERF})); Year(AddDays(n, 1))`,
    `Year(ToDate(${EMPTY_PERF}))`,
    `DateFormat(如果 假 那么 Today() 否则 ${EMPTY_PERF}, "yyyy")`,
  ])('%s → TYPE_CONVERSION（不是 1 / 0001）', (formula) => {
    expect(run(formula)).toMatchObject({ code: 'TYPE_CONVERSION', message: expect.stringContaining('空值') });
  });

  it('选中日期分支时照常计算', () => {
    expect(run(`Year(IF(真, Today(), ${EMPTY_PERF}))`)).toEqual(num(2026));
  });

  it('真正的空日期字段仍按 0001-01-01（DEC-270②）：有目录标为日期、或没有目录时', () => {
    const fields = { '员工信息.出生日期': null };
    const fieldKind = catalog({ '员工信息.出生日期': 'date' });
    expect(run('Year(AddDays(员工信息.出生日期, 1))', fields, { fieldKind })).toEqual(num(1));
    expect(run('Year(AddDays(员工信息.出生日期, 1))', fields)).toEqual(num(1));
    expect(run('Year(IF(假, Today(), 员工信息.出生日期))', fields, { fieldKind })).toEqual(num(1));
  });

  it('目录标为数值的空字段经 IF 进入日期参数：计算失败，不按 0001-01-01', () => {
    const fieldKind = catalog({ '盘点对象.得分': 'number' });
    expect(warningsOf('Year(IF(假, Today(), 盘点对象.得分))', { fieldKind })).toHaveLength(1);
    expect(run('Year(IF(假, Today(), 盘点对象.得分))', { '盘点对象.得分': null }, { fieldKind })).toMatchObject({
      code: 'TYPE_CONVERSION',
    });
  });
});

describe('P2-2 过滤条件与 N 只认推导类型：四个最近 N 函数', () => {
  const FUNCTIONS = [
    ['PerformanceLastCent', num(90), 'number'],
    ['PerformanceLastGrade', text('A'), 'text'],
    ['PerformanceNthCent', num(90), 'number'],
    ['PerformanceNthGrade', text('A'), 'text'],
  ] as const;
  const FILTERS = [
    ['是否型字段', (fn: string) => `${fn}(1, 考核结果.周期名称="年度", 盘点对象.是否参与)`],
    ['AND(...)', (fn: string) => `${fn}(1, 考核结果.周期名称="年度", AND(盘点对象.是否参与, 考核结果.年度 > 2000))`],
    ['返回是否的 IF', (fn: string) => `${fn}(1, 考核结果.周期名称="年度", IF(盘点对象.是否参与, 真, 假))`],
    ['是否型 Def 变量', (fn: string) => `Def(f, 盘点对象.是否参与 = 真); ${fn}(1, 考核结果.周期名称="年度", f)`],
  ] as const;
  const cases = FUNCTIONS.flatMap(([fn, hit, kind]) =>
    FILTERS.map(([label, build]) => [fn, label, build(fn), hit, kind] as const),
  );

  it.each(cases)('%s × %s：为真 → 取到，为假 → 空，无权 → FIELD_FORBIDDEN', (_fn, _label, formula, hit, kind) => {
    expect(run(formula, { '盘点对象.是否参与': true })).toEqual(hit);
    expect(run(formula, { '盘点对象.是否参与': false })).toEqual({ kind: 'empty', of: kind });
    const failure = run(formula, { '盘点对象.是否参与': true }, { forbidden: ['盘点对象.是否参与'] });
    expect(failure).toMatchObject({ code: 'FIELD_FORBIDDEN' });
    expect(JSON.stringify(failure)).not.toMatch(/90|"A"/);
  });

  it('审查原例 PerformanceLastCent(1, 盘点对象.是否参与)：真 → 90，假 → 空，无权 → FIELD_FORBIDDEN', () => {
    const formula = 'PerformanceLastCent(1, 盘点对象.是否参与)';
    expect(run(formula, { '盘点对象.是否参与': true })).toEqual(num(90));
    expect(run(formula, { '盘点对象.是否参与': false })).toEqual({ kind: 'empty', of: 'number' });
    expect(run(formula, { '盘点对象.是否参与': true }, { forbidden: ['盘点对象.是否参与'] })).toMatchObject({
      code: 'FIELD_FORBIDDEN',
    });
  });

  it('不确定类型的参数按位置规则并在保存时提示；有字段类型目录时不提示', () => {
    const formula = 'PerformanceLastCent(1, 盘点对象.是否参与)';
    const warnings = warningsOf(formula);
    expect(warnings.map((warning) => warning.code)).toEqual(['TYPE_UNCERTAIN']);
    expect(warnings[0]?.message).toContain('过滤条件');
    expect(warningsOf(formula, { fieldKind: catalog({ '盘点对象.是否参与': 'boolean' }) })).toEqual([]);
  });

  it('没有确定为数值的参数时，第一个不确定的参数按位置当作 N，其余当作过滤条件（各给提示）', () => {
    const formula = 'PerformanceLastCent(盘点对象.N, 盘点对象.是否参与)';
    expect(run(formula, { '盘点对象.N': 2, '盘点对象.是否参与': true })).toEqual(num(80));
    const messages = warningsOf(formula).map((warning) => warning.message);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('当作 N');
    expect(messages[1]).toContain('过滤条件');
  });

  it('位置规则判错时有类型目录即可纠正：目录标明是否型与数值后按类型区分', () => {
    const formula = 'PerformanceLastCent(盘点对象.是否参与, 盘点对象.N)';
    const fields = { '盘点对象.N': 2, '盘点对象.是否参与': true };
    expect(run(formula, fields)).toMatchObject({ code: 'TYPE_CONVERSION' });
    const fieldKind = catalog({ '盘点对象.是否参与': 'boolean', '盘点对象.N': 'number' });
    expect(run(formula, fields, { fieldKind })).toEqual(num(80));
    expect(warningsOf(formula, { fieldKind })).toEqual([]);
  });

  it('字段 / 变量 / 算式形式的 N 照常可用（第 1 轮修复保持）', () => {
    const fields = { '盘点对象.N': 2 };
    expect(run('PerformanceLastCent(盘点对象.N)', fields)).toEqual(num(80));
    expect(run('PerformanceLastCent(盘点对象.N + 0, 考核结果.周期名称="年度")', fields)).toEqual(num(80));
    expect(run('Def(k, 盘点对象.N); PerformanceNthGrade(k, 考核结果.周期名称="年度")', fields)).toEqual(text('B'));
  });

  it.each([
    ['两个确定为数值的参数', 'PerformanceNthCent(1, 2)'],
    ['没有能当作 N 的参数', 'PerformanceLastCent(考核结果.周期名称="年度")'],
    ['日期不能当作 N', 'PerformanceLastCent(Today())'],
  ])('%s：保存即报 ARGUMENT_TYPE', (_label, formula) => {
    expect(errorsOf(formula)).toEqual(['ARGUMENT_TYPE']);
  });
});

/** 审查给的构造：A 引用 B；B 引用 A 和全部 C；每个 C 引用 B 和其他 C。 */
function denseRule(cCount: number): ComputationItem[] {
  const cs = Array.from({ length: cCount }, (_, i) => `盘点对象.C${i + 1}`);
  const item = (field: string, refs: readonly string[]) => ({ field, priority: 1, formula: refs.join(' + ') });
  return [
    item('盘点对象.A', ['盘点对象.B']),
    item('盘点对象.B', ['盘点对象.A', ...cs]),
    ...cs.map((c) => item(c, ['盘点对象.B', ...cs.filter((other) => other !== c)])),
  ];
}

function timed<T>(work: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = work();
  return { result, ms: performance.now() - start };
}

describe('P2-3 循环依赖：强连通分量（线性时间），每组一条代表环，成环项目全部标出', () => {
  it.each([10, 11])('A / B / %i 个 C 的稠密构造：排序与批量求值都在 200 ms 内完成', (cCount) => {
    const items = denseRule(cCount);
    const ordered = timed(() => orderComputationItems(items));
    expect(ordered.ms).toBeLessThan(200);
    if (!ordered.result.ok) throw new Error('应允许保存');
    expect(ordered.result.cycles).toEqual([['盘点对象.A', '盘点对象.B', '盘点对象.A']]);
    expect(ordered.result.cycleMembers).toEqual(items.map((entry) => entry.field));
    expect(ordered.result.cyclesTruncated).toBe(false);
    const batch = timed(() => evaluateBatch(items, [inMemorySubject('e1', {})], { calendar: CALENDAR }));
    expect(batch.ms).toBeLessThan(200);
    expect(batch.result).toMatchObject({ ok: false, failure: { code: 'CYCLIC_DEPENDENCY' } });
    if (!batch.result.ok && batch.result.failure.code === 'CYCLIC_DEPENDENCY') {
      expect(batch.result.failure.members).toHaveLength(items.length);
    }
  });

  it('200 个计算项目、8 组循环（每组 20 项）加 40 个无环或受牵连项目：1 秒内完成，8 组各报一条代表环', () => {
    const items: ComputationItem[] = [];
    const cyclic: string[] = [];
    for (let group = 0; group < 8; group++) {
      const field = (i: number) => `盘点对象.G${group}_${i % 20}`;
      for (let i = 0; i < 20; i++) {
        items.push({ field: field(i), priority: 1, formula: [field(i + 1), field(i + 7), field(i + 13)].join(' + ') });
        cyclic.push(field(i));
      }
    }
    for (let i = 0; i < 40; i++) {
      const refs = i === 0 ? ['1'] : [`盘点对象.F${i - 1}`, ...(i % 10 === 0 ? [`盘点对象.G${i / 10}_0`] : [])];
      items.push({ field: `盘点对象.F${i}`, priority: 2, formula: refs.join(' + ') });
    }
    expect(items).toHaveLength(200);
    const ordered = timed(() => orderComputationItems(items));
    const batch = timed(() => evaluateBatch(items, [inMemorySubject('e1', {})], { calendar: CALENDAR }));
    expect(ordered.ms + batch.ms).toBeLessThan(1000);
    if (!ordered.result.ok) throw new Error('应允许保存');
    expect(ordered.result.cycles).toHaveLength(8);
    expect(ordered.result.cycleMembers).toEqual(cyclic);
    expect(ordered.result.blocked).toContain('盘点对象.F39');
    expect(ordered.result.blocked).not.toContain('盘点对象.F0');
    expect(batch.result).toMatchObject({ ok: false, failure: { code: 'CYCLIC_DEPENDENCY' } });
  });

  it('200 个计算项目组成一个稠密循环（每项引用 10 个其他项）：1 秒内完成', () => {
    const field = (i: number) => `盘点对象.D${i % 200}`;
    const items = Array.from({ length: 200 }, (_, i) => ({
      field: field(i),
      priority: 1,
      formula: Array.from({ length: 10 }, (__, k) => field(i + 1 + k * 19)).join(' + '),
    }));
    const ordered = timed(() => orderComputationItems(items));
    expect(ordered.ms).toBeLessThan(1000);
    if (!ordered.result.ok) throw new Error('应允许保存');
    expect(ordered.result.cycles).toHaveLength(1);
    expect(ordered.result.cycleMembers).toHaveLength(200);
  });
});

describe('P3 环提示上限：准确标出全部成环项目，并明确“已截断”', () => {
  const selfLoops = Array.from({ length: 21 }, (_, i) => ({
    field: `盘点对象.X${i + 1}`,
    priority: 1,
    formula: `盘点对象.X${i + 1} + 1`,
  }));
  const items = [...selfLoops, { field: '盘点对象.Y', priority: 1, formula: '盘点对象.X21 + 1' }];

  it('21 组独立自环：列出 20 组并说明已截断；第 21 个也标为成环项目，不说成“依赖成环”', () => {
    const ordered = orderComputationItems(items);
    if (!ordered.ok) throw new Error('应允许保存');
    expect(ordered.cycles).toHaveLength(20);
    expect(ordered.cyclesTruncated).toBe(true);
    expect(ordered.cycleMembers).toEqual(selfLoops.map((entry) => entry.field));
    const warnings = ordered.warnings.join('\n');
    expect(warnings).toContain('已截断');
    expect(warnings).toContain('盘点对象.X21');
    expect(warnings).not.toContain('盘点对象.X21 依赖成环的项目');
    expect(warnings).toContain('盘点对象.Y 依赖成环的项目');
  });

  it('批量计算的失败信息说明已截断与成环项目总数', () => {
    const batch = evaluateBatch(items, [inMemorySubject('e1', {})], { calendar: CALENDAR });
    if (batch.ok || batch.failure.code !== 'CYCLIC_DEPENDENCY') throw new Error('应整批失败');
    expect(batch.failure.truncated).toBe(true);
    expect(batch.failure.members).toHaveLength(21);
    expect(batch.failure.message).toContain('已截断');
    expect(batch.failure.message).toContain('21 个成环项目');
  });
});

describe('P3 舍入按输入值的十进制表示精确舍入', () => {
  it.each([
    ['RoundDown(0.9999999999999999)', 0],
    ['RoundUP(1.0000000000000002)', 2],
    ['RoundDown(2.999999999999999)', 2],
    ['Round(1234567890123456)', 1234567890123456],
    ['RoundUP(1.1 * 3, 1)', 3.4],
    ['RoundDown(0.1 + 0.2, 1)', 0.3],
    ['Round(2.345, 2)', 2.35],
    ['Round(1.005, 2)', 1.01],
    ['Round(-2.5)', -3],
    ['Round(1234.5, -2)', 1200],
    ['RoundUP(1201, -2)', 1300],
    ['RoundDown(-1299, -2)', -1200],
    ['RoundUP(0.000001, 3)', 0.001],
    ['Round(1e21, 2)', 1e21],
  ] as const)('%s = %s', (formula, expected) => {
    expect(run(formula)).toEqual(num(expected));
  });

  it('小数位数超出 -300～300 时计算失败', () => {
    expect(run('Round(1, 400)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
    expect(run('RoundUP(5, -400)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});
