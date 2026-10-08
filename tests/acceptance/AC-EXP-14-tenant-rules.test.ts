/**
 * AC-EXP-14 本租户 13 条盘点计算规则的计算项目原文（F-033，`26` §8.6；“⏎”还原为换行）：全部能通过保存校验；
 * 可求值的用内存替身按预期求值。含未加引号的裸词（A、型号1、默认盘点方案……）的项目求值口径待产品决定，
 * 这里只锁定现行为（裸词按字段 / 变量查找，查不到即计算失败），见 PR 描述“需要产品决策的问题”。
 */
import {
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  createInMemoryPorts,
  validateFormula,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, contextFor, PROJECT } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });

interface RuleItem {
  readonly rule: string;
  readonly item: string;
  readonly formula: string;
}

/** 规则原文（逐字照抄 `26` §8.6，只把“⏎”换成换行）。 */
const ITEMS: readonly RuleItem[] = [
  {
    rule: 'SG点计算规则',
    item: '绩效',
    formula:
      'Def( a,  获取指定年度指定周期的绩效等级(考核结果.年度=2025 , 考核结果.周期名称="第三季度"  )); \n' +
      '如果 判断为空(a) = True 那么  ""   \n如果 a= "A" 那么 3 \n如果 a= "B" 那么 2 \n否则 1',
  },
  {
    rule: 'SG点计算规则',
    item: '能力',
    formula:
      '如果 盘点对象.能力得分  ≥ 0 且 盘点对象.能力得分 < 5 那么 1 \n' +
      '如果 盘点对象.能力得分  ≥ 5 且 盘点对象.能力得分 < 8 那么 2 \n如果 盘点对象.能力得分  ≥ 8  那么 3  否则  "" ',
  },
  {
    rule: 'SG点计算规则',
    item: '潜力',
    formula:
      'Def(a,获取当前人员测评测验下的最近一次测评得分/维度得分(测验信息.总分,测验信息.测验名称="商业综合推理能力测验"));  \n' +
      '如果 a >= 3.5 那么 3 \n如果 a >= 3 那么 2 \n否则 1',
  },
  {
    rule: 'GLD360结果',
    item: '能力',
    formula:
      '如果 盘点对象.能力得分>0 且 盘点对象.能力得分<=1 那么 1  否则  \n' +
      '如果 盘点对象.能力得分>1 且 盘点对象.能力得分<=2 那么  2  否则  \n' +
      '如果 盘点对象.能力得分>2 且 盘点对象.能力得分<=3 那么  3 否则   0',
  },
  {
    rule: 'GLD360结果',
    item: '绩效',
    formula:
      '如果 盘点对象.绩效结果3 = A 那么 3  否则  \n' +
      '如果 盘点对象.绩效结果3 = B 或 盘点对象.绩效结果3 = C  那么 2  否则  \n' +
      '如果 盘点对象.绩效结果3 = D   那么 1  否则  "" ',
  },
  {
    rule: 'GLD360结果',
    item: '价值观上级得分',
    formula:
      '获取最近一次360总分(360结果.维度角色得分 ,360结果.套卷名称="GLD 360 POC试测"  ,360结果.角色名称="上级", ' +
      '360结果.维度名称 = "价值观"  ) \n  \n ',
  },
  {
    rule: 'GLD360结果',
    item: '360评价-通用',
    formula: '获取最近一次360总分(360结果.角色得分,360结果.套卷名称="干部360评估",360结果.角色名称="上级")',
  },
  {
    rule: 'GLD360结果',
    item: '360结果',
    formula: '获取最近一次360总分(360结果.问卷-他评总分,360结果.套卷名称="干部360评估")',
  },
  {
    rule: 'jb-绩效结果',
    item: '绩效结果3',
    formula:
      '获取指定年度指定周期的绩效等级(考核结果.年度 =  "2026",考核结果.周期名称 ="六月" ,' +
      '考核结果.绩效活动 ="lj-专业线考核" ) ',
  },
  {
    rule: 'jb-绩效结果',
    item: '绩效结果2',
    formula: '如果 考核结果.lj-考核类别 =  型号1 且 考核结果.周期 = 年度  那么 考核结果.总等级 否则 "" ',
  },
  {
    rule: 'jb-绩效结果',
    item: '绩效结果1',
    formula: '如果 考核结果.lj-考核类别 =  型号1 且 考核结果.周期 = 第一季度 那么 考核结果.总等级 否则 "" ',
  },
  {
    rule: '安擎绩效转化计算规则',
    item: '绩效',
    formula:
      ' Def(aa, 获取某个结果在指定人员范围内的排名("百分位",盘点对象.绩效得分  ,' +
      '盘点活动.项目名称="安擎科技人才盘点项目" ,盘点对象.盘点方案 )); \n' +
      '如果 ToNumber(aa)<=0 那么 "" \n否则 如果 ToNumber(aa)<=20 那么 3 \n' +
      '否则 如果 ToNumber(aa)   ≥   90 那么 1 \n否则 2',
  },
  { rule: 'ST计算规则', item: '潜力', formula: 'Average(盘点对象.评价1 ,盘点对象.评价2 ,盘点对象.进化  ) ' },
  { rule: 'ST计算规则', item: '合计', formula: 'Sum( 盘点对象.评价2,盘点对象.评价1) \n ' },
  {
    rule: 'JDB盘点计算规则',
    item: '绩效',
    formula:
      'Def( a,  获取指定年度指定周期的绩效等级(考核结果.年度=2025 , 考核结果.周期名称="第三季度"  )); \n' +
      '如果 判断为空(a) = True 那么  ""   \n如果 a= "A" 那么 3 \n如果 a= "B" 那么 2 \n否则 1',
  },
  {
    rule: 'JDB盘点计算规则',
    item: '能力',
    formula:
      'Def(a,获取最近一次360总分(360结果.问卷-他评总分,360结果.套卷名称="CBC分公司负责人 /副职" ) );  \n' +
      '如果 a >= 3.5  那么 3 \n如果 判断不为空(a) 那么 1 \n否则  "" ',
  },
  {
    rule: 'JDB盘点计算规则',
    item: '潜力',
    formula:
      'Def(a,获取当前人员测评测验下的最近一次测评得分/维度得分(测验信息.总分,测验信息.测验名称="商业综合推理能力测验"));  \n' +
      '如果 a >= 3.5 那么 3 \n如果 a >= 3 那么 2 \n否则 1',
  },
  { rule: '盘点计算演示', item: '其他能力', formula: 'Average(盘点对象.C1,盘点对象.C2,盘点对象.C3 )' },
  { rule: '盘点计算演示', item: '竞争护城河能力', formula: 'Average(盘点对象.B1, 盘点对象.B2,盘点对象.B3)' },
  { rule: '盘点计算演示', item: '关键核心能力', formula: 'Average(盘点对象.A1,盘点对象.A2,盘点对象.A3)' },
  {
    rule: '盘点计算演示',
    item: '能力总得分',
    formula: [
      '如果 盘点对象.关键核心能力>0 且 盘点对象.竞争护城河能力>0 且 盘点对象.其他能力>0 那么 ' +
        '盘点对象.关键核心能力×0.5+盘点对象.竞争护城河能力×0.4+盘点对象.其他能力×0.1 ',
      '否则 如果 盘点对象.关键核心能力>0 且 盘点对象.竞争护城河能力>0 且 盘点对象.其他能力=0 那么 ' +
        '盘点对象.关键核心能力×0.6+盘点对象.竞争护城河能力×0.4 ',
      '否则 如果 盘点对象.关键核心能力>0 且 盘点对象.竞争护城河能力=0 且 盘点对象.其他能力>0 那么 ' +
        '盘点对象.关键核心能力×0.8+盘点对象.其他能力×0.2 ',
      '否则 如果 盘点对象.关键核心能力=0 且 盘点对象.竞争护城河能力>0 且 盘点对象.其他能力>0 那么 ' +
        '盘点对象.竞争护城河能力×0.8+盘点对象.其他能力×0.2 ',
      '否则 如果 盘点对象.关键核心能力>0 且 盘点对象.竞争护城河能力=0 且 盘点对象.其他能力=0 那么 盘点对象.关键核心能力 ',
      '否则 如果 盘点对象.关键核心能力=0 且 盘点对象.竞争护城河能力>0 且 盘点对象.其他能力=0 那么 盘点对象.竞争护城河能力 ',
      '否则 如果 盘点对象.关键核心能力=0 且 盘点对象.竞争护城河能力=0 且 盘点对象.其他能力>0 那么 盘点对象.其他能力 否则 0',
    ].join('\n'),
  },
  {
    rule: '盘点计算演示',
    item: '能力',
    formula:
      '如果 盘点对象.能力总得分>=4  那么 3   \n如果 盘点对象.能力总得分>=2.5  且 盘点对象.能力总得分<4  那么 2   \n否则  1',
  },
  { rule: 'GLD盘点规则HTC', item: '领导力', formula: '22' },
  { rule: 'GLD盘点规则HTC', item: '能力', formula: '3' },
  {
    rule: 'GLD盘点规则HTC',
    item: '绩效',
    formula:
      '如果 获取指定年度指定周期的绩效得分(考核结果.年度 =2026 , 考核结果.周期名称 ="年度") > 90 那么 3 \n' +
      '如果 获取指定年度指定周期的绩效得分(考核结果.年度 =2026 , 考核结果.周期名称 ="年度") > 80  且  ' +
      '获取指定年度指定周期的绩效得分(考核结果.年度 =2026 , 考核结果.周期名称 ="年度")  ≤  90  那么 2 \n否则 1',
  },
  {
    rule: 'GLD盘点规则HTC',
    item: '绩效得分',
    formula: '获取指定年度指定周期的绩效得分(考核结果.年度="2026",考核结果.周期名称="年度")',
  },
  {
    rule: 'GLD盘点规则HTC',
    item: '价值观同级与下级得分',
    formula: '获取最近一次360总分( 360结果.角色得分 , 360结果.套卷名称="创建意识问卷",360结果.角色名称="同事") ',
  },
  {
    rule: 'GLD盘点规则HTC',
    item: '价值观上级得分',
    formula: '获取最近一次360总分( 360结果.角色得分 ,360结果.套卷名称="创建意识问卷",360结果.角色名称 ="上级") ',
  },
  {
    rule: 'GLD盘点规则HTC',
    item: '价值观总分',
    formula: '获取最近一次360总分( 360结果.问卷-他评总分,360结果.套卷名称 = "创建意识问卷") ',
  },
  {
    rule: '绩效计算规则逻辑',
    item: '业绩',
    formula: 'IF(盘点对象.绩效结果1 =A  ,盘点对象.业绩 ="高"  , 盘点对象.业绩 ="中" )  ',
  },
  {
    rule: 'cj人才盘点计算规则',
    item: '校准后绩效',
    formula:
      '获取指定年度指定周期的绩效得分(考核结果.年度=2024,考核结果.周期名称="年度")×0.5+' +
      '获取指定年度指定周期的绩效得分(考核结果.年度=2023,考核结果.周期名称="年度")×0.3+' +
      '获取指定年度指定周期的绩效得分(考核结果.年度=2022,考核结果.周期名称="年度")×0.2',
  },
  {
    rule: 'cj人才盘点计算规则',
    item: '校准后能力',
    formula:
      'Def(aa, 获取某个结果在指定人员范围内的排名("百分位",盘点对象.能力,盘点对象.盘点方案=默认盘点方案,盘点对象.盘点方案)); \n' +
      '如果 ToNumber(aa)<=0 那么 "" \n否则 如果 ToNumber(aa)<=20 那么 3 \n否则 如果 ToNumber(aa)>90 那么 1 \n否则 2',
  },
  {
    rule: 'NQ-捷翼',
    item: '绩效',
    formula:
      '如果 任职记录.hs绩效等级 = A \n那么 "高"  \n如果 任职记录.hs绩效等级 = B \n那么 "中"  \n' +
      '如果 任职记录.hs绩效等级 = C 或 任职记录.hs绩效等级=D \n那么 "低"  \n否则 0',
  },
  { rule: 'NQ-捷翼', item: '责任心', formula: '如果 360结果.题目名称="责任心" 那么 360结果.题目-他评总分  \n否则 0' },
  { rule: 'NQ-捷翼', item: '年龄-等级', formula: '如果 员工信息.年龄 ≥ 60 那么 A \n否则 B' },
];

const find = (rule: string, item: string) => {
  const found = ITEMS.find((entry) => entry.rule === rule && entry.item === item);
  if (!found) throw new Error(`没有 ${rule} / ${item}`);
  return found.formula;
};

const perf = (fields: Record<string, PlainValue>) => ({ fields, modifiedAt: new Date('2026-07-01T00:00:00Z') });
const survey = (fields: Record<string, PlainValue>) => ({
  startAt: new Date('2026-09-01T00:00:00Z'),
  endAt: new Date('2026-09-10T00:00:00Z'),
  reportGeneratedAt: new Date('2026-09-11T00:00:00Z'),
  fields,
});
const rankMember = (id: string, score: number) => ({
  id,
  fields: { '盘点对象.绩效得分': score, '盘点活动.项目名称': '安擎科技人才盘点项目', '盘点对象.盘点方案': '方案一' },
});

const PORTS: InMemoryPortData = {
  performance: {
    'emp-1': [
      perf({ 年度: 2025, 周期名称: '第三季度', 等级: 'A' }),
      perf({ 年度: 2026, 周期名称: '年度', 得分: 92, 等级: 'A' }),
      perf({ 年度: '2026', 周期名称: '六月', 绩效活动: 'lj-专业线考核', 等级: 'B' }),
      perf({ 年度: '2026', 周期名称: '六月', 绩效活动: '其他考核', 等级: 'D' }),
      perf({ 年度: 2024, 周期名称: '年度', 得分: 80 }),
      perf({ 年度: 2023, 周期名称: '年度', 得分: 70 }),
      perf({ 年度: 2022, 周期名称: '年度', 得分: 60 }),
    ],
  },
  survey360: {
    'emp-1': [
      survey({ 套卷名称: 'GLD 360 POC试测', 角色名称: '上级', 维度名称: '价值观', 维度角色得分: 4.1 }),
      survey({ 套卷名称: 'GLD 360 POC试测', 角色名称: '上级', 维度名称: '担当', 维度角色得分: 2.9 }),
      survey({ 套卷名称: '干部360评估', 角色名称: '上级', 角色得分: 3.9, '问卷-他评总分': 4.0 }),
      survey({ 套卷名称: '创建意识问卷', 角色名称: '同事', 角色得分: 3.2, '问卷-他评总分': 3.4 }),
      survey({ 套卷名称: '创建意识问卷', 角色名称: '上级', 角色得分: 3.6, '问卷-他评总分': 3.4 }),
      survey({ 套卷名称: 'CBC分公司负责人 /副职', 角色名称: '上级', '问卷-他评总分': 3.7 }),
    ],
  },
  assessment: {
    'emp-1': [
      {
        testedAt: new Date('2026-08-01T00:00:00Z'),
        fields: { 测验名称: '商业综合推理能力测验', 总分: 3.2 },
      },
    ],
  },
  ranking: [
    rankMember('emp-1', 95),
    rankMember('emp-2', 90),
    rankMember('emp-3', 85),
    rankMember('emp-4', 80),
    rankMember('emp-5', 70),
  ],
};

const run = (formula: string, fields: Record<string, PlainValue> = {}) =>
  valueOf(evaluateFormula(formula, contextFor(fields, { ports: PORTS })));

describe('AC-EXP-14 本租户 13 条规则（11 条有计算项目，共 35 项）原文全部能通过保存校验', () => {
  it('共 35 个计算项目', () => {
    expect(ITEMS).toHaveLength(35);
    expect(new Set(ITEMS.map((entry) => entry.rule)).size).toBe(11);
  });

  it.each(ITEMS.map((entry) => [`${entry.rule} / ${entry.item}`, entry.formula] as const))('%s', (_label, formula) => {
    const validated = validateFormula(formula);
    expect(validated.ok ? [] : validated.errors).toEqual([]);
  });
});

describe('AC-EXP-14 可求值的计算项目按预期求值（取数用内存替身）', () => {
  it.each([
    ['SG点计算规则', '绩效', {}, num(3)],
    ['SG点计算规则', '能力', { '盘点对象.能力得分': 6 }, num(2)],
    ['SG点计算规则', '能力', { '盘点对象.能力得分': 9 }, num(3)],
    ['SG点计算规则', '潜力', {}, num(2)],
    ['GLD360结果', '能力', { '盘点对象.能力得分': 1.5 }, num(2)],
    ['GLD360结果', '能力', { '盘点对象.能力得分': 6 }, num(0)],
    ['GLD360结果', '价值观上级得分', {}, num(4.1)],
    ['GLD360结果', '360评价-通用', {}, num(3.9)],
    ['GLD360结果', '360结果', {}, num(4.0)],
    ['jb-绩效结果', '绩效结果3', {}, text('B')],
    ['安擎绩效转化计算规则', '绩效', {}, num(3)],
    ['ST计算规则', '潜力', { '盘点对象.评价1': 3, '盘点对象.评价2': 4, '盘点对象.进化': 5 }, num(4)],
    ['ST计算规则', '合计', { '盘点对象.评价1': 3, '盘点对象.评价2': 4 }, num(7)],
    ['JDB盘点计算规则', '绩效', {}, num(3)],
    ['JDB盘点计算规则', '能力', {}, num(3)],
    ['JDB盘点计算规则', '潜力', {}, num(2)],
    ['GLD盘点规则HTC', '领导力', {}, num(22)],
    ['GLD盘点规则HTC', '能力', {}, num(3)],
    ['GLD盘点规则HTC', '绩效', {}, num(3)],
    ['GLD盘点规则HTC', '绩效得分', {}, num(92)],
    ['GLD盘点规则HTC', '价值观同级与下级得分', {}, num(3.2)],
    ['GLD盘点规则HTC', '价值观上级得分', {}, num(3.6)],
    ['GLD盘点规则HTC', '价值观总分', {}, num(3.4)],
    ['NQ-捷翼', '责任心', { '360结果.题目名称': '责任心', '360结果.题目-他评总分': 4.5 }, num(4.5)],
    ['NQ-捷翼', '责任心', { '360结果.题目名称': '沟通', '360结果.题目-他评总分': 4.5 }, num(0)],
  ] as const)('%s / %s %j', (rule, item, fields, expected) => {
    expect(run(find(rule, item), fields)).toEqual(expected);
  });

  it('cj人才盘点计算规则 / 校准后绩效：80×0.5 + 70×0.3 + 60×0.2 = 73', () => {
    const result = run(find('cj人才盘点计算规则', '校准后绩效'));
    expect(result).toMatchObject({ kind: 'number' });
    expect((result as { value: number }).value).toBeCloseTo(73, 10);
  });

  it('SG点 / JDB 绩效：取不到 2025 第三季度等级 → 判断为空(a) = True → 空文本', () => {
    const noData = valueOf(
      evaluateFormula(find('SG点计算规则', '绩效'), contextFor({}, { ports: { performance: { 'emp-1': [] } } })),
    );
    expect(noData).toEqual(text(''));
  });

  it('JDB 能力：360 取不到 → 判断不为空(a) 为假 → 空文本', () => {
    const noData = valueOf(
      evaluateFormula(find('JDB盘点计算规则', '能力'), contextFor({}, { ports: { survey360: { 'emp-1': [] } } })),
    );
    expect(noData).toEqual(text(''));
  });

  it('安擎绩效转化：百分位 名次 / 人数 × 100（🟡 #105）：第 1 名 20 → 3，第 5 名 100 → 1，其余 2', () => {
    const at = (subjectId: string) =>
      valueOf(evaluateFormula(find('安擎绩效转化计算规则', '绩效'), contextFor({}, { ports: PORTS, subjectId })));
    expect(at('emp-1')).toEqual(num(3));
    expect(at('emp-3')).toEqual(num(2));
    expect(at('emp-5')).toEqual(num(1));
  });

  it('ST 潜力：某个评价为空 → Average 计算失败（DEC-257，原站同样报错）', () => {
    const fields = { '盘点对象.评价1': 3, '盘点对象.评价2': null, '盘点对象.进化': 5 };
    expect(run(find('ST计算规则', '潜力'), fields)).toMatchObject({ code: 'EMPTY_IN_AGGREGATE' });
  });

  it('盘点计算演示 5 项整条规则批量计算：同优先级 2 内“能力”依赖“能力总得分”，按依赖先算（DEC-265）', () => {
    const items = [
      { field: '盘点对象.其他能力', priority: 1, formula: find('盘点计算演示', '其他能力') },
      { field: '盘点对象.竞争护城河能力', priority: 1, formula: find('盘点计算演示', '竞争护城河能力') },
      { field: '盘点对象.关键核心能力', priority: 1, formula: find('盘点计算演示', '关键核心能力') },
      { field: '盘点对象.能力', priority: 2, formula: find('盘点计算演示', '能力') },
      { field: '盘点对象.能力总得分', priority: 2, formula: find('盘点计算演示', '能力总得分') },
    ];
    const fields = {
      '盘点对象.A1': 4,
      '盘点对象.A2': 5,
      '盘点对象.A3': 6,
      '盘点对象.B1': 3,
      '盘点对象.B2': 3,
      '盘点对象.B3': 3,
      '盘点对象.C1': 1,
      '盘点对象.C2': 2,
      '盘点对象.C3': 3,
    };
    const batch = evaluateBatch(items, [inMemorySubject('emp-1', fields)], {
      calendar: CALENDAR,
      project: PROJECT,
      ports: createInMemoryPorts({}),
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.order.indexOf('盘点对象.能力总得分')).toBeLessThan(batch.order.indexOf('盘点对象.能力'));
    const results = batch.results['emp-1']!;
    expect(results['盘点对象.关键核心能力']).toEqual({ ok: true, value: num(5) });
    const total = results['盘点对象.能力总得分'];
    expect(total?.ok && total.value.kind === 'number' && total.value.value).toBeCloseTo(3.9, 10);
    expect(results['盘点对象.能力']).toEqual({ ok: true, value: num(2) });
  });
});

describe('AC-EXP-14 含裸词的计算项目：能解析；求值口径待产品决定（现行为：裸词按字段 / 变量查找）', () => {
  it.each([
    ['GLD360结果', '绩效', { '盘点对象.绩效结果3': 'A' }, 'UNKNOWN_FIELD'],
    ['jb-绩效结果', '绩效结果2', { '考核结果.lj-考核类别': '型号1' }, 'UNKNOWN_FIELD'],
    ['jb-绩效结果', '绩效结果1', { '考核结果.lj-考核类别': '型号1' }, 'UNKNOWN_FIELD'],
    ['绩效计算规则逻辑', '业绩', { '盘点对象.绩效结果1': 'A', '盘点对象.业绩': '高' }, 'UNKNOWN_FIELD'],
    ['cj人才盘点计算规则', '校准后能力', { '盘点对象.能力': 3, '盘点对象.盘点方案': '默认盘点方案' }, 'OUT_OF_SCOPE'],
    ['NQ-捷翼', '绩效', { '任职记录.hs绩效等级': 'A' }, 'UNKNOWN_FIELD'],
    ['NQ-捷翼', '年龄-等级', { '员工信息.年龄': 30 }, 'UNKNOWN_FIELD'],
  ] as const)('%s / %s', (rule, item, fields, code) => {
    expect(validateFormula(find(rule, item)).ok).toBe(true);
    const ports: InMemoryPortData = { ranking: [{ id: 'emp-1', fields }] };
    expect(valueOf(evaluateFormula(find(rule, item), contextFor(fields, { ports })))).toMatchObject({ code });
  });
});
