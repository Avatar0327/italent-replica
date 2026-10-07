/**
 * AC-EXP-13 函数面板全集（F-033，DEC-260，取证 Q-M0-81，`26` §8.6）：面板上的每个函数都能在注册表里解析；
 * 中文名与英文名同义，每个新增函数中英文名各至少一例；没有 avg；新增函数的数值参数经公共取参（DEC-270 取代 DEC-264）。
 */
import {
  createDefaultRegistry,
  DEFAULT_SEMANTICS,
  evaluateFormula,
  FUNCTION_PANEL,
  type EvaluationContext,
  type EvaluationResult,
  type PanelCategory,
  type PlainValue,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });

/** 2026-10-07 23:24:07 北京时间（`26` §8.7 测算时刻）。 */
const NOW = new Date('2026-10-07T15:24:07Z');
const context = (fields: Record<string, PlainValue> = {}): EvaluationContext => ({
  ...contextFor(fields),
  calendar: { today: '2026-10-07', timeZone: 'Asia/Shanghai', now: NOW },
});
const run = (formula: string, fields?: Record<string, PlainValue>) =>
  valueOf(evaluateFormula(formula, context(fields)));
const day = (formula: string) => run(`DateFormat(${formula}, "yyyy-MM-dd")`);
const minute = (formula: string) => run(`DateFormat(${formula}, "yyyy-MM-dd HH:mm")`);

describe('AC-EXP-13 面板全集：7 类，按面板原名都能解析', () => {
  const byCategory = (category: PanelCategory) => FUNCTION_PANEL.filter((entry) => entry.category === category);

  it('各类数量与 §8.6 列出的函数名一致（日期类面板标 26、§8.6 只列 24 个，差额待取证 #105）', () => {
    expect(byCategory('业务函数')).toHaveLength(12);
    expect(byCategory('日期函数')).toHaveLength(24);
    expect(byCategory('逻辑函数')).toHaveLength(8);
    expect(byCategory('数学函数')).toHaveLength(9);
    expect(byCategory('统计函数')).toHaveLength(5);
    expect(byCategory('文本函数')).toHaveLength(2);
    expect(byCategory('其它函数')).toHaveLength(2);
    expect(new Set(FUNCTION_PANEL.map((entry) => entry.label)).size).toBe(FUNCTION_PANEL.length);
  });

  it('除 Def（语法，不是函数）外，每个面板名都解析到注册函数', () => {
    const registry = createDefaultRegistry();
    for (const entry of FUNCTION_PANEL) {
      if (entry.syntax === 'def') continue;
      expect(registry.resolve(entry.label), entry.label).toBeDefined();
    }
    expect(FUNCTION_PANEL.find((entry) => entry.label === 'Def')?.syntax).toBe('def');
  });

  it('统计函数只有 Average，没有 avg（DEC-260）', () => {
    const registry = createDefaultRegistry();
    expect(registry.resolve('avg')).toBeUndefined();
    expect(byCategory('统计函数').map((entry) => entry.label)).toEqual(['Average', 'Sum', 'Max', 'Min', 'Count']);
  });

  it('业务函数按面板中文名注册，与英文名同义', () => {
    const registry = createDefaultRegistry();
    const pairs: [string, string][] = [
      ['获取指定年度指定周期的绩效得分', 'PerformanceCent'],
      ['获取指定年度指定周期的绩效等级', 'PerformanceGrade'],
      ['获取最近第N年的绩效考核得分', 'PerformanceLastCent'],
      ['获取最近第N年的绩效考核等级', 'PerformanceLastGrade'],
      ['获取最近第N次绩效考核得分', 'PerformanceNthCent'],
      ['获取最近第N次绩效考核等级', 'PerformanceNthGrade'],
      ['获取最近一次360总分', 'Lastest360Cent'],
      ['获取当前人员测评测验下的最近一次测评得分/维度得分', 'LastestAssessmentCent'],
      ['获取某个结果在指定人员范围内的排名', 'Ranking'],
      ['获取最近一次人才评定数据', 'LastestTalentReview'],
      ['获取人事子集的指定字段数据', 'PersonnelSubsetField'],
      ['按照参数规则获取数据', 'ParameterRuleData'],
    ];
    for (const [chinese, english] of pairs) {
      expect(registry.resolve(chinese)?.name, chinese).toBe(english);
      expect(registry.resolve(english)?.name).toBe(english);
    }
    expect(
      byCategory('业务函数')
        .map((entry) => entry.label)
        .sort(),
    ).toEqual(pairs.map(([chinese]) => chinese).sort());
  });
});

describe('AC-EXP-13 日期函数：中英文名各一例（今天 / 现在来自计算上下文，DEC-056）', () => {
  it.each([
    ['DateFormat(Now(), "yyyy-MM-dd HH:mm:ss")', text('2026-10-07 23:24:07')],
    ['DateFormat(现在(), "HH:mm")', text('23:24')],
    ['DayOfYear("2026/02/01")', num(32)],
    ['年中第几天("2024/12/31")', num(366)],
    ['Hour("2026/10/07 23:24:07")', num(23)],
    ['小时(Now())', num(23)],
    ['Minute("2026/10/07 23:24:07")', num(24)],
    ['分钟("2026/10/07 08:05")', num(5)],
    ['Second("2026/10/07 23:24:07")', num(7)],
    ['秒(Now())', num(7)],
    ['WeekDay("2026/10/04")', num(0)],
    ['星期(Today())', num(3)],
    ['DateFormat(Time("2026/10/07 08:05:09"), "HH:mm:ss")', text('08:05:09')],
    ['DateFormat(时间(Now()), "HH:mm")', text('23:24')],
    ['Days("2026/10/01", Today())', num(6)],
    ['天数(Today(), "2026/10/01")', num(-6)],
    ['Years("2000/10/08", "2026/10/07")', num(25)],
    ['年数("2000/10/07", Today())', num(26)],
    ['Minutes("2026/10/07 08:00", "2026/10/07 09:30")', num(90)],
    ['分钟数("2026/10/07 09:30", "2026/10/07 08:00:30")', num(-89)],
  ] as const)('%s', (formula, expected) => {
    expect(run(formula)).toEqual(expected);
  });

  it.each([
    ['FirstDay("2026/10/07")', '2026-01-01'],
    ['年初(Today())', '2026-01-01'],
    ['LastDay("2026/10/07")', '2026-12-31'],
    ['年末("2024/02/29")', '2024-12-31'],
    ['NextMonth("2026/01/31")', '2026-02-01'],
    ['下月("2026/12/15")', '2027-01-01'],
    ['AddYears("2024/02/29", 1)', '2025-02-28'],
    ['加年(Today(), -1)', '2025-10-07'],
    ['AddMonths("2026/01/31", 1)', '2026-02-28'],
    ['加月("2026/11/30", 3)', '2027-02-28'],
    ['AddDays(Today(), 1)', '2026-10-08'],
    ['加天("2026/12/31", 1)', '2027-01-01'],
    ['ToDate("2026/03/04")', '2026-03-04'],
    ['转换为日期("2026-03-04")', '2026-03-04'],
  ] as const)('%s → %s', (formula, expected) => {
    expect(day(formula)).toEqual(text(expected));
  });

  it.each([
    ['AddHours("2026/10/07 23:00", 2)', '2026-10-08 01:00'],
    ['加小时(Today(), -1)', '2026-10-06 23:00'],
    ['AddMinutes("2026/10/07 23:50", 15)', '2026-10-08 00:05'],
    ['加分钟("2026/10/07", 90)', '2026-10-07 01:30'],
  ] as const)('%s → %s', (formula, expected) => {
    expect(minute(formula)).toEqual(text(expected));
  });

  it('有效时长 / EffectiveDuration：已注册（六个参数），口径待取证前求值返回结构化失败（#105）', () => {
    expect(run('有效时长(1, 2, 3, 4, 5, 6)')).toMatchObject({ code: 'FUNCTION_UNAVAILABLE' });
    expect(run('EffectiveDuration(1, 2, 3, 4, 5, 6)')).toMatchObject({ code: 'FUNCTION_UNAVAILABLE' });
    expect(run('有效时长(1, 2)')).toMatchObject({ code: 'ARGUMENT_COUNT' });
  });
});

describe('AC-EXP-13 逻辑函数：中英文名各一例', () => {
  it.each([
    ['AND(1 > 0, 2 > 1)', bool(true)],
    ['全部为真(真, 假)', bool(false)],
    ['OR(假, 1 > 0)', bool(true)],
    ['任一为真(假, 假)', bool(false)],
    ['IF(1 > 0, "是", "否")', text('是')],
    ['条件取值(假, 1, 2)', num(2)],
    ['IN("B", "A", "B")', bool(true)],
    ['属于(3, 1, 2)', bool(false)],
    ['NOTIN("C", "A", "B")', bool(true)],
    ['不属于("A", "A", "B")', bool(false)],
    ['IsEmpty("")', bool(true)],
    ['是否为空(0)', bool(false)],
    ['IsNull("")', bool(true)],
    ['判断为空(0)', bool(false)],
    ['IsNotNull(0)', bool(true)],
    ['判断不为空("")', bool(false)],
  ] as const)('%s', (formula, expected) => {
    expect(run(formula)).toEqual(expected);
  });

  it('IF / AND / OR 只求值需要的参数：未走到的分支里除以 0 不报错', () => {
    expect(run('IF(真, 1, 1 / 0)')).toEqual(num(1));
    expect(run('AND(假, 1 / 0 > 0)')).toEqual(bool(false));
    expect(run('OR(真, 1 / 0 > 0)')).toEqual(bool(true));
    expect(run('IF(假, 1)')).toEqual({ kind: 'empty' });
  });

  it('AND / OR / IF 写成函数时按函数解析；写在两个操作数之间仍是“且 / 或”运算', () => {
    expect(run('1 > 0 and(2 > 3)')).toEqual(bool(false));
    expect(run('1 > 0 OR 2 > 3')).toEqual(bool(true));
    expect(run('if (1 > 0) then 1 else 2')).toEqual(num(1));
    expect(run('IF(1 > 0, 1, 2) + 1')).toEqual(num(2));
  });

  it('判断为空 / 判断不为空 对空字段', () => {
    expect(run('判断为空(盘点对象.x)', { '盘点对象.x': null })).toEqual(bool(true));
    expect(run('判断不为空(盘点对象.x)', { '盘点对象.x': null })).toEqual(bool(false));
  });
});

describe('AC-EXP-13 数学函数：中英文名各一例', () => {
  it.each([
    ['Round(2.345, 2)', num(2.35)],
    ['四舍五入(2.5, 0)', num(3)],
    ['RoundUP(2.1, 0)', num(3)],
    ['RoundUp(1.1 * 3, 1)', num(3.3)],
    ['向上舍入(-2.11, 1)', num(-2.2)],
    ['RoundDown(2.99)', num(2)],
    ['向下舍入(-2.99, 1)', num(-2.9)],
    ['INT(2.7)', num(2)],
    ['取整(-2.5)', num(-3)],
    ['Floor(2.7)', num(2)],
    ['向下取整(-2.1)', num(-3)],
    ['Ceiling(2.1)', num(3)],
    ['向上取整(-2.9)', num(-2)],
    ['Abs(-3)', num(3)],
    ['绝对值(3)', num(3)],
    ['Mod(7, 3)', num(1)],
    ['取余(-7, 3)', num(2)],
  ] as const)('%s', (formula, expected) => {
    expect(run(formula)).toEqual(expected);
  });

  it('Mod 除数为 0 计算失败', () => {
    expect(run('Mod(1, 0)')).toMatchObject({ code: 'DIVISION_BY_ZERO' });
  });
});

describe('AC-EXP-13 统计 / 文本 / 其它函数：中英文名各一例', () => {
  it.each([
    ['Count(1, "", 3)', num(3)],
    ['计数(盘点对象.x, 1)', num(2)],
    ['Average(1, 2, 6)', num(3)],
    ['平均值(4, 6)', num(5)],
    ['Concatenate("A", 1, "B")', text('A1B')],
    ['连接("等级", 2)', text('等级2')],
    ['ToNumber("12")', num(12)],
    ['转换为数字("82%")', num(0.82)],
    ['ShowText(12)', text('12')],
    ['显示文本("高")', text('高')],
    ['Def(a, 2); a * 3', num(6)],
    ['定义(a, 2); a + 1', num(3)],
  ] as const)('%s', (formula, expected) => {
    expect(run(formula, { '盘点对象.x': null })).toEqual(expected);
  });
});

describe('AC-EXP-13 新增函数的数值参数经公共取参（DEC-270）：空值默认计算失败，semantics 可切回按 0', () => {
  const FORMULAS = [
    'RoundUP(盘点对象.x)',
    'RoundDown(盘点对象.x, 1)',
    'INT(盘点对象.x)',
    'Floor(盘点对象.x)',
    'Ceiling(盘点对象.x)',
    'Mod(盘点对象.x, 3)',
    'DateFormat(AddDays("2026/10/07", 盘点对象.x), "yyyy-MM-dd")',
  ];

  it.each(FORMULAS)('默认（DEC-270：函数数值参数遇空计算失败）：%s', (formula) => {
    expect(run(formula, { '盘点对象.x': null })).toMatchObject({ code: 'EMPTY_IN_ARITHMETIC' });
  });

  it.each(FORMULAS)('semantics 切回按 0（emptyInFunctionArgument = zero）：%s', (formula) => {
    const lenient: EvaluationContext = {
      ...context({ '盘点对象.x': null }),
      semantics: { ...DEFAULT_SEMANTICS, emptyInFunctionArgument: 'zero' },
    };
    const result = valueOf(evaluateFormula(formula, lenient));
    expect(result).toEqual(formula.startsWith('DateFormat') ? text('2026-10-07') : num(0));
  });

  it('数字字符串按数值、非数字文本失败（与四则同口径，DEC-257）', () => {
    expect(run('Mod("7", 3)')).toEqual(num(1));
    expect(run('INT("甲")')).toMatchObject({ code: 'TEXT_IN_ARITHMETIC' });
  });
});

describe('AC-EXP-13 运算符工具栏：× ÷ 与 //', () => {
  it('× / ÷ 等同 * / /（本租户规则原文写作 ×）', () => {
    expect(run('2×0.5 + 3÷2')).toEqual(num(2.5));
  });

  it('“//” 的含义（整除或注释）待取证：暂按语法错误，提示原因（#105）', () => {
    expect(run('7 // 2')).toMatchObject({ code: 'SYNTAX_ERROR', message: expect.stringContaining('//') });
  });
});
