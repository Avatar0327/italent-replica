/**
 * AC-EV-conditions 参评条件纯函数（R3-T02 设计 §3.2 / §10 表达式行、EV-R10 / EV-R11；拆分方案 B2）：
 * 明细 9 种运算符的取值形状；组合表达式用 R3-T00 的 validateFormula 校验，只能引用存在的条件序号（条件1…条件n）。
 * 本 PR 不按人员求值（求值在 C2）。
 */
import {
  ACTIVITY_CONDITION_OPERATORS,
  activityConditionField,
  evaluateFormula,
  inMemorySubject,
  validateActivityConditionDetails,
  validateActivityConditionExpression,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';

const detail = (seq: number, operator: string, value1?: string | number | null, value2?: string | number | null) => ({
  seq,
  operator,
  value1,
  value2,
});

describe('AC-EV-conditions 明细运算符（9 种 🟢）', () => {
  it('运算符全集：等于、不等于、大于、小于、大于等于、小于等于、为空、不为空、范围', () => {
    expect([...ACTIVITY_CONDITION_OPERATORS].sort()).toEqual(
      ['between', 'eq', 'ge', 'gt', 'is_empty', 'le', 'lt', 'ne', 'not_empty'].sort(),
    );
  });

  it('合法形状：比较类要 value1；为空 / 不为空不带值；范围要 value1 与 value2', () => {
    const details = [
      detail(1, 'ge', 99),
      detail(2, 'eq', '教师'),
      detail(3, 'is_empty'),
      detail(4, 'not_empty', null, null),
      detail(5, 'between', 1, 5),
      detail(6, 'le', '2026-09-15'),
    ];
    expect(validateActivityConditionDetails(details)).toEqual({ ok: true });
  });

  it.each(['eq', 'ne', 'gt', 'lt', 'ge', 'le'])(
    '%s 缺 value1 → VALUE_REQUIRED；多给 value2 → VALUE_NOT_ALLOWED',
    (op) => {
      expect(validateActivityConditionDetails([detail(1, op)])).toEqual({
        ok: false,
        issues: [{ seq: 1, code: 'VALUE_REQUIRED' }],
      });
      expect(validateActivityConditionDetails([detail(1, op, '', null)])).toEqual({
        ok: false,
        issues: [{ seq: 1, code: 'VALUE_REQUIRED' }],
      });
      expect(validateActivityConditionDetails([detail(1, op, 1, 2)])).toEqual({
        ok: false,
        issues: [{ seq: 1, code: 'VALUE_NOT_ALLOWED' }],
      });
    },
  );

  it.each(['is_empty', 'not_empty'])('%s 不接受任何值', (op) => {
    expect(validateActivityConditionDetails([detail(1, op, 1)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'VALUE_NOT_ALLOWED' }],
    });
    expect(validateActivityConditionDetails([detail(1, op, null, 2)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'VALUE_NOT_ALLOWED' }],
    });
  });

  it('范围缺一端 → VALUE_REQUIRED；数字上下界颠倒 → RANGE_INVERTED；相等允许', () => {
    expect(validateActivityConditionDetails([detail(1, 'between', 1)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'VALUE_REQUIRED' }],
    });
    expect(validateActivityConditionDetails([detail(1, 'between', 5, 1)])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'RANGE_INVERTED' }],
    });
    expect(validateActivityConditionDetails([detail(1, 'between', 3, 3)])).toEqual({ ok: true });
  });

  it('未知运算符 → OPERATOR_INVALID；序号须为正整数且不重复', () => {
    expect(validateActivityConditionDetails([detail(1, 'like', 'x')])).toEqual({
      ok: false,
      issues: [{ seq: 1, code: 'OPERATOR_INVALID' }],
    });
    expect(validateActivityConditionDetails([detail(0, 'is_empty'), detail(1.5, 'is_empty')])).toEqual({
      ok: false,
      issues: [
        { seq: 0, code: 'SEQ_INVALID' },
        { seq: 1.5, code: 'SEQ_INVALID' },
      ],
    });
    expect(validateActivityConditionDetails([detail(2, 'is_empty'), detail(2, 'not_empty')])).toEqual({
      ok: false,
      issues: [{ seq: 2, code: 'SEQ_DUPLICATE' }],
    });
  });

  it('没有明细也合法（不设条件则不校验，EV-R10）', () => {
    expect(validateActivityConditionDetails([])).toEqual({ ok: true });
  });
});

describe('AC-EV-conditions 组合表达式：只引用存在的序号（validateFormula）', () => {
  const seqs = [1, 2, 3];

  it('字段名 = 条件 + 序号', () => {
    expect(activityConditionField(2)).toBe('条件2');
  });

  it('合法表达式返回去重后的引用序号', () => {
    expect(validateActivityConditionExpression('条件1 and (条件2 or 条件3)', seqs)).toEqual({
      ok: true,
      referencedSeqs: [1, 2, 3],
    });
    expect(validateActivityConditionExpression('条件1 and 条件1', seqs)).toEqual({ ok: true, referencedSeqs: [1] });
    expect(validateActivityConditionExpression('条件3 且 not 条件2', seqs)).toMatchObject({
      ok: true,
      referencedSeqs: [3, 2],
    });
  });

  it('引用不存在的序号 → CONDITION_SEQ_UNKNOWN，带行列', () => {
    const result = validateActivityConditionExpression('条件1 and 条件9', seqs);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'CONDITION_SEQ_UNKNOWN', line: 1, column: 9 }] });
  });

  it('引用条件以外的字段 → CONDITION_SEQ_UNKNOWN（不借表达式读别的数据）', () => {
    expect(validateActivityConditionExpression('员工.年龄 > 30', seqs)).toMatchObject({
      ok: false,
      errors: [{ code: 'CONDITION_SEQ_UNKNOWN' }],
    });
  });

  it('语法错误 → EXPRESSION_SYNTAX', () => {
    expect(validateActivityConditionExpression('条件1 and (条件2', seqs)).toMatchObject({
      ok: false,
      errors: [{ code: 'EXPRESSION_SYNTAX' }],
    });
    expect(validateActivityConditionExpression('条件1 and', seqs)).toMatchObject({ ok: false });
  });

  it('空白表达式 → EXPRESSION_EMPTY（是否允许不设表达式由调用方决定）', () => {
    expect(validateActivityConditionExpression('   ', seqs)).toEqual({
      ok: false,
      errors: [{ code: 'EXPRESSION_EMPTY' }],
    });
  });

  it('没有任何明细时，任何序号引用都不存在', () => {
    expect(validateActivityConditionExpression('条件1', [])).toMatchObject({
      ok: false,
      errors: [{ code: 'CONDITION_SEQ_UNKNOWN' }],
    });
  });

  // 第 2 轮 P2-01：表达式引擎对取数函数参数里的记录字段不查字段目录，必须在本函数复核全部引用
  it('取数函数参数里的记录字段不得绕过条件序号白名单', () => {
    const bypass = '条件1 and PerformanceLastCent(1, 考核结果.年度 = 2026) > 0';
    const result = validateActivityConditionExpression(bypass, seqs);
    expect(result.ok).toBe(false);
    const codes = result.ok ? [] : result.errors.map((error) => error.code);
    expect(codes).toContain('CONDITION_SEQ_UNKNOWN');
    expect(validateActivityConditionExpression('PerformanceLastCent(1, 考核结果.年度 = 2026) > 0', [])).toMatchObject({
      ok: false,
    });
  });

  it('取数函数即使不带字段也不允许（表达式只组合条件，不另取数）', () => {
    expect(validateActivityConditionExpression('条件1 and PerformanceLastCent(1) > 0', seqs)).toMatchObject({
      ok: false,
      errors: [{ code: 'EXPRESSION_FUNCTION_NOT_ALLOWED' }],
    });
  });

  // 第 2 轮 P3-02：条件序号是布尔字段，类型参与保存校验，先校验再求值不会到 TYPE_CONVERSION
  it('把条件当日期用在日期函数上，保存时就拒绝', () => {
    expect(validateActivityConditionExpression('Year(条件1) > 2020', seqs)).toMatchObject({
      ok: false,
      errors: [{ code: 'EXPRESSION_SYNTAX' }],
    });
  });

  it('校验过的表达式能交给 evaluateFormula 以条件序号为布尔字段求值（C2 用法的衔接）', () => {
    const subject = inMemorySubject('e1', { 条件1: true, 条件2: false, 条件3: true });
    const calendar = { today: '2026-10-09', timeZone: 'Asia/Shanghai' };
    const result = evaluateFormula('条件1 and (条件2 or 条件3)', { subject, calendar });
    expect(result).toEqual({ ok: true, value: { kind: 'boolean', value: true } });
  });
});

// 第 3 轮 P2-R2-01（Opus 接手，DEC-338⑤）：设计 §6.1“明细负责取数、组合式只组合已计算的条件”。
// recordObjects 只表示参数里的记录字段作用域，不是“访问外部数据”的标记；改为组合式允许的纯函数白名单。
describe('AC-EV-conditions 组合表达式：只允许纯组合函数（第 3 轮 P2-R2-01）', () => {
  const seqs = [1, 2, 3];
  const rejected = (expression: string) => {
    const result = validateActivityConditionExpression(expression, seqs);
    expect(result.ok, expression).toBe(false);
    const codes = result.ok ? [] : result.errors.map((error) => error.code);
    expect(codes, expression).toContain('EXPRESSION_FUNCTION_NOT_ALLOWED');
  };

  it('按参数规则取数（含中文别名）不允许', () => {
    rejected('条件1 and ParameterRuleData("合成参数") = 1');
    rejected('条件1 and 按照参数规则获取数据("合成参数") = 1');
  });

  it('评定结果类函数不允许：模块结果、模块数、模块评委平均分、评委数、评委平均分（含中文别名）', () => {
    rejected('条件1 and ModuleResult("模块A") = "通过"');
    rejected('条件1 and CountModulesWithResult("通过") > 0');
    rejected('条件1 and ModuleJudgeAverage("模块A") > 0');
    rejected('条件1 and CountJudgesWithResult("通过") > 0');
    rejected('条件1 and JudgeAverage() > 0');
    rejected('条件1 and 所有评委平均分() > 0');
  });

  it('排名不允许，包括经 Def 数值变量满足参数检查的写法', () => {
    rejected('Def(x, ToNumber(条件1)); 条件1 and Ranking("排序号", x) > 0');
    rejected('Def(x, ToNumber(条件1)); 条件1 and 排名("排序号", x) > 0');
  });

  it('Def 绑定里的取数函数同样拦截', () => {
    rejected('Def(y, JudgeAverage()); 条件1 and y > 0');
    rejected('定义(y, ParameterRuleData("合成参数")); 条件1 and y = 1');
  });

  it('依赖运行环境的日期函数也不在白名单（组合式只看已计算的条件）', () => {
    rejected('条件1 and Today() > ToDate("2026-01-01")');
  });

  it('白名单内的纯函数照常通过：逻辑、IF、IN、类型转换、取余', () => {
    for (const expression of [
      'AND(条件1, OR(条件2, 条件3))',
      'IF(条件1, 条件2, 条件3)',
      'ToNumber(条件1) + ToNumber(条件2) + ToNumber(条件3) >= 2',
      'Mod(ToNumber(条件1) + ToNumber(条件2), 2) = 1',
      'Def(n, ToNumber(条件1) + ToNumber(条件2)); n >= 1 and 条件3',
    ]) {
      expect(validateActivityConditionExpression(expression, seqs).ok, expression).toBe(true);
    }
  });
});
