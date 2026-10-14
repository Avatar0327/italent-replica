/**
 * AC-EXP-15 DEC-265：日期与数学函数细节照原站（取证 Q-M0-83 实算，`26` §8.7；以盘点实际计算为准），
 * 以及同优先级按依赖排序（Q-M0-84，R3-T00 已实现，这里补测试确认）；循环依赖由 DEC-274 修订为保存提示（见 AC-EXP-18）。
 */
import { evaluateFormula, orderComputationItems, type EvaluationContext, type EvaluationResult } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });

/** 原站测算时刻：UTC 2026-10-07 15:24:07 = 北京时间 23:24:07。 */
const NOW = new Date('2026-10-07T15:24:07Z');
/** now 传 null 表示上下文不提供“现在”。 */
const at = (timeZone: string, today: string, now: Date | null = NOW): EvaluationContext => ({
  ...contextFor({}),
  calendar: now === null ? { today, timeZone } : { today, timeZone, now },
});
const SHANGHAI = at('Asia/Shanghai', '2026-10-07');
const run = (formula: string, context: EvaluationContext = SHANGHAI) => valueOf(evaluateFormula(formula, context));

describe('DEC-265 Now / Today 按租户时区', () => {
  it('北京时间：Now() = 2026-10-07 23:24:07，Today() = 2026-10-07 00:00:00', () => {
    expect(run('DateFormat(Now(), "yyyy-MM-dd HH:mm:ss")')).toEqual(text('2026-10-07 23:24:07'));
    expect(run('DateFormat(Today(), "yyyy-MM-dd HH:mm:ss")')).toEqual(text('2026-10-07 00:00:00'));
    expect(run('DateFormat(AddDays(Today(), 1), "yyyy-MM-dd HH:mm")')).toEqual(text('2026-10-08 00:00'));
  });

  it('同一时刻换成别的租户时区：现在 = 当地墙上时间', () => {
    const losAngeles = at('America/Los_Angeles', '2026-10-07');
    expect(run('DateFormat(Now(), "yyyy-MM-dd HH:mm")', losAngeles)).toEqual(text('2026-10-07 08:24'));
  });

  it('上下文的“今天”与“现在”在租户时区下不是同一天 → CONTEXT_INVALID（不读系统时钟、不猜）', () => {
    expect(run('Today()', at('Asia/Shanghai', '2026-10-08'))).toMatchObject({ code: 'CONTEXT_INVALID' });
    expect(run('1', at('America/Los_Angeles', '2026-10-08'))).toMatchObject({ code: 'CONTEXT_INVALID' });
  });

  it('上下文没给“现在”时 Now() 计算失败（CONTEXT_INVALID），Today() 照常', () => {
    const withoutNow = at('Asia/Shanghai', '2026-10-07', null);
    expect(run('Now()', withoutNow)).toMatchObject({ code: 'CONTEXT_INVALID' });
    expect(run('Day(Today())', withoutNow)).toEqual(num(7));
  });
});

describe('DEC-265 Days(a, b) = b − a（整天数）', () => {
  it('Days(ToDate("2026-10-01"), Today()) = 6；参数对调为 −6', () => {
    expect(run('Days(ToDate("2026-10-01"), Today())')).toEqual(num(6));
    expect(run('Days(Today(), ToDate("2026-10-01"))')).toEqual(num(-6));
  });
});

describe('DEC-265 FirstDay / LastDay 取年初 / 年末（不是月初 / 月末）', () => {
  it('FirstDay(Today()) = 2026-01-01，LastDay(Today()) = 2026-12-31', () => {
    expect(run('DateFormat(FirstDay(Today()), "yyyy-MM-dd")')).toEqual(text('2026-01-01'));
    expect(run('DateFormat(LastDay(Today()), "yyyy-MM-dd")')).toEqual(text('2026-12-31'));
  });
});

describe('DEC-265 WeekDay：周三返回 3', () => {
  it('WeekDay(Today()) = 3（2026-10-07 周三）；Year / Month 同原站', () => {
    expect(run('WeekDay(Today())')).toEqual(num(3));
    expect(run('Year(Today())')).toEqual(num(2026));
    expect(run('Month(Today())')).toEqual(num(10));
  });
});

describe('DEC-265 Round 四舍五入', () => {
  it('Round(2.5, 0) = 3；Round(2.5) = 3；Round(0.125, 2) = 0.13', () => {
    expect(run('Round(2.5, 0)')).toEqual(num(3));
    expect(run('Round(2.5)')).toEqual(num(3));
    expect(run('Round(0.125, 2)')).toEqual(num(0.13));
  });
});

describe('DEC-265 ToNumber("abc") = 0', () => {
  it('ToNumber("abc") = ToNumber("") = 0；数字文本照常转换', () => {
    expect(run('ToNumber("abc")')).toEqual(num(0));
    expect(run('ToNumber("")')).toEqual(num(0));
    expect(run('ToNumber("12.5")')).toEqual(num(12.5));
  });
});

describe('DEC-265 Count 计入空串', () => {
  it('Count(1, "", 3) = 3', () => {
    expect(run('Count(1, "", 3)')).toEqual(num(3));
  });
});

describe('DEC-265 除以 0 计算失败', () => {
  it('1 / 0 → DIVISION_BY_ZERO', () => {
    expect(run('1 / 0')).toMatchObject({ code: 'DIVISION_BY_ZERO' });
  });
});

describe('DEC-265 同优先级按依赖排序（Q-M0-84）；循环依赖按 DEC-274 保存提示', () => {
  it('同为优先级 2：“能力”排在前面但引用“能力总得分”，排序后先算能力总得分', () => {
    const ordered = orderComputationItems([
      { field: '盘点对象.能力', priority: 2, formula: '如果 盘点对象.能力总得分 >= 4 那么 3 否则 1' },
      { field: '盘点对象.能力总得分', priority: 2, formula: '盘点对象.关键核心能力 * 0.5' },
    ]);
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.order.map((item) => item.field)).toEqual(['盘点对象.能力总得分', '盘点对象.能力']);
  });

  it('同优先级互相引用：保存时只提示、不拒绝（DEC-274 修订 DEC-265，用例见 AC-EXP-18）', () => {
    const ordered = orderComputationItems([
      { field: '盘点对象.a', priority: 1, formula: '盘点对象.b + 1' },
      { field: '盘点对象.b', priority: 1, formula: '盘点对象.a + 1' },
    ]);
    expect(ordered.ok).toBe(true);
    if (ordered.ok) expect(ordered.cycles).toEqual([['盘点对象.a', '盘点对象.b', '盘点对象.a']]);
  });
});
