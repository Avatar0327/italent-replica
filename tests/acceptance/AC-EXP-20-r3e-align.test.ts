/**
 * AC-EXP-20（R3e 补证落地，#105 / #89-4）：表达式函数口径对齐原站。依据 `26` 末节“补证结论 R3e”（W-862～864）：
 * “开始计算”实测值（WeekDay 周日 = 7、Mod(-7,3) = -1、NextMonth 01-31 → 02-28、Years = 6、无空格减法 -2 / -4）
 * 与函数说明原文（`//` 行首注释、Floor / Ceiling 基数、RoundUP / RoundDown 位数、Time 两参、有效时长、IN / NOTIN、
 * ShowText、人事子集取字段、最近第 N 次绩效）。
 */
import {
  bindFormula,
  evaluateBatch,
  evaluateFormula,
  formulaReferences,
  FUNCTION_PANEL,
  inMemorySubject,
  orderComputationItems,
  rebindLegacyFormula,
  textMentionsField,
  validateFormula,
  type EvaluationContext,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor, PROJECT } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const bool = (value: boolean) => ({ kind: 'boolean', value });
const run = (formula: string, fields: Record<string, PlainValue> = {}, ports?: InMemoryPortData) =>
  valueOf(evaluateFormula(formula, contextFor(fields, { ports })));
const saved = (formula: string) => validateFormula(formula);
const stamp = (formula: string) => run(`DateFormat(${formula}, "yyyy-MM-dd HH:mm:ss")`);

describe('“开始计算”实测值（`26` 末节表格）', () => {
  it('WeekDay 周日 = 7（#105-2）；周三仍为 3', () => {
    expect(run('WeekDay("2026/10/11")')).toEqual(num(7));
    expect(run('WeekDay("2026/10/07")')).toEqual(num(3));
    expect(run('WeekDay("2026/10/12")')).toEqual(num(1));
  });

  it('Mod 结果符号跟被除数：Mod(-7, 3) = -1（#105-10）', () => {
    expect(run('Mod(-7, 3)')).toEqual(num(-1));
    expect(run('Mod(7, -3)')).toEqual(num(1));
    expect(run('Mod(7, 3)')).toEqual(num(1));
  });

  it('NextMonth 返回下月同日，下月没有这一天取月末（#105-4）', () => {
    expect(run('DateFormat(NextMonth("2026/01/31"), "yyyy-MM-dd")')).toEqual(text('2026-02-28'));
    expect(run('DateFormat(NextMonth("2026/03/15"), "yyyy-MM-dd")')).toEqual(text('2026-04-15'));
    expect(run('DateFormat(NextMonth("2026/12/31"), "yyyy-MM-dd")')).toEqual(text('2027-01-31'));
  });

  it('Years 按年份相减：Years("2020/06/30", "2026/06/29") = 6（#105-5）', () => {
    expect(run('Years("2020/06/30", "2026/06/29")')).toEqual(num(6));
  });

  it('INT(-2.5) = -3、Sum("5", 1) = "51"：已与原站一致，不改', () => {
    expect(run('INT(-2.5)')).toEqual(num(-3));
    expect(run('Sum("5", 1)')).toEqual(text('51'));
  });
});

describe('#89-4 字段相减不加空格：已存在字段优先，否则按减法（DEC-228“原站支持再补兼容”）', () => {
  const FIELDS = { '盘点对象.能力得分': -3, '盘点对象.绩效得分': -1, '盘点对象.得分-上级分': 4, 上级分: 1 };
  const isKnownField = (path: string) => Object.hasOwn(FIELDS, path);

  it('盘点对象.能力得分-盘点对象.绩效得分 = -2，盘点对象.能力得分-1 = -4：保存、单个求值、批量求值一致', () => {
    for (const [formula, expected] of [
      ['盘点对象.能力得分-盘点对象.绩效得分', -2],
      ['盘点对象.能力得分-1', -4],
    ] as const) {
      const validated = validateFormula(formula, { isKnownField });
      expect(validated.ok, formula).toBe(true);
      expect(run(formula, FIELDS)).toEqual(num(expected));
      const items = [{ field: '盘点对象.结果', priority: 1, formula }];
      const batch = evaluateBatch(items, [inMemorySubject('e1', FIELDS)], { calendar: CALENDAR, project: PROJECT });
      expect(batch.ok && batch.results.e1?.['盘点对象.结果']).toEqual({ ok: true, value: num(expected) });
    }
  });

  it('解析写进语法树：保存结果的字段是两个，减号右侧可以是函数调用', () => {
    const validated = validateFormula('盘点对象.能力得分-盘点对象.绩效得分', { isKnownField });
    expect(validated.ok && validated.fields).toEqual(['盘点对象.能力得分', '盘点对象.绩效得分']);
    expect(run('盘点对象.能力得分-转换为数字("2")', FIELDS)).toEqual(num(-5));
    expect(saved('盘点对象.a-盘点对象.b')).toMatchObject({ ok: true, fields: ['盘点对象.a', '盘点对象.b'] });
  });

  it('含连字符的完整名是已存在字段时当作一个字段名（已存在字段优先）', () => {
    const validated = validateFormula('盘点对象.得分-上级分 + 1', { isKnownField });
    expect(validated.ok && validated.fields).toEqual(['盘点对象.得分-上级分']);
    expect(run('盘点对象.得分-上级分 + 1', FIELDS)).toEqual(num(5));
    const ordered = orderComputationItems([{ field: '盘点对象.x', priority: 1, formula: '盘点对象.得分-上级分' }], {
      isKnownField,
    });
    expect(ordered.ok).toBe(true);
  });

  it('数据源字段 360结果.问卷-他评总分 不传字段目录也按一个字段名解析', () => {
    expect(saved('Lastest360Cent(360结果.问卷-他评总分)')).toMatchObject({
      ok: true,
      fields: ['360结果.问卷-他评总分'],
    });
  });

  it('不再报“如需相减，请在减号两侧加空格”', () => {
    const result = validateFormula('盘点对象.不存在-盘点对象.绩效得分', { isKnownField });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('减号两侧');
    expect(JSON.stringify(result)).toContain('盘点对象.不存在');
  });

  it('盘点计算规则绑定（bindFormula）同一口径：可见字段相减绑定成两个句柄，带连字符的可见字段绑定成一个', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const C = '33333333-3333-4333-8333-333333333333';
    const options = {
      visibleFields: [
        { id: A, name: '能力得分' },
        { id: B, name: '绩效得分' },
        { id: C, name: '问卷-他评总分' },
      ],
      catalogVersion: { current: 1, submitted: 1 },
    };
    const minus = bindFormula('盘点对象.能力得分-盘点对象.绩效得分', options);
    expect(minus).toMatchObject({ ok: true, fieldIds: [A, B] });
    const whole = bindFormula('盘点对象.问卷-他评总分-1', options);
    expect(whole).toMatchObject({ ok: true, fieldIds: [C] });
  });
});

describe('`//` 行首整行注释（#105-15）', () => {
  it('从 // 到行尾忽略', () => {
    expect(run('// 能力分减一\n1 + 1')).toEqual(num(2));
    expect(run('Def(a, 1);\n  // 说明\na + 1')).toEqual(num(2));
    expect(run('1 + 1\n// 结尾注释')).toEqual(num(2));
    expect(saved('// 只有注释\n盘点对象.得分')).toMatchObject({ ok: true, fields: ['盘点对象.得分'] });
  });

  it('字符串里的 // 不是注释；不在行首的 // 报语法错误', () => {
    expect(run('Length("a//b")')).toEqual(num(4));
    expect(run('7 // 2')).toMatchObject({ code: 'SYNTAX_ERROR', message: expect.stringContaining('行首') });
  });
});

describe('数学函数参数（#105-11 / #105-12）', () => {
  it('Floor / Ceiling 第二参数“基数”可省略，默认 1', () => {
    expect(run('Floor(7, 5)')).toEqual(num(5));
    expect(run('Ceiling(7, 5)')).toEqual(num(10));
    expect(run('Floor(2.7)')).toEqual(num(2));
    expect(run('Ceiling(2.1)')).toEqual(num(3));
    expect(run('Ceiling(0.21, 0.1)')).toEqual(num(0.3));
    expect(run('Floor(-2.5, 2)')).toEqual(num(-4));
    expect(run('Floor(1, 0)')).toMatchObject({ code: 'DIVISION_BY_ZERO' });
  });

  it('RoundUP / RoundDown 位数可省（默认 0），最大 14，超出报参数错误', () => {
    expect(run('RoundUP(2.1)')).toEqual(num(3));
    expect(run('RoundDown(2.99)')).toEqual(num(2));
    expect(run('RoundUP(1.5, 14)')).toEqual(num(1.5));
    expect(run('RoundUP(1.5, 15)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
    expect(run('RoundDown(1.5, 15)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});

describe('日期函数参数（#105-3 / #105-7）', () => {
  it('Time(日期, 时间)：时间省略时为 00:00', () => {
    expect(stamp('Time("2026/10/07", "08:05")')).toEqual(text('2026-10-07 08:05:00'));
    expect(stamp('Time("2026/10/07 18:30", "08:05:09")')).toEqual(text('2026-10-07 08:05:09'));
    expect(stamp('Time("2026/10/07 18:30")')).toEqual(text('2026-10-07 00:00:00'));
  });

  it('有效时长：开始、结束、0 或 1 三个一组可重复，1 累加、0 扣除，单位分钟', () => {
    const formula = '有效时长("2026/10/07 08:00", "2026/10/07 12:00", 1, "2026/10/07 10:00", "2026/10/07 10:30", 0)';
    expect(run(formula)).toEqual(num(210));
    expect(run('EffectiveDuration("2026/10/07 08:00", "2026/10/07 09:15", 1)')).toEqual(num(75));
  });

  it('有效时长：参数个数须是 3 的倍数（保存报错），标志只能是 0 或 1', () => {
    expect(saved('有效时长("2026/10/07", "2026/10/08")')).toMatchObject({ ok: false });
    expect(saved('有效时长("2026/10/07", "2026/10/08", 1, "2026/10/09")')).toMatchObject({ ok: false });
    expect(run('有效时长("2026/10/07", "2026/10/08", 2)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});

describe('IN / NOTIN（#105-8）：候选值至少 1 个，且不支持变量', () => {
  it('候选值不能是 Def 变量：保存报错', () => {
    expect(saved('Def(a, "A"); IN("A", a)')).toMatchObject({ ok: false, errors: [{ code: 'ARGUMENT_TYPE' }] });
    expect(saved('Def(a, "A"); NOTIN("B", "C", a)')).toMatchObject({ ok: false, errors: [{ code: 'ARGUMENT_TYPE' }] });
    expect(run('Def(a, "A"); IN(a, "A", "B")')).toEqual(bool(true));
  });

  it('只有被比较的值、没有候选值：参数个数错误', () => {
    expect(saved('IN("A")')).toMatchObject({ ok: false, errors: [{ code: 'ARGUMENT_COUNT' }] });
  });
});

describe('ShowText（#105-14）：取字段值对应的中文名称', () => {
  it('单选 / 字典取显示名；没有显示名的值转成文本', () => {
    const fields = { '盘点对象.学历': { optionValue: '03', label: '本科' } };
    expect(run('ShowText(盘点对象.学历)', fields)).toEqual(text('本科'));
    expect(run('ShowText(12)')).toEqual(text('12'));
  });
});

describe('业务函数参数（#105-16 / #105-17）', () => {
  const subset: InMemoryPortData = {
    personnelSubset: {
      'emp-1': {
        教育经历: [
          { fields: { 学校: '甲大学', 学历: '本科', 毕业日期: '2010/07/01' } },
          { fields: { 学校: '乙大学', 学历: '硕士', 毕业日期: '2014/07/01' } },
          { fields: { 学校: '丙中学', 学历: '高中', 毕业日期: '2006/07/01' } },
        ],
      },
    },
  };

  it('人事子集取字段：指定字段、排序字段、升 / 降序、可选条件，返回排序后的第一条，不要求唯一', () => {
    expect(run('获取人事子集的指定字段数据(教育经历.学校, 教育经历.毕业日期, "降序")', {}, subset)).toEqual(
      text('乙大学'),
    );
    expect(run('PersonnelSubsetField(教育经历.学校, 教育经历.毕业日期, "升序")', {}, subset)).toEqual(text('丙中学'));
    const filtered = '获取人事子集的指定字段数据(教育经历.学校, 教育经历.毕业日期, "降序", 教育经历.学历<>"硕士")';
    expect(run(filtered, {}, subset)).toEqual(text('甲大学'));
  });

  it('人事子集取字段：排序方向只认“升序 / 降序”，排序字段须是同一子集的字段', () => {
    expect(run('获取人事子集的指定字段数据(教育经历.学校, 教育经历.毕业日期, "乱序")', {}, subset)).toMatchObject({
      code: 'ARGUMENT_TYPE',
    });
    expect(run('获取人事子集的指定字段数据(教育经历.学校, 工作经历.开始日期, "降序")', {}, subset)).toMatchObject({
      code: 'ARGUMENT_TYPE',
    });
    expect(saved('获取人事子集的指定字段数据(教育经历.学校)')).toMatchObject({ ok: false });
  });

  it('最近第 N 次绩效：N、排序日期（起始或截止）、可选条件；周期条件可省，缺排序日期保存报错', () => {
    const at = (iso: string) => new Date(iso);
    const ports: InMemoryPortData = {
      performance: {
        'emp-1': [
          {
            modifiedAt: at('2026-01-05T00:00:00Z'),
            fields: { 得分: 70, 截止日期: '2025/12/31', 起始日期: '2025/10/01' },
          },
          {
            modifiedAt: at('2026-01-01T00:00:00Z'),
            fields: { 得分: 80, 截止日期: '2026/03/31', 起始日期: '2025/09/01' },
          },
        ],
      },
    };
    expect(run('获取最近第N次绩效考核得分(1, 考核结果.截止日期)', {}, ports)).toEqual(num(80));
    expect(run('获取最近第N次绩效考核得分(1, 考核结果.起始日期)', {}, ports)).toEqual(num(70));
    expect(saved('获取最近第N次绩效考核得分(1, 考核结果.周期名称="年度")')).toMatchObject({ ok: false });
  });
});

describe('函数面板（#105-1）：合计 62 个', () => {
  it('业务 12、日期 24、逻辑 8、数学 9、统计 5、文本 2、其它 2', () => {
    expect(FUNCTION_PANEL).toHaveLength(62);
  });
});

/** 单个求值的上下文里带 fieldKind 时，带连字符的已知字段同样按字段名（与保存同一目录）。 */
it('单个求值：字段类型目录里的连字符字段按一个字段名', () => {
  const context: EvaluationContext = {
    ...contextFor({ '盘点对象.问卷-他评总分': 4 }),
    fieldKind: (path) => (path === '盘点对象.问卷-他评总分' ? 'number' : undefined),
  };
  expect(valueOf(evaluateFormula('盘点对象.问卷-他评总分 + 1', context))).toEqual(num(5));
});

describe('#89-4 名称文本的引用判定（不依赖字段目录）：两种读法都算，宁可多认', () => {
  it('formulaReferences / textMentionsField 同时认“并成字段名”和“按减法”两种读法', () => {
    const references = formulaReferences('盘点对象.能力得分-盘点对象.绩效得分');
    expect(references).toEqual(expect.arrayContaining(['盘点对象.能力得分', '盘点对象.绩效得分']));
    expect(textMentionsField('盘点对象.能力得分-1', '能力得分')).toBe(true);
    expect(textMentionsField('盘点对象.能力得分-1', '能力得分-1')).toBe(true);
    expect(textMentionsField('盘点对象.能力得分 + 1', '能力得分-1')).toBe(false);
  });

  it('存量公式改绑与 bindFormula 同一判定：带连字符的字段绑定成一个，其余按减法', () => {
    const A = '44444444-4444-4444-8444-444444444444';
    const B = '55555555-5555-4555-8555-555555555555';
    const fields = [
      { id: A, name: '得分-上级分', kind: 'number' as const },
      { id: B, name: '基准', kind: 'number' as const },
    ];
    expect(rebindLegacyFormula('盘点对象.得分-上级分-盘点对象.基准', fields)).toMatchObject({
      ok: true,
      fieldIds: [A, B],
    });
  });
});

describe('R3e 改动的函数：逐人求值与批量求值两条路径结果一致（#105）', () => {
  const ports: InMemoryPortData = {
    personnelSubset: {
      'emp-1': {
        教育经历: [
          { fields: { 学校: '甲大学', 毕业日期: '2010/07/01' } },
          { fields: { 学校: '乙大学', 毕业日期: '2014/07/01' } },
        ],
      },
    },
    performance: {
      'emp-1': [
        { modifiedAt: new Date('2026-01-01T00:00:00Z'), fields: { 得分: 70, 截止日期: '2025/12/31' } },
        { modifiedAt: new Date('2026-01-02T00:00:00Z'), fields: { 得分: 80, 截止日期: '2026/03/31' } },
      ],
    },
  };
  const fields = { '盘点对象.学历': { optionValue: '03', label: '本科' }, '盘点对象.能力得分': -3 };
  const batchOf = (formula: string) => {
    const items = [{ field: '盘点对象.结果', priority: 1, formula }];
    const context = contextFor(fields, { ports });
    const batch = evaluateBatch(items, [context.subject], {
      calendar: CALENDAR,
      project: PROJECT,
      ports: context.ports,
    });
    if (!batch.ok) return batch.failure;
    const result = batch.results['emp-1']?.['盘点对象.结果'];
    return result && valueOf(result);
  };

  it.each([
    ['WeekDay("2026/10/11")', num(7)],
    ['Mod(-7, 3)', num(-1)],
    ['DateFormat(NextMonth("2026/01/31"), "yyyy-MM-dd")', text('2026-02-28')],
    ['Years("2020/06/30", "2026/06/29")', num(6)],
    ['Floor(7, 5) + Ceiling(7, 5)', num(15)],
    ['RoundUP(1.21, 1)', num(1.3)],
    ['DateFormat(Time("2026/10/07", "08:05"), "HH:mm")', text('08:05')],
    ['有效时长("2026/10/07 08:00", "2026/10/07 09:00", 1)', num(60)],
    ['IN("A", "B", "A")', bool(true)],
    ['ShowText(盘点对象.学历)', text('本科')],
    ['获取人事子集的指定字段数据(教育经历.学校, 教育经历.毕业日期, "降序")', text('乙大学')],
    ['获取最近第N次绩效考核得分(1, 考核结果.截止日期)', num(80)],
    ['// 注释\n盘点对象.能力得分-1', num(-4)],
  ] as const)('%s', (formula, expected) => {
    expect(run(formula, fields, ports)).toEqual(expected);
    expect(batchOf(formula)).toEqual(expected);
  });
});
