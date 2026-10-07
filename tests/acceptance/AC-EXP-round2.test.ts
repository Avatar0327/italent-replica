/**
 * AC-EXP 第二轮回归（astra 首审 P2-1～P2-6，PR #90）：无空格减法、日期文本比较、短字段名依赖、
 * 直接自引用、公共边界不抛异常、360 与测评的时间窗口分离。
 */
import {
  DEFAULT_SEMANTICS,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  orderComputationItems,
  validateFormula,
  type ComputationItem,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryPortData,
  type SubjectReader,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });
const item = (field: string, priority: number, formula: string): ComputationItem => ({ field, priority, formula });

describe('P2-1 无空格减法是减号；原站带连字符的字段名仍可用（字段相减按 DEC-228 须加空格）', () => {
  const HINT = '如需相减，请在减号两侧加空格';

  it('Def 变量、数字之间的“-”是减号；字段引用之间不加空格是一个字段名（DEC-228）', () => {
    const fields = { '盘点对象.得分': 5, '盘点对象.a': 5, '盘点对象.b': 2 };
    expect(valueOf(evaluateFormula('Def(a,10); Def(b,3); a-b', contextFor({})))).toEqual(num(7));
    expect(valueOf(evaluateFormula('Def(总分, 10); Def(上级分, 4); 总分-上级分', contextFor({})))).toEqual(num(6));
    expect(valueOf(evaluateFormula('盘点对象.得分 - 1', contextFor(fields)))).toEqual(num(4));
    expect(valueOf(evaluateFormula('盘点对象.a - 盘点对象.b', contextFor(fields)))).toEqual(num(3));
    for (const formula of ['盘点对象.得分-1', '盘点对象.a-盘点对象.b']) {
      expect(valueOf(evaluateFormula(formula, contextFor(fields)))).toMatchObject({
        code: 'UNKNOWN_FIELD',
        message: expect.stringContaining(HINT),
      });
    }
  });

  it('对象成员位置、两侧都是汉字的“-”仍是字段名的一部分（360结果.问卷-他评总分）', () => {
    const validated = validateFormula('Lastest360Cent(360结果.问卷-他评总分)');
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.fields).toEqual(['360结果.问卷-他评总分']);
    expect(valueOf(evaluateFormula('盘点对象.问卷-他评总分 + 1', contextFor({ '盘点对象.问卷-他评总分': 4 })))).toEqual(
      num(5),
    );
  });

  it('汉字完整字段之间不加空格是一个字段名，加空格才相减（DEC-228 取代第三轮“期望 3”）', () => {
    const fields = { '盘点对象.得分': 5, '盘点对象.基准': 2 };
    expect(valueOf(evaluateFormula('盘点对象.得分-盘点对象.基准', contextFor(fields)))).toMatchObject({
      code: 'UNKNOWN_FIELD',
      message: expect.stringContaining(HINT),
    });
    expect(valueOf(evaluateFormula('盘点对象.得分 - 盘点对象.基准', contextFor(fields)))).toEqual(num(3));
  });
});

describe('P2-2 两侧都是原站日期格式的文本时按日期比较（`26` §8.3）', () => {
  const run = (formula: string, fields = {}) => valueOf(evaluateFormula(formula, contextFor(fields)));

  it('带时间、非零填充、跨月', () => {
    expect(run('"2020/01/01" = "2020/01/01 00:00:00"')).toEqual(bool(true));
    expect(run('"2020/02/01" < "2020/1/31"')).toEqual(bool(false));
    expect(run('"2020/1/31" < "2020/02/01"')).toEqual(bool(true));
    expect(run('"2020/01/31 23:59:59" < "2020/02/01"')).toEqual(bool(true));
    expect(run('"2020/12" > "2020/9"')).toEqual(bool(true));
    expect(run('"2020/01/01 08:00" ≠ "2020/01/01"')).toEqual(bool(true));
  });

  it('字段里的日期文本与字面量比较、与 Date 瞬时比较', () => {
    expect(run('盘点对象.入职日期 >= "2019/12/01"', { '盘点对象.入职日期': '2019/12/5' })).toEqual(bool(true));
    const instant = { '盘点对象.入职日期': new Date('2020-01-01T20:00:00Z') };
    expect(run('盘点对象.入职日期 >= "2020/01/02" 且 盘点对象.入职日期 < "2020/01/03"', instant)).toEqual(bool(true));
  });

  it('只有一侧是日期格式时仍按文本处理：相等按文本比较，比较大小失败（DEC-257）', () => {
    expect(run('"2020/01/01" = "元旦"')).toEqual(bool(false));
    expect(run('"2020/01/01" > "元旦"')).toMatchObject({ code: 'TYPE_CONVERSION' });
    expect(run('"b" > "a"')).toMatchObject({ code: 'TYPE_CONVERSION' });
  });
});

describe('P2-3 短字段名：依赖排序与求值共用同一套解析规则', () => {
  const items = [item('盘点对象.a', 1, '100'), item('盘点对象.b', 1, 'a + 1'), item('盘点对象.c', 1, '盘点对象.a + 2')];

  it('排序识别短名依赖', () => {
    const ordered = orderComputationItems(items);
    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(ordered.entries.find((entry) => entry.item.field === '盘点对象.b')?.dependsOn).toEqual(['盘点对象.a']);
  });

  it('求值时短名读到先算项目的结果，不读原对象的同名字段，也不报未知字段', () => {
    const subjects = [inMemorySubject('e1', { a: 10 }), inMemorySubject('e2', {})];
    const batch = evaluateBatch(items, subjects, { calendar: CALENDAR });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    for (const id of ['e1', 'e2']) {
      expect(batch.results[id]).toMatchObject({
        '盘点对象.b': { ok: true, value: num(101) },
        '盘点对象.c': { ok: true, value: num(102) },
      });
    }
  });

  it('短名在多个计算项目之间有歧义时不当作依赖，求值按对象自身字段', () => {
    const ambiguous = [item('盘点对象.a', 1, '1'), item('任职记录.a', 1, '2'), item('盘点对象.b', 2, 'a')];
    const ordered = orderComputationItems(ambiguous);
    expect(ordered.ok).toBe(true);
    if (!ordered.ok) return;
    expect(ordered.entries.find((entry) => entry.item.field === '盘点对象.b')?.dependsOn).toEqual([]);
    const batch = evaluateBatch(ambiguous, [inMemorySubject('e1', { a: 9 })], { calendar: CALENDAR });
    if (!batch.ok) return;
    expect(batch.results.e1?.['盘点对象.b']).toEqual({ ok: true, value: num(9) });
  });
});

describe('P2-4 直接自引用是循环依赖', () => {
  it('全名与短名自引用都返回 CYCLIC_DEPENDENCY', () => {
    for (const formula of ['盘点对象.a + 1', 'a + 1']) {
      const ordered = orderComputationItems([item('盘点对象.a', 1, formula)]);
      expect(ordered.ok).toBe(false);
      if (ordered.ok || ordered.failure.code !== 'CYCLIC_DEPENDENCY') throw new Error('应当报循环依赖');
      expect(ordered.failure.cycle).toEqual(['盘点对象.a', '盘点对象.a']);
    }
    const batch = evaluateBatch(
      [item('盘点对象.a', 1, '盘点对象.a + 1')],
      [inMemorySubject('e1', { '盘点对象.a': 10 })],
      {
        calendar: CALENDAR,
      },
    );
    expect(batch).toMatchObject({ ok: false, failure: { code: 'CYCLIC_DEPENDENCY' } });
  });
});

describe('P2-5 公共边界只返回结构化结果，不抛异常、不透出内部错误', () => {
  const huge = '('.repeat(3000) + '1' + ')'.repeat(3000);
  const deep = '('.repeat(150) + '1' + ')'.repeat(150);

  it('嵌套过深 / 公式过长：校验与求值都返回 SYNTAX_ERROR 并说明原因', () => {
    for (const [formula, reason] of [
      [deep, '嵌套'],
      [huge, '过长'],
      ['-'.repeat(150) + '1', '嵌套'],
      ['1' + ' + 1'.repeat(1000), '过长'],
    ] as const) {
      const validated = validateFormula(formula);
      expect(validated.ok).toBe(false);
      if (!validated.ok) {
        expect(validated.errors[0]).toMatchObject({ code: 'SYNTAX_ERROR', message: expect.stringContaining(reason) });
      }
      expect(valueOf(evaluateFormula(formula, contextFor({})))).toMatchObject({ code: 'SYNTAX_ERROR' });
    }
    expect(orderComputationItems([item('盘点对象.a', 1, huge)])).toMatchObject({
      ok: false,
      failure: { code: 'SYNTAX_ERROR' },
    });
  });

  it('非法时区：CONTEXT_INVALID', () => {
    const context: EvaluationContext = {
      ...contextFor({ '盘点对象.d': new Date() }),
      calendar: { today: '2026-10-06', timeZone: 'Mars/Olympus' },
    };
    expect(valueOf(evaluateFormula('DateFormat(盘点对象.d, "yyyy")', context))).toMatchObject({
      code: 'CONTEXT_INVALID',
    });
    expect(valueOf(evaluateFormula('1 + 1', context))).toMatchObject({ code: 'CONTEXT_INVALID' });
    expect(
      valueOf(evaluateFormula('1', { ...context, calendar: { today: '2026/13/45', timeZone: 'Asia/Shanghai' } })),
    ).toMatchObject({
      code: 'CONTEXT_INVALID',
    });
  });

  it('对象读取器或端口抛异常：DATA_UNAVAILABLE，失败信息不含异常内容', () => {
    const throwing: SubjectReader = {
      id: 'e1',
      resolveField: () => {
        throw new Error('secret-detail-from-reader');
      },
    };
    const context: EvaluationContext = { subject: throwing, calendar: CALENDAR };
    const result = evaluateFormula('盘点对象.x + 1', context);
    expect(valueOf(result)).toMatchObject({ code: 'DATA_UNAVAILABLE' });
    expect(JSON.stringify(result)).not.toContain('secret-detail');

    const ports = {
      performance: {
        records: () => {
          throw new Error('secret-detail-from-port');
        },
      },
    };
    const viaPort = evaluateFormula('PerformanceCent(考核结果.年度=2026, 考核结果.周期名称="年度")', {
      ...contextFor({}),
      ports,
    });
    expect(valueOf(viaPort)).toMatchObject({ code: 'DATA_UNAVAILABLE' });
    expect(JSON.stringify(viaPort)).not.toContain('secret-detail');
  });

  it('批量求值中一个对象的读取器抛异常，不影响其他对象', () => {
    const throwing: SubjectReader = {
      id: 'bad',
      resolveField: () => {
        throw new Error('boom');
      },
    };
    const batch = evaluateBatch(
      [item('盘点对象.b', 1, '盘点对象.a + 1')],
      [throwing, inMemorySubject('ok', { '盘点对象.a': 1 })],
      {
        calendar: CALENDAR,
      },
    );
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.results.bad?.['盘点对象.b']).toMatchObject({ ok: false, failure: { code: 'DATA_UNAVAILABLE' } });
    expect(batch.results.ok?.['盘点对象.b']).toEqual({ ok: true, value: num(2) });
  });
});

describe('P2-6 360 固定取项目结束时间前最近一次（DEC-262② 起按结束时间）；DEC-031 的窗口参数只作用于测评', () => {
  const project = { startAt: new Date('2026-08-31T16:00:00Z'), endAt: new Date('2026-09-30T16:00:00Z') };
  const ports: InMemoryPortData = {
    survey360: {
      'emp-1': [
        // DEC-262②：只取已结束且报告已生成的活动
        {
          startAt: new Date('2026-08-10T00:00:00Z'),
          endAt: new Date('2026-08-20T00:00:00Z'),
          reportGeneratedAt: new Date('2026-08-21T00:00:00Z'),
          fields: { 套卷名称: 'S', 角色名称: '上级', 角色得分: 60 },
        },
        {
          startAt: new Date('2026-09-15T00:00:00Z'),
          endAt: new Date('2026-09-25T00:00:00Z'),
          reportGeneratedAt: new Date('2026-09-26T00:00:00Z'),
          fields: { 套卷名称: 'S', 角色名称: '上级', 角色得分: 90 },
        },
      ],
    },
    assessment: {
      'emp-1': [
        { testedAt: new Date('2026-08-10T00:00:00Z'), fields: { 测验名称: 'T', 总分: 0.6 } },
        { testedAt: new Date('2026-09-15T00:00:00Z'), fields: { 测验名称: 'T', 总分: 0.9 } },
      ],
    },
  };
  const run = (formula: string, extra: Partial<EvaluationContext> = {}) =>
    valueOf(evaluateFormula(formula, { ...contextFor({}, { ports }), project, ...extra }));

  it('只改测评口径为开始时间前：测评结果变化，360 结果不变', () => {
    const survey = 'Lastest360Cent(360结果.角色得分, 360结果.角色名称="上级")';
    const assessment = 'LastestAssessmentCent(测验信息.总分, 测验信息.测验名称="T")';
    expect(run(survey)).toEqual(num(90));
    expect(run(assessment)).toEqual(num(0.9));
    expect(run(survey, { assessmentLatestWindow: 'before_project_start' })).toEqual(num(90));
    expect(run(assessment, { assessmentLatestWindow: 'before_project_start' })).toEqual(num(0.6));
  });
});

describe('P3 语义配置 toNumberOfEmpty 的三个分支都生效', () => {
  it.each([
    ['zero', { kind: 'number', value: 0 }],
    ['empty', { kind: 'empty' }],
    ['fail', { code: 'TYPE_CONVERSION' }],
  ] as const)('%s', (mode, expected) => {
    const context: EvaluationContext = {
      ...contextFor({ '盘点对象.x': null }),
      semantics: { ...DEFAULT_SEMANTICS, toNumberOfEmpty: mode },
    };
    expect(valueOf(evaluateFormula('ToNumber(盘点对象.x)', context))).toMatchObject(expected);
  });
});
