/**
 * AC-EXP-07～11：取数函数经端口接入（引擎不查库）：绩效、360、测评（DEC-031 / 210）、排名、评定专用函数（EV-R8），
 * 以及端口无权 / 取不到时的失败原因与不泄露（`26` §3.5、§8.2；REQ-EXP-001）。
 */
import { evaluateFormula, type EvaluationContext, type EvaluationResult, type InMemoryPortData } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const perf = (
  year: number | string,
  period: string,
  score: number | null,
  grade: string | null,
  modifiedAt: string,
) => ({
  fields: { 年度: year, 周期名称: period, 得分: score, 等级: grade },
  modifiedAt: new Date(modifiedAt),
});

describe('AC-EXP-07 绩效取数：同年同周期取最后修改；PerformanceLastCent(N) 不要求连续年份；无结果返回空', () => {
  const ports: InMemoryPortData = {
    performance: {
      'emp-1': [
        perf(2026, '年度', 70, 'B', '2026-07-01T00:00:00Z'),
        perf('2026', '年度', 88, 'A', '2026-08-01T00:00:00Z'),
        perf(2026, '上半年', 60, 'C', '2026-08-02T00:00:00Z'),
        perf(2019, '年度', 81, 'B', '2020-01-01T00:00:00Z'),
        perf(2017, '年度', 77, 'B', '2018-01-01T00:00:00Z'),
      ],
    },
  };
  const run = (formula: string, subjectId = 'emp-1') =>
    valueOf(evaluateFormula(formula, contextFor({}, { ports, subjectId })));

  it('PerformanceCent / PerformanceGrade：年度、周期必填，其他过滤选填，同年同周期多条取最后修改', () => {
    expect(run('PerformanceCent(考核结果.年度="2026", 考核结果.周期名称="年度")')).toEqual({
      kind: 'number',
      value: 88,
    });
    expect(run('获取指定年度指定周期的绩效等级(考核结果.年度=2026, 考核结果.周期名称="年度")')).toEqual({
      kind: 'text',
      value: 'A',
    });
    expect(run('PerformanceCent(考核结果.年度=2026, 考核结果.周期名称="年度", 考核结果.等级="B")')).toEqual({
      kind: 'number',
      value: 70,
    });
  });

  it('AC-TR-11：PerformanceLastCent(2)，员工有 2019、2017 年绩效，项目结束于 2020-09 → 2017 年得分', () => {
    const context: EvaluationContext = {
      ...contextFor({}, { ports }),
      project: { startAt: new Date('2020-08-01T00:00:00Z'), endAt: new Date('2020-09-30T00:00:00Z') },
    };
    expect(valueOf(evaluateFormula('PerformanceLastCent(2)', context))).toEqual({ kind: 'number', value: 77 });
    expect(valueOf(evaluateFormula('获取最近第N年度的绩效等级(1)', context))).toEqual({ kind: 'text', value: 'B' });
    expect(valueOf(evaluateFormula('PerformanceLastCent(3)', context))).toEqual({ kind: 'empty' });
  });

  it('无结果返回空而不是 0；空值再比较大小结果为假、不报错（DEC-257）', () => {
    expect(run('PerformanceCent(考核结果.年度=2025, 考核结果.周期名称="年度")')).toEqual({ kind: 'empty' });
    expect(run('PerformanceCent(考核结果.年度=2025, 考核结果.周期名称="年度") > 60')).toEqual({
      kind: 'boolean',
      value: false,
    });
  });
});

describe('AC-EXP-08 360 与测评：最近一次的时间口径', () => {
  const row = (startAt: string, fields: Record<string, string | number | null>) => ({
    startAt: new Date(startAt),
    fields,
  });
  const assessment = (testedAt: string, fields: Record<string, string | number | null>) => ({
    testedAt: new Date(testedAt),
    fields,
  });
  const ports: InMemoryPortData = {
    survey360: {
      'emp-1': [
        row('2026-03-01T00:00:00Z', {
          套卷名称: 'GLD套卷',
          活动名称: '春季',
          角色名称: '上级',
          角色得分: 3.5,
          '问卷-他评总分': 3.8,
        }),
        row('2026-09-10T00:00:00Z', {
          套卷名称: 'GLD套卷',
          活动名称: '秋季',
          角色名称: '上级',
          角色得分: 4.2,
          '问卷-他评总分': 4.0,
        }),
        row('2026-09-10T00:00:00Z', {
          套卷名称: 'GLD套卷',
          活动名称: '秋季',
          角色名称: '同事',
          角色得分: 4.6,
          '问卷-他评总分': 4.0,
        }),
        row('2026-10-02T00:00:00Z', {
          套卷名称: 'GLD套卷',
          活动名称: '冬季',
          角色名称: '上级',
          角色得分: 4.9,
          '问卷-他评总分': 4.9,
        }),
      ],
    },
    assessment: {
      'emp-1': [
        assessment('2026-08-15T00:00:00Z', {
          测验名称: '职业性格',
          维度名称: '总体',
          总分: 0.82,
          维度得分: 0.82,
          来源: '导入',
        }),
        assessment('2026-09-15T00:00:00Z', {
          测验名称: '职业性格',
          维度名称: '总体',
          总分: 0.9,
          维度得分: 0.9,
          来源: '导入',
        }),
      ],
    },
  };
  const run = (formula: string, extra: Partial<EvaluationContext> = {}) =>
    valueOf(evaluateFormula(formula, { ...contextFor({}, { ports }), ...extra }));

  it('Lastest360Cent：取盘点项目结束时间前最近开始的活动，分数字段 + 过滤表达式', () => {
    expect(run('获取最近一次360总分(360结果.角色得分, 360结果.套卷名称="GLD套卷", 360结果.角色名称="上级")')).toEqual({
      kind: 'number',
      value: 4.2,
    });
    expect(run('Lastest360Cent(360结果.问卷-他评总分)')).toEqual({ kind: 'number', value: 4.0 });
    expect(run('Lastest360Cent(360结果.角色得分, 360结果.角色名称="下级")')).toEqual({ kind: 'empty' });
  });

  it('LastestAssessmentCent：过滤必填；默认取项目结束时间前最近一次，可改为开始时间前（DEC-031）', () => {
    const formula = 'LastestAssessmentCent(测验信息.总分, 测验信息.测验名称="职业性格")';
    expect(run(formula)).toEqual({ kind: 'number', value: 0.9 });
    expect(run(formula, { assessmentLatestWindow: 'before_project_start' })).toEqual({ kind: 'number', value: 0.82 });
    expect(run('获取最近一次的测评总分(测验信息.维度得分, 测验信息.维度名称="不存在")')).toEqual({ kind: 'empty' });
    expect(run('LastestAssessmentCent(测验信息.总分)')).toMatchObject({ code: 'ARGUMENT_COUNT' });
  });
});

describe('AC-EXP-09 Ranking：百分位 / 排序号、排序字段、人员范围、分组字段；范围外人员不出值', () => {
  const member = (id: string, score: number, grade: string) => ({
    id,
    fields: { '盘点对象.综合得分': score, '任职记录.职级': grade },
  });
  const ports: InMemoryPortData = {
    ranking: [
      member('a', 90, 'P7'),
      member('b', 80, 'P7'),
      member('c', 80, 'P7'),
      member('d', 70, 'P7'),
      member('e', 99, 'P8'),
    ],
  };
  const run = (formula: string, subjectId: string) =>
    valueOf(
      evaluateFormula(formula, contextFor({ '盘点对象.综合得分': 80, '任职记录.职级': 'P7' }, { ports, subjectId })),
    );

  it('排序号：降序、并列同名次；分组字段按组内排名', () => {
    expect(run('Ranking("排序号", 盘点对象.综合得分)', 'b')).toEqual({ kind: 'number', value: 3 });
    expect(run('Ranking("排序号", 盘点对象.综合得分, 任职记录.职级 = "P7", 任职记录.职级)', 'b')).toEqual({
      kind: 'number',
      value: 2,
    });
    expect(run('获取某个结果在指定人员范围内的排名("排序号", 盘点对象.综合得分)', 'e')).toEqual({
      kind: 'number',
      value: 1,
    });
  });

  it('百分位：按小数返回（名次之后占比）', () => {
    expect(run('Ranking("百分位", 盘点对象.综合得分)', 'd')).toEqual({ kind: 'number', value: 0.2 });
    expect(run('Ranking("百分位", 盘点对象.综合得分)', 'e')).toEqual({ kind: 'number', value: 1 });
  });

  it('范围外人员：失败原因 OUT_OF_SCOPE', () => {
    expect(run('Ranking("排序号", 盘点对象.综合得分, 任职记录.职级 = "P8")', 'b')).toMatchObject({
      code: 'OUT_OF_SCOPE',
    });
    expect(run('Ranking("排序号", 盘点对象.综合得分)', 'zz')).toMatchObject({ code: 'OUT_OF_SCOPE' });
  });
});

describe('AC-EXP-10 盘点与评定专用函数（EV-R8：弃权评委不参与）', () => {
  const judge = (id: string, score: number | null, result: string | null, abstained = false) => ({
    id,
    score,
    result,
    abstained,
  });
  const ports: InMemoryPortData = {
    review: {
      'emp-1': [
        {
          name: '专业能力',
          score: 85,
          result: '通过',
          judges: [judge('j1', 90, '通过'), judge('j2', 80, '通过'), judge('j3', null, null, true)],
        },
        { name: '通用能力', score: 55, result: '不通过', judges: [judge('j1', 60, '通过'), judge('j2', 50, '不通过')] },
      ],
    },
  };
  const run = (formula: string) => valueOf(evaluateFormula(formula, contextFor({}, { ports })));

  it('取模块分或结果、统计指定结果的模块数', () => {
    expect(run('取模块分或结果("专业能力", "得分")')).toEqual({ kind: 'number', value: 85 });
    expect(run('ModuleResult("通用能力", "结果")')).toEqual({ kind: 'text', value: '不通过' });
    expect(run('统计指定结果的模块数("通过")')).toEqual({ kind: 'number', value: 1 });
    expect(run('CountModulesWithResult("不通过")')).toEqual({ kind: 'number', value: 1 });
  });

  it('指定模块所有评委平均分、统计指定得分或结果的评委数、所有评委平均分（弃权不参与）', () => {
    expect(run('指定模块所有评委平均分("专业能力")')).toEqual({ kind: 'number', value: 85 });
    expect(run('ModuleJudgeAverage("通用能力")')).toEqual({ kind: 'number', value: 55 });
    expect(run('统计指定得分或结果的评委数("通过")')).toEqual({ kind: 'number', value: 3 });
    expect(run('CountJudgesWithResult(90, "专业能力")')).toEqual({ kind: 'number', value: 1 });
    expect(run('所有评委平均分()')).toEqual({ kind: 'number', value: 70 });
    expect(run('JudgeAverage()')).toEqual({ kind: 'number', value: 70 });
  });
});

describe('AC-EXP-11 端口无权 / 取不到：返回空或明确失败原因，不泄露隐藏字段的取数结果', () => {
  it('查看人无字段权限：FIELD_FORBIDDEN，失败信息不含字段值', () => {
    const context = contextFor({ '盘点对象.薪酬': 123456 }, { forbidden: ['盘点对象.薪酬'] });
    const result = evaluateFormula('盘点对象.薪酬 > 100000', context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('FIELD_FORBIDDEN');
    expect(JSON.stringify(result.failure)).not.toContain('123456');
  });

  it('端口拒绝（无权）与不可用分别给出 DATA_FORBIDDEN / DATA_UNAVAILABLE', () => {
    const forbidden = contextFor({}, { ports: { performance: {}, forbidden: { performance: ['emp-1'] } } });
    expect(
      valueOf(evaluateFormula('PerformanceCent(考核结果.年度=2026, 考核结果.周期名称="年度")', forbidden)),
    ).toMatchObject({
      code: 'DATA_FORBIDDEN',
    });
    const unavailable = contextFor({}, { ports: { unavailable: ['survey360'] } });
    expect(valueOf(evaluateFormula('Lastest360Cent(360结果.角色得分)', unavailable))).toMatchObject({
      code: 'DATA_UNAVAILABLE',
    });
  });

  it('没有接入对应端口：DATA_UNAVAILABLE 而不是异常', () => {
    expect(valueOf(evaluateFormula('所有评委平均分()', contextFor({})))).toMatchObject({ code: 'DATA_UNAVAILABLE' });
  });
});
