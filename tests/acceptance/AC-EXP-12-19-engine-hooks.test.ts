/**
 * F-049（DEC-309③ / 312 / 314）：AC-EXP-12 输出适配入依赖链，AC-EXP-19 全体排名与旧调用兼容。
 * 目标字段目录与转换由 R3-T04 注入；此处回调用合成目标值检验引擎钩子的调用时点与传播。
 */
import {
  createInMemoryPorts,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  parseDateText,
  validateFormula,
  type BatchEvaluationHooks,
  type ComputationItem,
  type EvaluationResult,
  type ExprValue,
  type SubjectReader,
} from '@italent/domain';
import { describe, expect, it, vi } from 'vitest';
import { CALENDAR } from './AC-EXP-support.js';

const context = { calendar: CALENDAR };
const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });
const success = (value: ExprValue): EvaluationResult => ({ ok: true, value });
const source = '盘点对象.分数';
const rank = item('盘点对象.名次', 2, `Ranking("排序号", ${source})`);
const percentile = item('盘点对象.百分位', 2, `Ranking("百分位", ${source})`);
const subject = (id: string, score: number | null) => inMemorySubject(id, { [source]: score });

function resultOf(batch: ReturnType<typeof evaluateBatch>, id: string, field: string): EvaluationResult | undefined {
  expect(batch.ok).toBe(true);
  return batch.ok ? batch.results[id]?.[field] : undefined;
}

const identity: NonNullable<BatchEvaluationHooks['adapt']> = (_item, _id, value) => success(value);

describe('AC-EXP-12 F-049 adapt 在结果进入 computed 前调用', () => {
  it.each([
    ['数值精度', '2.345', { kind: 'number', value: 2.35 }, '盘点对象.a + 1', { kind: 'number', value: 3.35 }],
    [
      '单选值映射',
      '3',
      { kind: 'option', value: '3', label: '高' },
      '盘点对象.a = "3"',
      { kind: 'boolean', value: true },
    ],
    [
      '日期到日',
      '"2026-10-08"',
      { kind: 'date', value: parseDateText('2026-10-08')! },
      'Year(盘点对象.a)',
      { kind: 'number', value: 2026 },
    ],
    ['文本格式化', '42', { kind: 'text', value: '42' }, '盘点对象.a = "42"', { kind: 'boolean', value: true }],
  ] as const)('%s：下游读取适配后的值', (_label, formula, adapted, downstream, expected) => {
    const items = [item('盘点对象.a', 1, formula), item('盘点对象.b', 2, downstream)];
    const adapt = vi.fn<NonNullable<BatchEvaluationHooks['adapt']>>((entry, _id, value) =>
      success(entry.field === '盘点对象.a' ? adapted : value),
    );
    const batch = evaluateBatch(items, [inMemorySubject('s1', {})], context, { adapt });
    expect(resultOf(batch, 's1', '盘点对象.a')).toEqual(success(adapted));
    expect(resultOf(batch, 's1', '盘点对象.b')).toEqual(success(expected));
    expect(adapt).toHaveBeenNthCalledWith(1, items[0], 's1', expect.objectContaining({ kind: expect.any(String) }));
    expect(adapt).toHaveBeenCalledTimes(2);
  });

  it('数值适配后的同分参与排名，原始值不进入排名表', () => {
    const people = [
      inMemorySubject('s1', { '盘点对象.原始值': 2.345 }),
      inMemorySubject('s2', { '盘点对象.原始值': 2.346 }),
    ];
    const adapt: BatchEvaluationHooks['adapt'] = (entry, _id, value) =>
      success(entry.field === source ? { kind: 'number', value: 2.35 } : value);
    const batch = evaluateBatch([item(source, 1, '盘点对象.原始值'), rank, percentile], people, context, { adapt });
    for (const id of ['s1', 's2']) {
      expect(resultOf(batch, id, rank.field)).toEqual(success({ kind: 'number', value: 1 }));
      expect(resultOf(batch, id, percentile.field)).toEqual(success({ kind: 'number', value: 50 }));
    }
  });

  it.each(['OUTPUT_TYPE_MISMATCH', 'OUTPUT_OPTION_INVALID', 'OUTPUT_OVERFLOW'] as const)(
    '%s 结构化失败原样返回，下游失败且该对象不进入排名总体',
    (code) => {
      const items = [
        item(source, 1, '盘点对象.原始值'),
        item('盘点对象.b', 2, `ToNumber(${source}) + 1`),
        rank,
        percentile,
      ];
      const people = [
        inMemorySubject('bad', { '盘点对象.原始值': 'abc' }),
        inMemorySubject('good', { '盘点对象.原始值': 8 }),
      ];
      const failure: EvaluationResult = { ok: false, failure: { code, message: '计算失败：目标字段适配失败' } };
      const adapt = vi.fn<NonNullable<BatchEvaluationHooks['adapt']>>((entry, id, value) =>
        entry.field === source && id === 'bad' ? failure : success(value),
      );
      const batch = evaluateBatch(items, people, context, {
        adapt,
        population: [subject('bad', 100), subject('other', 4)],
      });
      expect(resultOf(batch, 'bad', source)).toEqual(failure);
      for (const field of ['盘点对象.b', rank.field, percentile.field]) {
        expect(resultOf(batch, 'bad', field)).toMatchObject({ ok: false, failure: { code: 'DEPENDENCY_FAILED' } });
      }
      expect(resultOf(batch, 'good', percentile.field)).toEqual(success({ kind: 'number', value: 50 }));
      expect(adapt.mock.calls.filter(([, id]) => id === 'bad')).toHaveLength(1);
    },
  );

  it('适配的带类型空值也进入依赖链；空串转换为空由适配器提供', () => {
    const items = [item('盘点对象.a', 1, '""'), item('盘点对象.b', 2, 'Year(盘点对象.a)')];
    const batch = evaluateBatch(items, [inMemorySubject('s1', {})], context, {
      adapt: (entry, _id, value) => success(entry.field === '盘点对象.a' ? { kind: 'empty', of: 'date' } : value),
    });
    expect(resultOf(batch, 's1', '盘点对象.a')).toEqual(success({ kind: 'empty', of: 'date' }));
    expect(resultOf(batch, 's1', '盘点对象.b')).toEqual(success({ kind: 'number', value: 1 }));
  });

  it('公式失败不调适配器；适配器抛错转为不泄露异常内容的结构化失败', () => {
    const adapt = vi.fn<NonNullable<BatchEvaluationHooks['adapt']>>(() => {
      throw new Error('private adapter details');
    });
    const batch = evaluateBatch(
      [item('盘点对象.a', 1, '1 / 0'), item('盘点对象.b', 1, '7'), item('盘点对象.c', 2, '盘点对象.b + 1')],
      [inMemorySubject('s1', {})],
      context,
      { adapt },
    );
    expect(resultOf(batch, 's1', '盘点对象.a')).toMatchObject({ ok: false, failure: { code: 'DIVISION_BY_ZERO' } });
    expect(resultOf(batch, 's1', '盘点对象.b')).toEqual({
      ok: false,
      failure: { code: 'INTERNAL_ERROR', message: '计算失败：内部错误' },
    });
    expect(resultOf(batch, 's1', '盘点对象.c')).toMatchObject({ ok: false, failure: { code: 'DEPENDENCY_FAILED' } });
    expect(adapt).toHaveBeenCalledTimes(1);
  });
});

describe('AC-EXP-19 F-049 population 与 DEC-312 部分重算', () => {
  it('短字段引用也让额外总体成员读到完整目标字段的旧值', () => {
    const shortRank = item(rank.field, 2, 'Ranking("排序号", 分数)');
    const batch = evaluateBatch([item(source, 1, '0.1'), shortRank], [subject('s1', 1)], context, {
      population: [subject('s2', 1), subject('s3', 1)],
    });
    expect(resultOf(batch, 's1', rank.field)).toEqual(success({ kind: 'number', value: 3 }));
  });

  it.each([0.1, -1])('参与对象新源值 %s，其他对象旧值；只返回参与对象的结果', (newScore) => {
    const selected = [subject('s1', 1)];
    const population = [subject('s1', 100), subject('s2', 1), subject('s3', 1), subject('empty', null)];
    const batch = evaluateBatch([rank, percentile, item(source, 1, String(newScore))], selected, context, {
      population,
    });
    expect(resultOf(batch, 's1', source)).toEqual(success({ kind: 'number', value: newScore }));
    expect(resultOf(batch, 's1', rank.field)).toEqual(success({ kind: 'number', value: 3 }));
    expect(resultOf(batch, 's1', percentile.field)).toEqual(success({ kind: 'number', value: 100 }));
    if (batch.ok) expect(Object.keys(batch.results)).toEqual(['s1']);
    expect(population[1]!.resolveField(source)).toEqual({ status: 'found', value: 1 });
    expect(selected[0]!.resolveField(source)).toEqual({ status: 'found', value: 1 });
  });

  it('按 id 去重，subjects 读值优先，外部成员只计一次', () => {
    const batch = evaluateBatch([percentile], [subject('s1', 20)], context, {
      population: [subject('s1', 0), subject('s2', 10), subject('s2', 10)],
    });
    expect(resultOf(batch, 's1', percentile.field)).toEqual(success({ kind: 'number', value: 50 }));
  });

  it('排名范围由公式过滤 / 分组决定，不受本次参与对象限制', () => {
    const fields = (id: string, score: number, included: boolean, group: string) =>
      inMemorySubject(id, { [source]: score, '盘点对象.参与': included, '盘点对象.组': group });
    const formula = `Ranking("百分位", ${source}, 盘点对象.参与, 盘点对象.组)`;
    const batch = evaluateBatch([item('盘点对象.百分位', 2, formula)], [fields('s1', 20, true, 'A')], context, {
      population: [fields('s2', 10, true, 'A'), fields('s3', 30, false, 'A'), fields('s4', 40, true, 'B')],
    });
    expect(resultOf(batch, 's1', percentile.field)).toEqual(success({ kind: 'number', value: 50 }));
  });

  it('显式 RankingPort 优先且不叠加新值；population 被忽略，端口每项目只读一次', () => {
    const read = vi.fn(() => ({ ok: true as const, data: [subject('s1', 10), subject('s2', 20)] }));
    const unused = {
      id: 'unused',
      resolveField: () => {
        throw new Error('must not read');
      },
    };
    const batch = evaluateBatch(
      [item(source, 1, '100'), percentile],
      [subject('s1', 0), subject('s2', 0)],
      {
        ...context,
        ports: { ranking: { population: read } },
      },
      { population: [unused] },
    );
    expect(resultOf(batch, 's1', percentile.field)).toEqual(success({ kind: 'number', value: 100 }));
    expect(resultOf(batch, 's2', percentile.field)).toEqual(success({ kind: 'number', value: 50 }));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('每个项目在总体只建一次排名表；不同 batch 的缓存不复用', () => {
    const read = vi.fn((path: string) => ({ status: 'found' as const, value: path === source ? 10 : null }));
    const extra: SubjectReader = { id: 'extra', resolveField: read };
    const people = [subject('s1', 30), subject('s2', 20)];
    const items = [rank];
    const first = evaluateBatch(items, people, context, { population: [extra] });
    expect(read).toHaveBeenCalledTimes(1);
    expect(resultOf(first, 's2', rank.field)).toEqual(success({ kind: 'number', value: 2 }));
    read.mockImplementation(() => ({ status: 'found', value: 40 }));
    const second = evaluateBatch(items, people, context, { population: [extra] });
    expect(read).toHaveBeenCalledTimes(2);
    expect(resultOf(second, 's2', rank.field)).toEqual(success({ kind: 'number', value: 3 }));
  });

  it.each([
    `Ranking("排序号", ${source})`,
    `Ranking("百分位", ${source}, 盘点对象.参与)`,
    `Ranking("排序号", ${source}, 盘点对象.参与, 盘点对象.组)`,
    `Ranking("百分位", ${source}, 盘点对象.参与, 盘点对象.组, 盘点对象.参与)`,
  ])('旧公式 %s：不传 / 空钩子 / identity 钩子 / 同总体钩子结果逐字一致', (formula) => {
    const people = [10, 10, 5].map((score, i) =>
      inMemorySubject(`s${i}`, { [source]: score, '盘点对象.参与': true, '盘点对象.组': 'A' }),
    );
    const items = [item('盘点对象.result', 1, formula)];
    const old = evaluateBatch(items, people, context);
    expect(evaluateBatch(items, people, context, {})).toEqual(old);
    expect(evaluateBatch(items, people, context, { adapt: identity, population: people })).toEqual(old);
    const withPort = {
      ...context,
      ports: createInMemoryPorts({
        ranking: [10, 10, 5].map((score, i) => ({
          id: `s${i}`,
          fields: { [source]: score, '盘点对象.参与': true, '盘点对象.组': 'A' },
        })),
      }),
    };
    expect(evaluateBatch(items, people, withPort, { adapt: identity, population: [subject('ignored', 100)] })).toEqual(
      evaluateBatch(items, people, withPort),
    );
  });
});

describe('DEC-314② 多选字段取证前禁止参与公式（🟡）', () => {
  const field = '盘点对象.标签';
  const fieldKind = (path: string) => (path === field ? ('multi_option' as const) : undefined);
  it('保存、单公式、批量入口都拒绝引用，含未执行分支', () => {
    const formula = `IF(false, ${field}, 1)`;
    expect(validateFormula(formula, { fieldKind })).toMatchObject({
      ok: false,
      errors: [{ code: 'ARGUMENT_TYPE', line: 1 }],
    });
    expect(
      evaluateFormula(formula, { ...context, subject: inMemorySubject('s1', { [field]: 'a,b' }), fieldKind }),
    ).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE' } });
    expect(
      evaluateBatch([item('盘点对象.a', 1, formula)], [inMemorySubject('s1', { [field]: 'a,b' })], {
        ...context,
        fieldKind,
      }),
    ).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE' } });
  });

  it('已解析 AST 与未提供字段目录的数组值也拒绝，不静默转为空值', () => {
    const checked = validateFormula(field);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const reader: SubjectReader = { id: 's1', resolveField: () => ({ status: 'found', value: ['a', 'b'] as never }) };
    expect(evaluateFormula(checked.program, { ...context, subject: reader, fieldKind })).toMatchObject({
      ok: false,
      failure: { code: 'ARGUMENT_TYPE' },
    });
    expect(evaluateFormula(field, { ...context, subject: reader })).toMatchObject({
      ok: false,
      failure: { code: 'ARGUMENT_TYPE' },
    });
  });
});
