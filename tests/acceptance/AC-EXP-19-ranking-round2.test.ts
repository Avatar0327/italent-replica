/**
 * AC-EXP-19 第 2 轮（F-045，PR #114 Sol Ultra 第 1 轮审查 R1 / R2）：
 * R1 旧参数位置语义不变（R3-T04 设计 v3 §4.8、#113 N01）：第 3 参数始终是过滤条件（含裸是否型字段、短字段名、
 * 是否型 Def 变量），第 4 参数始终是分组（比较 / 逻辑表达式、常量、返回文本的 IF、ToText 都按取值分组）；
 * 新第 5 参数按统一类型推导区分：是否型 = 过滤，其余 = 分组，推导不确定时按实际值（假 = 不满足，其余按值分组）。
 * 保存检查与运行期共用同一套推导（DEC-287）；类型不确定给提示。
 * R2 排名表在一次计算里只建一次：参数里出现裸词（裸排序字段、模式 Def、常量或本人 Def 条件、分组裸词）也不逐人重建；
 * 分组按哈希索引查找。2 000 × 10 ≤ 5 秒（R3-T04 设计 v3 §4.5(f)）。
 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  parseFormula,
  validateFormula,
  type ComputationItem,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryRankingMember,
  type PlainValue,
  type StaticKind,
  type SubjectReader,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, PROJECT, contextFor } from './AC-EXP-support.js';

/** 失败只比较原因码（文案与位置不在兼容范围内）。 */
const valueOf = (result: EvaluationResult) => (result.ok ? result.value : { code: result.failure.code });
const num = (value: number) => ({ kind: 'number', value });
const OUT = { code: 'OUT_OF_SCOPE' };

const KINDS: Record<string, StaticKind> = {
  'person.score': 'number',
  'person.include': 'boolean',
  include: 'boolean',
  'person.group': 'text',
};
const fieldKind = (path: string) => KINDS[path];

/** 审查最小数据：A=score 10、include 真；B=score 9、include 假（类型目录声明 include 为是否型）。 */
const A: InMemoryRankingMember = {
  id: 'A',
  fields: { 'person.score': 10, 'person.include': true, include: true, 'person.group': 'g1' },
};
const B: InMemoryRankingMember = {
  id: 'B',
  fields: { 'person.score': 9, 'person.include': false, include: false, 'person.group': 'g1' },
};
/** C：include 为空，分数最高。 */
const C: InMemoryRankingMember = {
  id: 'C',
  fields: { 'person.score': 11, 'person.include': null, include: null, 'person.group': 'g1' },
};

function contextOf(members: readonly InMemoryRankingMember[], id: string, typed: boolean): EvaluationContext {
  const self = members.find((m) => m.id === id)!;
  const base = contextFor({ ...self.fields }, { ports: { ranking: members }, subjectId: id });
  return typed ? { ...base, fieldKind } : base;
}

/** 文本公式与先解析出的 Program 两条入口，带 / 不带类型目录，结果都须相同。 */
function ranksOf(formula: string, members: readonly InMemoryRankingMember[] = [A, B]) {
  const parsed = parseFormula(formula);
  if (!parsed.ok) throw new Error(`解析失败：${formula}`);
  const results = [true, false].flatMap((typed) =>
    [formula, parsed.program].map((source) =>
      members.map((m) => valueOf(evaluateFormula(source, contextOf(members, m.id, typed)))),
    ),
  );
  for (const other of results.slice(1)) expect(other).toEqual(results[0]);
  return results[0];
}

const errorsOf = (formula: string) => {
  const validated = validateFormula(formula, { fieldKind });
  return validated.ok ? [] : validated.errors.map((issue) => issue.code);
};
const warningsOf = (formula: string) => {
  const validated = validateFormula(formula, { fieldKind });
  return validated.ok ? validated.warnings.map((warning) => warning.code) : ['NOT_OK'];
};

describe('R1 审查表格三条公式：结果与旧实现一致', () => {
  it('第 3 参数裸是否型字段 = 过滤：[1, OUT_OF_SCOPE]', () => {
    expect(ranksOf('Ranking("排序号", person.score, person.include)')).toEqual([num(1), OUT]);
  });

  it('第 4 参数比较表达式 = 按结果分组：[1, 1]', () => {
    expect(ranksOf('Ranking("排序号", person.score, true, person.include = true)')).toEqual([num(1), num(1)]);
  });

  it('第 4 参数 NOT(…) = 按结果分组：[1, 1]', () => {
    expect(ranksOf('Ranking("排序号", person.score, true, NOT(person.include))')).toEqual([num(1), num(1)]);
  });
});

describe('R1 第 3 参数：是否型的各种写法一律过滤，假或空的成员不参与', () => {
  it.each([
    ['完整字段', 'Ranking("排序号", person.score, person.include)'],
    ['短字段名', 'Ranking("排序号", person.score, include)'],
    ['叠加第 4 参数分组', 'Ranking("排序号", person.score, person.include, person.group)'],
    ['短字段名叠加分组', 'Ranking("排序号", person.score, include, person.group)'],
  ])('%s', (_label, formula) => {
    // C 分数最高但 include 为空：不参与，A 仍是第 1
    expect(ranksOf(formula, [A, B, C])).toEqual([num(1), OUT, OUT]);
    expect(errorsOf(formula)).toEqual([]);
  });

  it('是否型 Def 变量（按本人作用域取值）：本人为真时全体参与，本人为假时 OUT_OF_SCOPE', () => {
    const formula = 'Def(x, person.include); Ranking("排序号", person.score, x)';
    expect(ranksOf(formula)).toEqual([num(1), OUT]);
    expect(errorsOf(formula)).toEqual([]);
    expect(warningsOf(formula)).toEqual([]);
  });

  it('确定不是是否型（如 1 + 2、文本字段）：保存报错；旧 Program 直接求值仍是人人 OUT_OF_SCOPE', () => {
    expect(errorsOf('Ranking("排序号", person.score, 1 + 2)')).toEqual(['ARGUMENT_TYPE']);
    expect(errorsOf('Ranking("排序号", person.score, person.group)')).toEqual(['ARGUMENT_TYPE']);
    // 带类型目录时公式文本求值先过保存检查（报 ARGUMENT_TYPE）；已保存的旧 Program 直接求值保持旧结果
    const parsed = parseFormula('Ranking("排序号", person.score, person.group)');
    if (!parsed.ok) throw new Error('解析失败');
    for (const typed of [true, false]) {
      const results = [A, B].map((m) => valueOf(evaluateFormula(parsed.program, contextOf([A, B], m.id, typed))));
      expect(results).toEqual([OUT, OUT]);
    }
    const typedText = valueOf(
      evaluateFormula('Ranking("排序号", person.score, person.group)', contextOf([A, B], 'A', true)),
    );
    expect(typedText).toEqual({ code: 'ARGUMENT_TYPE' });
  });
});

describe('R1 第 4 参数：任何写法都按取值分组，保存不报 ARGUMENT_TYPE，求值不变成 OUT_OF_SCOPE', () => {
  it.each([
    ['比较表达式', 'person.include = true', [num(1), num(1)]],
    ['逻辑表达式', 'person.include 且 true', [num(1), num(1)]],
    ['NOT', 'NOT(person.include)', [num(1), num(1)]],
    ['常量 false（全员同组，不是全员退出）', 'false', [num(1), num(2)]],
    ['数值常量', '1', [num(1), num(2)]],
    ['文本常量', '"甲"', [num(1), num(2)]],
    ['返回文本的 IF', '如果 person.include 那么 "甲" 否则 "乙"', [num(1), num(1)]],
    ['ToText(分组字段)', 'ToText(person.group)', [num(1), num(2)]],
    ['文本字段', 'person.group', [num(1), num(2)]],
  ])('%s', (_label, group, expected) => {
    const formula = `Ranking("排序号", person.score, true, ${group})`;
    expect(ranksOf(formula)).toEqual(expected);
    expect(errorsOf(formula)).toEqual([]);
  });
});

describe('R1 新第 5 参数：按统一类型推导区分过滤 / 分组', () => {
  it('裸是否型字段 = 过滤（带不带类型目录结果相同）', () => {
    const formula = 'Ranking("排序号", person.score, true, person.group, person.include)';
    expect(ranksOf(formula, [A, B, C])).toEqual([num(1), OUT, OUT]);
    expect(errorsOf(formula)).toEqual([]);
  });

  it('比较表达式 = 过滤', () => {
    expect(ranksOf('Ranking("排序号", person.score, true, person.group, person.include = true)')).toEqual([
      num(1),
      OUT,
    ]);
  });

  it('文本字段 = 分组（与本人同值）', () => {
    const D: InMemoryRankingMember = { id: 'D', fields: { ...B.fields, 'person.score': 50, 'person.group': 'g2' } };
    expect(ranksOf('Ranking("排序号", person.score, true, 1, person.group)', [A, B, D])).toEqual([
      num(1),
      num(2),
      num(1),
    ]);
  });

  it('确定不是是否型、又不是字段引用的常量：保存报错', () => {
    expect(errorsOf('Ranking("排序号", person.score, true, person.group, "方案一")')).toEqual(['ARGUMENT_TYPE']);
  });
});

describe('R1 类型不确定：第 3 / 4 / 5 参数保存时提示（DEC-287 补充）', () => {
  it.each([
    ['第 3 参数为目录里查不到的裸字段', 'Ranking("排序号", person.score, person.unknown)'],
    ['第 4 参数为目录里查不到的裸字段', 'Ranking("排序号", person.score, true, person.unknown)'],
    ['第 5 参数为目录里查不到的裸字段', 'Ranking("排序号", person.score, true, 1, person.unknown)'],
    ['第 3 参数为混合类型 Def', 'Def(m, 如果 person.score > 1 那么 "a" 否则 true); Ranking("排序号", person.score, m)'],
    [
      '第 4 参数为混合类型 Def',
      'Def(m, 如果 person.score > 1 那么 "a" 否则 1); Ranking("排序号", person.score, true, m)',
    ],
    [
      '第 5 参数为混合类型 Def',
      'Def(m, 如果 person.score > 1 那么 "a" 否则 1); Ranking("排序号", person.score, true, 1, m)',
    ],
  ])('%s', (_label, formula) => {
    expect(warningsOf(formula)).toContain('TYPE_UNCERTAIN');
  });

  it('确定类型的写法没有提示', () => {
    expect(warningsOf('Ranking("排序号", person.score, person.include, person.group, person.include)')).toEqual([]);
  });

  it('第 5 参数推导不确定时按实际值：假 = 不满足，其余按值分组', () => {
    const E: InMemoryRankingMember = { id: 'E', fields: { 'person.score': 5, 'person.unknown': 'x' } };
    const F: InMemoryRankingMember = { id: 'F', fields: { 'person.score': 6, 'person.unknown': 'y' } };
    const G: InMemoryRankingMember = { id: 'G', fields: { 'person.score': 7, 'person.unknown': false } };
    const formula = 'Ranking("排序号", person.score, true, 1, person.unknown)';
    expect(ranksOf(formula, [E, F, G])).toEqual([num(1), num(1), OUT]);
  });
});

describe('R2 排名表在一次计算里只建一次（含裸词的合法写法）；分组按哈希索引', () => {
  const N = 2000;
  const ITEMS = 10;
  const SCORE = '盘点对象.综合得分';
  const PLAN = '盘点对象.盘点方案';

  function population(extra: (i: number) => Record<string, PlainValue> = () => ({})) {
    let reads = 0;
    const subjects: SubjectReader[] = Array.from({ length: N }, (_, i) => {
      const fields = { [SCORE]: (i * 7919) % 1009, 综合得分: (i * 7919) % 1009, [PLAN]: `方案${i % 7}`, ...extra(i) };
      const subject = inMemorySubject(`m${i}`, fields);
      return {
        id: subject.id,
        resolveField(path) {
          if (path === SCORE || path === '综合得分') reads += 1;
          return subject.resolveField(path);
        },
      };
    });
    return { subjects, reads: () => reads };
  }

  const items = (formula: string): ComputationItem[] =>
    Array.from({ length: ITEMS }, (_, k) => ({ field: `盘点对象.名次${k}`, priority: 1, formula }));

  /** 2 000 × 10：≤ 5 秒；排序字段读取次数线性（每个项目 ≤ 3 × N 次，平方级是每个项目 N² 次）。 */
  function runLoad(formula: string, extra?: (i: number) => Record<string, PlainValue>) {
    const { subjects, reads } = population(extra);
    const started = performance.now();
    const batch = evaluateBatch(items(formula), subjects, { calendar: CALENDAR, project: PROJECT });
    const elapsed = performance.now() - started;
    expect(batch.ok).toBe(true);
    if (!batch.ok) throw new Error('批量求值失败');
    expect(reads()).toBeLessThanOrEqual(3 * N * ITEMS);
    expect(elapsed).toBeLessThan(5000);
    return batch.results;
  }

  it('裸排序字段（综合得分）', () => {
    const results = runLoad('Ranking("排序号", 综合得分)');
    expect(Object.values(results).filter((r) => r['盘点对象.名次0']!.ok)).toHaveLength(N);
  });

  it('模式写成 Def 变量', () => {
    runLoad(`Def(模式, "排序号"); Ranking(模式, ${SCORE})`);
  });

  it('常量 Def 作为范围条件', () => {
    const results = runLoad(`Def(方案, "方案1"); Ranking("排序号", ${SCORE}, ${PLAN} = 方案)`);
    expect(results.m1!['盘点对象.名次0']).toMatchObject({ ok: true, value: { kind: 'number' } });
    expect(valueOf(results.m0!['盘点对象.名次0']!)).toMatchObject(OUT);
  });

  it('本人 Def 条件（按本人取值，排名表按取值各建一张）', () => {
    const formula = `Def(本人方案, ${PLAN}); Ranking("排序号", ${SCORE}, ${PLAN} = 本人方案)`;
    const results = runLoad(formula);
    // 与写成第 4 参数分组的结果一致
    const grouped = evaluateBatch(items(`Ranking("排序号", ${SCORE}, true, ${PLAN})`), population().subjects, {
      calendar: CALENDAR,
    });
    if (!grouped.ok) throw new Error('批量求值失败');
    for (const id of ['m0', 'm1', 'm77', 'm1999']) {
      expect(valueOf(results[id]!['盘点对象.名次3']!)).toEqual(valueOf(grouped.results[id]!['盘点对象.名次3']!));
    }
  });

  it('分组裸词（短字段名）', () => {
    runLoad('Ranking("排序号", 综合得分, true, 方案)', (i) => ({ 方案: `方案${i % 7}` }));
  });

  it('高基数分组：每人一组（第 4、5 参数各 2 000 个取值）', () => {
    const results = runLoad(`Ranking("百分位", ${SCORE}, true, 盘点对象.工号, 盘点对象.工号2)`, (i) => ({
      '盘点对象.工号': `E${i}`,
      '盘点对象.工号2': i,
    }));
    expect(valueOf(results.m5!['盘点对象.名次9']!)).toEqual(num(100));
  });
});
