/** F-049 第 2 轮 P2-02：Program 与字符串一致拒绝多选，排名不得吞掉多选错误。 */
import {
  createInMemoryPorts,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  orderComputationItems,
  parseFormula,
  type ComputationItem,
  type ExpressionFieldKind,
  type SubjectReader,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR } from './AC-EXP-support.js';

const tags = '盘点对象.标签';
const score = '盘点对象.分数';
const fieldKind = (path: string): ExpressionFieldKind | undefined => (path === tags ? 'multi_option' : undefined);
const people = [10, 5].map((value, i) => inMemorySubject(`s${i}`, { [score]: value, [tags]: 'a,b' }));
const context = {
  calendar: CALENDAR,
  subject: people[0]!,
  fieldKind,
  ports: { ranking: { population: () => ({ ok: true as const, data: people }) } },
};
const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });

function programOf(formula: string) {
  const parsed = parseFormula(formula);
  if (!parsed.ok) throw new Error('合成公式应能解析');
  return parsed.program;
}

describe('AC-EXP-19 DEC-314 多选禁入覆盖 Program 全树', () => {
  it.each([`IF(false, ${tags}, 1)`, `Ranking("排序号", ${score}, true, ${tags})`, `Def(x, IF(false, ${tags}, 1)); x`])(
    '%s：无目录解析的 Program 与字符串入口失败结果相同',
    (formula) => {
      const textResult = evaluateFormula(formula, context);
      expect(textResult).toMatchObject({ ok: false, failure: { code: 'ARGUMENT_TYPE', line: 1 } });
      expect(evaluateFormula(programOf(formula), context)).toEqual(textResult);
    },
  );

  it('Def 变量不误用同名多选字段目录', () => {
    const formula = 'Def(标签, 1); IF(false, 标签, 2)';
    const options = { ...context, fieldKind: () => 'multi_option' as const };
    const expected = { ok: true, value: { kind: 'number', value: 2 } };
    expect(evaluateFormula(formula, options)).toEqual(expected);
    expect(evaluateFormula(programOf(formula), options)).toEqual(expected);
  });

  it('取数记录字段仍由记录端口提供，不误用对象字段目录', () => {
    const formula = 'PerformanceLastCent(1, 考核结果.标签 = "A")';
    const options = {
      ...context,
      fieldKind: () => 'multi_option' as const,
      ports: createInMemoryPorts({
        performance: {
          s0: [{ fields: { 年度: 2026, 标签: 'A', 得分: 80 }, modifiedAt: new Date('2026-10-08T00:00:00Z') }],
        },
      }),
    };
    const expected = { ok: true, value: { kind: 'number', value: 80 } };
    expect(evaluateFormula(formula, options)).toEqual(expected);
    expect(evaluateFormula(programOf(formula), options)).toEqual(expected);
  });

  it('目录抛错继续按未知类型处理，不泄露异常也不新增旧 Program 阻断', () => {
    const formula = `IF(false, ${tags}, 1)`;
    const options = {
      ...context,
      fieldKind: (): never => {
        throw new Error('private catalog details');
      },
    };
    const expected = { ok: true, value: { kind: 'number', value: 1 } };
    expect(evaluateFormula(formula, options)).toEqual(expected);
    expect(evaluateFormula(programOf(formula), options)).toEqual(expected);
  });
});

describe('AC-EXP-19 排名传播运行期多选错误', () => {
  it.each([
    `Ranking("排序号", ${score}, true, ${tags})`,
    `Ranking("排序号", ${score}, true, IF(true, ${tags}, "A"))`,
    `Ranking("排序号", ${score}, ${tags} = "A")`,
    `Ranking("排序号", ${tags})`,
  ])('%s：没有目录时，其他总体成员的数组也不能吞成空分组或不参与', (formula) => {
    const arrayMember: SubjectReader = {
      id: 's1',
      resolveField: (path) => ({ status: 'found', value: path === tags ? (['A', 'B'] as never) : 5 }),
    };
    const options = {
      calendar: CALENDAR,
      subject: inMemorySubject('s0', { [score]: 10, [tags]: 'A' }),
      ports: { ranking: { population: () => ({ ok: true as const, data: [people[0]!, arrayMember] }) } },
    };
    for (const input of [formula, programOf(formula)]) {
      expect(evaluateFormula(input, options)).toMatchObject({
        ok: false,
        failure: { code: 'ARGUMENT_TYPE', line: 1, message: expect.stringContaining('DEC-314') },
      });
    }
  });
});

describe('AC-EXP-19 批量唯一短名绑定也检查完整目标的多选目录', () => {
  it('保存排序和批量求值在未执行分支都拒绝唯一短名引用', () => {
    const items = [item(tags, 1, '"A"'), item('盘点对象.结果', 2, 'IF(false, 标签, 1)')];
    const failure = { ok: false, failure: { code: 'ARGUMENT_TYPE', field: '盘点对象.结果' } };
    expect(orderComputationItems(items, { fieldKind })).toMatchObject(failure);
    expect(evaluateBatch(items, people, { calendar: CALENDAR, fieldKind })).toMatchObject(failure);
  });

  it('Def 遮蔽短名与非唯一短名仍按既有绑定规则处理，不猜测目录', () => {
    const options = { calendar: CALENDAR, fieldKind };
    const shadowed = evaluateBatch(
      [item(tags, 1, '"A"'), item('盘点对象.结果', 2, 'Def(标签, 1); 标签')],
      people,
      options,
    );
    const ambiguous = evaluateBatch(
      [item(tags, 1, '"A"'), item('其他对象.标签', 1, '"B"'), item('盘点对象.结果', 2, 'IF(false, 标签, 1)')],
      people,
      options,
    );
    for (const batch of [shadowed, ambiguous]) {
      expect(batch.ok).toBe(true);
      if (!batch.ok) continue;
      expect(batch.results.s0?.['盘点对象.结果']).toEqual({ ok: true, value: { kind: 'number', value: 1 } });
    }
  });
});
