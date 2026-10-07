/**
 * AC-EXP-16 业务函数（F-033，DEC-260 / DEC-262，`26` §8.6）：绩效第 N 年 / 第 N 次、360“最近一次”（DEC-262②）、
 * 排名并列与待办触发标记（DEC-262①）、测评面板名、三个新取数函数（人才评定、人事子集、参数规则）的端口与桩。
 * 真实数据源与按查看人裁剪不在本任务：360 在 R3-T03，人才评定在 R3-T02，人事子集 / 参数规则在后续任务。
 */
import {
  createDefaultRegistry,
  evaluateFormula,
  type EvaluationResult,
  type InMemoryPortData,
  type PlainValue,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
const text = (value: string) => ({ kind: 'text', value });
const EMPTY = { kind: 'empty' };
/** 数值取数函数取不到：空值带来源类型（PR #108 第 3 轮，日期参数据此区分真正的空日期）。 */
const EMPTY_NUMBER = { kind: 'empty', of: 'number' };
const runWith =
  (ports: InMemoryPortData, subjectId = 'emp-1') =>
  (formula: string) =>
    valueOf(evaluateFormula(formula, contextFor({}, { ports, subjectId })));

describe('AC-EXP-16 绩效：最近第 N 年 / 第 N 次（周期按名称文本过滤，可选绩效活动过滤）', () => {
  const row = (fields: Record<string, PlainValue>, modifiedAt = '2026-01-01T00:00:00Z') => ({
    fields,
    modifiedAt: new Date(modifiedAt),
  });
  const run = runWith({
    performance: {
      'emp-1': [
        row({ 年度: 2026, 周期名称: '年度', 得分: 90, 等级: 'A', 考核结束日期: '2026/06/30' }),
        row({ 年度: 2026, 周期名称: '第三季度', 得分: 70, 等级: 'C', 考核结束日期: '2026/09/30' }),
        row({ 年度: 2025, 周期名称: '第三季度', 得分: 75, 等级: 'B', 考核结束日期: '2025/09/30' }),
        row({ 年度: 2024, 周期名称: '年度', 得分: 80, 等级: 'B', 考核结束日期: '2024/12/31' }, '2025-01-05T00:00:00Z'),
        row({ 年度: 2024, 周期名称: '年度', 得分: 60, 等级: 'D', 绩效活动: '补考' }, '2025-03-01T00:00:00Z'),
      ],
    },
  });

  it('第 N 年：面板中文名，周期表达式过滤后取第 N 个年度', () => {
    expect(run('获取最近第N年的绩效考核得分(1, 考核结果.周期名称="年度")')).toEqual(num(90));
    expect(run('获取最近第N年的绩效考核等级(2, 考核结果.周期名称="第三季度")')).toEqual(text('B'));
    expect(run('PerformanceLastCent(3, 考核结果.周期名称="第三季度")')).toEqual(EMPTY_NUMBER);
  });

  it('第 N 年：参数顺序待取证（#105），N 写在前或后都识别；只写 N 时保持原口径', () => {
    expect(run('PerformanceLastGrade(考核结果.周期名称="第三季度", 1)')).toEqual(text('C'));
    expect(run('PerformanceLastCent(2)')).toEqual(num(75));
  });

  it('第 N 年：可选绩效活动过滤', () => {
    expect(run('PerformanceLastCent(2, 考核结果.周期名称="年度", 考核结果.绩效活动="补考")')).toEqual(EMPTY_NUMBER);
    expect(run('PerformanceLastCent(1, 考核结果.周期名称="年度", 考核结果.绩效活动="补考")')).toEqual(num(60));
  });

  it('第 N 次：按指定的考核结果日期字段倒序取第 N 条（DEC-260）', () => {
    expect(run('获取最近第N次绩效考核得分(1, 考核结果.周期名称="第三季度", 考核结果.考核结束日期)')).toEqual(num(70));
    expect(run('获取最近第N次绩效考核等级(2, 考核结果.周期名称="第三季度", 考核结果.考核结束日期)')).toEqual(text('B'));
    expect(run('PerformanceNthCent(3, 考核结果.周期名称="第三季度", 考核结果.考核结束日期)')).toEqual(EMPTY_NUMBER);
  });

  it('第 N 次：参数顺序待取证（#105），按参数形态识别 N、过滤条件与日期字段', () => {
    expect(run('PerformanceNthGrade(考核结果.周期名称="第三季度", 考核结果.考核结束日期, 1)')).toEqual(text('C'));
  });

  it('第 N 次：日期字段为空的记录不参与；不写日期字段时按最后修改时间倒序（🟡 #105）', () => {
    expect(run('PerformanceNthCent(2, 考核结果.周期名称="年度", 考核结果.考核结束日期)')).toEqual(num(80));
    expect(run('PerformanceNthCent(3, 考核结果.周期名称="年度", 考核结果.考核结束日期)')).toEqual(EMPTY_NUMBER);
    // 不写日期字段：最后修改 2026-01-01（90）→ 2025-03-01（60）→ 2025-01-05（80）
    expect(run('PerformanceNthCent(2, 考核结果.周期名称="年度")')).toEqual(num(60));
  });

  it('N 不合法、N 写了两个都是参数错误', () => {
    expect(run('PerformanceNthCent(0, 考核结果.周期名称="年度")')).toMatchObject({ code: 'ARGUMENT_TYPE' });
    expect(run('PerformanceNthCent(1, 2)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});

describe('AC-EXP-16 360“最近一次”（🟡 DEC-262②）：只取已结束且报告已生成的活动，按结束时间倒序', () => {
  const activity = (
    startAt: string,
    endAt: string | undefined,
    reportGeneratedAt: string | undefined,
    score: number,
    activityId?: string,
  ) => ({
    startAt: new Date(startAt),
    ...(endAt === undefined ? {} : { endAt: new Date(endAt) }),
    ...(reportGeneratedAt === undefined ? {} : { reportGeneratedAt: new Date(reportGeneratedAt) }),
    ...(activityId === undefined ? {} : { activityId }),
    fields: { 套卷名称: 'S', 角色名称: '上级', 角色得分: score },
  });
  const FORMULA = '获取最近一次360总分(360结果.角色得分, 360结果.角色名称="上级")';

  it('开始更晚但结束更早的活动不算“最近”：按结束时间倒序', () => {
    const run = runWith({
      survey360: {
        'emp-1': [
          activity('2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 70),
          activity('2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 90),
        ],
      },
    });
    expect(run(FORMULA)).toEqual(num(70));
  });

  it('进行中（无结束时间）、报告未生成的活动不计', () => {
    const run = runWith({
      survey360: {
        'emp-1': [
          activity('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 60),
          activity('2026-08-01T00:00:00Z', undefined, undefined, 99),
          activity('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', undefined, 98),
        ],
      },
    });
    expect(run(FORMULA)).toEqual(num(60));
  });

  it('结束时间相同按报告生成时间倒序', () => {
    const run = runWith({
      survey360: {
        'emp-1': [
          activity('2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', 80, 'A1'),
          activity('2026-06-02T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z', 85, 'A2'),
        ],
      },
    });
    expect(run(FORMULA)).toEqual(num(85));
  });

  it('盘点项目结束（2026-09-30 北京时间）之后才结束的活动不计', () => {
    const run = runWith({
      survey360: {
        'emp-1': [
          activity('2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 66),
          activity('2026-09-01T00:00:00Z', '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', 99),
        ],
      },
    });
    expect(run(FORMULA)).toEqual(num(66));
  });
});

describe('AC-EXP-16 排名（🟡 DEC-262①）：并列同名次、后续跳号；百分位并列同值；待办触发时不计算', () => {
  const ports: InMemoryPortData = {
    ranking: [
      { id: 'a', fields: { '盘点对象.得分': 90 } },
      { id: 'b', fields: { '盘点对象.得分': 90 } },
      { id: 'c', fields: { '盘点对象.得分': 80 } },
      { id: 'd', fields: { '盘点对象.得分': 70 } },
    ],
  };
  const rank = (subjectId: string, mode: string) =>
    runWith(ports, subjectId)(`获取某个结果在指定人员范围内的排名("${mode}", 盘点对象.得分)`);

  it('排序号 1、1、3、4', () => {
    expect(['a', 'b', 'c', 'd'].map((id) => rank(id, '排序号'))).toEqual([num(1), num(1), num(3), num(4)]);
  });

  it('百分位 = 名次 / 人数 × 100：25、25、75、100（并列同值）', () => {
    expect(['a', 'b', 'c', 'd'].map((id) => rank(id, '百分位'))).toEqual([num(25), num(25), num(75), num(100)]);
  });

  it('函数元数据标记“在待办中触发计算时不计算”，供 R3-T04 调度使用；其他函数没有该标记', () => {
    const registry = createDefaultRegistry();
    expect(registry.resolve('获取某个结果在指定人员范围内的排名')?.skipInTodoTrigger).toBe(true);
    const others = registry.list().filter((spec) => spec.name !== 'Ranking');
    expect(others.filter((spec) => spec.skipInTodoTrigger)).toEqual([]);
  });
});

describe('AC-EXP-16 测评：面板名“获取当前人员测评测验下的最近一次测评得分/维度得分”', () => {
  const run = runWith({
    assessment: {
      'emp-1': [
        {
          testedAt: new Date('2026-08-01T00:00:00Z'),
          fields: { 测验名称: 'T', 总分: 3.2, 维度名称: 'D', 维度得分: 4 },
        },
      ],
    },
  });

  it('名字里的“/”不当除号；与 LastestAssessmentCent 同义', () => {
    expect(run('获取当前人员测评测验下的最近一次测评得分/维度得分(测验信息.总分, 测验信息.测验名称="T")')).toEqual(
      num(3.2),
    );
    expect(run('获取当前人员测评测验下的最近一次测评得分/维度得分 (测验信息.维度得分, 测验信息.维度名称="D")')).toEqual(
      num(4),
    );
    expect(run('LastestAssessmentCent(测验信息.总分, 测验信息.测验名称="T") / 2')).toEqual(num(1.6));
  });
});

describe('AC-EXP-16 获取最近一次人才评定数据：只取已通过的评定，按通过时间倒序（数据源 R3-T02 接线）', () => {
  const review = (passed: boolean, passedAt: string, fields: Record<string, PlainValue>) => ({
    passed,
    passedAt: new Date(passedAt),
    fields,
  });
  const ports: InMemoryPortData = {
    talentReview: {
      'emp-1': [
        review(true, '2025-12-01T00:00:00Z', { 活动名称: '2025 评定', 得分: 80, 等级: '良好' }),
        review(true, '2026-06-01T00:00:00Z', { 活动名称: '2026 评定', 得分: 88, 等级: '优秀' }),
        review(false, '2026-09-01T00:00:00Z', { 活动名称: '2026 补评', 得分: 95, 等级: '卓越' }),
      ],
    },
  };
  const run = runWith(ports);

  it('中英文名；未通过的评定不计', () => {
    expect(run('获取最近一次人才评定数据(人才评定.得分)')).toEqual(num(88));
    expect(run('LastestTalentReview(人才评定.等级)')).toEqual(text('优秀'));
  });

  it('可加过滤条件；过滤后没有记录返回空', () => {
    expect(run('获取最近一次人才评定数据(人才评定.得分, 人才评定.活动名称="2025 评定")')).toEqual(num(80));
    expect(run('获取最近一次人才评定数据(人才评定.得分, 人才评定.活动名称="不存在")')).toEqual(EMPTY);
  });

  it('数据源未接入 → DATA_UNAVAILABLE；查看人无权 → DATA_FORBIDDEN（结构化原因，不含取数结果）', () => {
    expect(runWith({})('获取最近一次人才评定数据(人才评定.得分)')).toMatchObject({
      code: 'DATA_UNAVAILABLE',
      message: expect.stringContaining('人才评定'),
    });
    const forbidden = runWith({ ...ports, forbidden: { talentReview: ['emp-1'] } });
    const failure = forbidden('获取最近一次人才评定数据(人才评定.得分)');
    expect(failure).toMatchObject({ code: 'DATA_FORBIDDEN' });
    expect(JSON.stringify(failure)).not.toContain('88');
  });

  it('分数字段须是 人才评定 的字段', () => {
    expect(run('获取最近一次人才评定数据(盘点对象.得分)')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});

describe('AC-EXP-16 获取人事子集的指定字段数据：须取到唯一值（数据源后续任务接线）', () => {
  const ports: InMemoryPortData = {
    personnelSubset: {
      'emp-1': {
        教育经历: [
          { fields: { 学历: '本科', 是否最高学历: '是', 学校: '甲大学' } },
          { fields: { 学历: '高中', 是否最高学历: '否', 学校: '乙中学' } },
        ],
      },
    },
  };
  const run = runWith(ports);

  it('中英文名；按过滤取到唯一一行', () => {
    expect(run('获取人事子集的指定字段数据(教育经历.学校, 教育经历.是否最高学历="是")')).toEqual(text('甲大学'));
    expect(run('PersonnelSubsetField(教育经历.学历, 教育经历.学校="乙中学")')).toEqual(text('高中'));
  });

  it('取不到返回空；取到多行 → AMBIGUOUS_DATA', () => {
    expect(run('获取人事子集的指定字段数据(教育经历.学校, 教育经历.学历="博士")')).toEqual(EMPTY);
    expect(run('获取人事子集的指定字段数据(教育经历.学校)')).toMatchObject({ code: 'AMBIGUOUS_DATA' });
  });

  it('数据源未接入 → DATA_UNAVAILABLE', () => {
    expect(runWith({})('获取人事子集的指定字段数据(教育经历.学校)')).toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('第一个参数须是 子集.字段', () => {
    expect(run('获取人事子集的指定字段数据("学校")')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});

describe('AC-EXP-16 按照参数规则获取数据：参数口径待取证（#105），只做端口与桩', () => {
  it('数据源未接入 → DATA_UNAVAILABLE（中英文名）', () => {
    expect(runWith({})('按照参数规则获取数据()')).toMatchObject({ code: 'DATA_UNAVAILABLE' });
    expect(runWith({})('ParameterRuleData("规则A", 1)')).toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });

  it('接入端口后按参数取值', () => {
    const run = runWith({
      parameterRule: (subjectId, parameters) =>
        subjectId === 'emp-1' && parameters[0]?.kind === 'text' ? `${parameters[0].value}-值` : null,
    });
    expect(run('按照参数规则获取数据("规则A")')).toEqual(text('规则A-值'));
    expect(run('ParameterRuleData()')).toEqual(EMPTY);
  });
});
