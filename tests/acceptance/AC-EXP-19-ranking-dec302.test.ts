/**
 * AC-EXP-19（F-045，AC-EXP 补）：排名函数对齐原站口径（DEC-302 / DEC-304，`26` §8.6、§8.10，手册 246809263）。
 * 参数按原站 5 个：模式（"百分位" / 排序号）、排序字段、数据范围、排名范围条件 ×2；兼容 2～4 参旧写法。
 * 降序竞争排名（1、1、3）；百分位 = 名次 ÷ 参与人数 × 100，保留两位小数，第 1 名最小；空值不参与、不计数，
 * 自身结果为空；范围可限定到单个项目；排名在全体计算对象上一次性求值，分批调用结果一致（DEC-301②）。
 * 参与排名的人员集合由调用方经端口传入（R3-T04），函数内不做权限裁剪。
 */
import {
  createDefaultRegistry,
  createInMemoryPorts,
  evaluateBatch,
  evaluateFormula,
  inMemorySubject,
  validateFormula,
  type ComputationItem,
  type EvaluationResult,
  type InMemoryRankingMember,
  type PlainValue,
  type StaticKind,
  type SubjectReader,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { CALENDAR, PROJECT, contextFor } from './AC-EXP-support.js';

const valueOf = (result: EvaluationResult) => (result.ok ? result.value : result.failure);
const num = (value: number) => ({ kind: 'number', value });
/** 排名取不到值：空值带数值来源类型（同 AC-EXP-17）。 */
const EMPTY_NUMBER = { kind: 'empty', of: 'number' };

const SCORE = '盘点对象.价值观本人评分';
const PROJECT_NAME = '盘点活动.项目名称';
const PLAN = '盘点对象.盘点方案';

const member = (id: string, score: PlainValue, extra: Record<string, PlainValue> = {}): InMemoryRankingMember => ({
  id,
  fields: { [SCORE]: score, [PROJECT_NAME]: 'PRJ_02', [PLAN]: '方案一', ...extra },
});

/** 以 subjectId 为本人求值；本人字段取自范围成员（同一对象）。 */
function rankOf(members: readonly InMemoryRankingMember[], formula: string, subjectId: string) {
  const self = members.find((m) => m.id === subjectId);
  const context = contextFor({ ...(self?.fields ?? {}) }, { ports: { ranking: members }, subjectId });
  return valueOf(evaluateFormula(formula, context));
}

const ranks = (members: readonly InMemoryRankingMember[], formula: string) =>
  members.map((m) => rankOf(members, formula, m.id));

/** `26` §8.10 原站实测的公式：第 3 参数限定单个项目、第 4 参数按盘点方案。 */
const SITE = (mode: string) =>
  `获取某个结果在指定人员范围内的排名("${mode}", ${SCORE}, ${PROJECT_NAME}="PRJ_02", ${PLAN})`;

describe('AC-EXP-19 原站实测三轮（`26` §8.10，W-622～633）', () => {
  it('① 全体并列 1,1,1,1,1：排序号全部 1，百分位全部 20', () => {
    const members = ['a', 'b', 'c', 'd', 'e'].map((id) => member(id, 1));
    expect(ranks(members, SITE('排序号'))).toEqual(Array(5).fill(num(1)));
    expect(ranks(members, SITE('百分位'))).toEqual(Array(5).fill(num(20)));
  });

  it('② 部分并列 28,28,1,1,1：竞争排名 1、1、3（跳号），百分位 20、20、60', () => {
    const members = [member('a', 28), member('b', 28), member('c', 1), member('d', 1), member('e', 1)];
    expect(ranks(members, SITE('排序号'))).toEqual([num(1), num(1), num(3), num(3), num(3)]);
    expect(ranks(members, SITE('百分位'))).toEqual([num(20), num(20), num(60), num(60), num(60)]);
  });

  it('③ 含空值 空,空,1,1,1：空值不参与、不计数，自身结果为空（不是计算失败）；百分位 33.33', () => {
    const members = [member('a', null), member('b', null), member('c', 1), member('d', 1), member('e', 1)];
    expect(ranks(members, SITE('排序号'))).toEqual([EMPTY_NUMBER, EMPTY_NUMBER, num(1), num(1), num(1)]);
    expect(ranks(members, SITE('百分位'))).toEqual([EMPTY_NUMBER, EMPTY_NUMBER, num(33.33), num(33.33), num(33.33)]);
  });

  it('空字符串同样按空值：不参与、不计数，自身为空', () => {
    const members = [member('a', ''), member('b', 90), member('c', 80)];
    expect(ranks(members, SITE('排序号'))).toEqual([EMPTY_NUMBER, num(1), num(2)]);
    expect(ranks(members, SITE('百分位'))).toEqual([EMPTY_NUMBER, num(50), num(100)]);
  });
});

describe('AC-EXP-19 百分位：名次 ÷ 参与人数 × 100，保留两位小数，第 1 名最小（不是统计学百分位）', () => {
  it('3 人：33.33、66.67、100（四舍五入到两位）', () => {
    const members = [member('a', 30), member('b', 20), member('c', 10)];
    expect(ranks(members, SITE('百分位'))).toEqual([num(33.33), num(66.67), num(100)]);
  });

  it('手册示例：2 人 50、100；4 人 25、50、75、100', () => {
    expect(ranks([member('a', 9), member('b', 3)], SITE('百分位'))).toEqual([num(50), num(100)]);
    const four = [member('a', 4), member('b', 3), member('c', 2), member('d', 1)];
    expect(ranks(four, SITE('百分位'))).toEqual([num(25), num(50), num(75), num(100)]);
  });

  it('7 人：名次 1～7 → 14.29、28.57、42.86、57.14、71.43、85.71、100', () => {
    const members = [70, 60, 50, 40, 30, 20, 10].map((score, i) => member(`m${i}`, score));
    expect(ranks(members, SITE('百分位'))).toEqual(
      [14.29, 28.57, 42.86, 57.14, 71.43, 85.71, 100].map((value) => num(value)),
    );
  });

  it('恰好落在第三位 5 时按四舍五入（1 / 8 × 100 = 12.5；1 / 32 × 100 = 3.125 → 3.13）', () => {
    const eight = Array.from({ length: 8 }, (_, i) => member(`m${i}`, 100 - i));
    expect(rankOf(eight, SITE('百分位'), 'm0')).toEqual(num(12.5));
    const many = Array.from({ length: 32 }, (_, i) => member(`m${i}`, 100 - i));
    expect(rankOf(many, SITE('百分位'), 'm0')).toEqual(num(3.13));
  });

  it('参与人数只数通过范围且排序字段非空的人：本组 3 人中一人为空 → 50、100', () => {
    const members = [member('a', 9), member('b', null), member('c', 3)];
    expect(ranks(members, SITE('百分位'))).toEqual([num(50), EMPTY_NUMBER, num(100)]);
  });
});

describe('AC-EXP-19 人员范围可限定到单个项目（DEC-302）', () => {
  const members = [
    member('p1-a', 80, { [PROJECT_NAME]: 'PRJ_01' }),
    member('p1-b', 60, { [PROJECT_NAME]: 'PRJ_01' }),
    member('p2-a', 99, { [PROJECT_NAME]: 'PRJ_02' }),
    member('p2-b', 70, { [PROJECT_NAME]: 'PRJ_02' }),
    member('p2-c', 50, { [PROJECT_NAME]: 'PRJ_02' }),
  ];

  it('其余项目的对象不计入名次与人数', () => {
    const formula = `Ranking("排序号", ${SCORE}, ${PROJECT_NAME}="PRJ_02")`;
    expect(rankOf(members, formula, 'p2-b')).toEqual(num(2));
    expect(rankOf(members, `Ranking("百分位", ${SCORE}, ${PROJECT_NAME}="PRJ_02")`, 'p2-c')).toEqual(num(100));
    expect(rankOf(members, `Ranking("排序号", ${SCORE}, ${PROJECT_NAME}="PRJ_01")`, 'p1-b')).toEqual(num(2));
  });

  it('本人不在限定的项目内：维持 OUT_OF_SCOPE（DEC-299 Q2）', () => {
    expect(rankOf(members, `Ranking("排序号", ${SCORE}, ${PROJECT_NAME}="PRJ_02")`, 'p1-a')).toMatchObject({
      code: 'OUT_OF_SCOPE',
    });
  });

  it('不限定时总体 = 端口给出的全部人员', () => {
    expect(rankOf(members, `Ranking("排序号", ${SCORE})`, 'p1-a')).toEqual(num(2));
  });
});

describe('AC-EXP-19 参数按原站 5 个：模式、排序字段、数据范围、排名范围条件 ×2', () => {
  const GRADE = '任职记录.职级';
  const members = [
    member('a', 90, { [GRADE]: 'P7' }),
    member('b', 85, { [GRADE]: 'P7', [PLAN]: '方案二' }),
    member('c', 80, { [GRADE]: 'P7' }),
    member('d', 70, { [GRADE]: 'P8' }),
    member('e', 60, { [GRADE]: 'P7' }),
    member('x', 99, { [GRADE]: 'P7', [PROJECT_NAME]: 'PRJ_01' }),
  ];
  const FIVE = (mode: string) => `Ranking("${mode}", ${SCORE}, ${PROJECT_NAME}="PRJ_02", ${PLAN}, ${GRADE})`;

  it('注册表：5 个参数，前 2 个必填；中英文名同义', () => {
    const spec = createDefaultRegistry().resolve('获取某个结果在指定人员范围内的排名');
    expect(spec?.name).toBe('Ranking');
    expect(spec?.params.map((param) => [param.name, param.required])).toEqual([
      ['模式', true],
      ['排序字段', true],
      ['数据范围', false],
      ['排名范围条件', false],
      ['排名范围条件', false],
    ]);
  });

  it('5 参保存检查通过；6 参报参数个数', () => {
    expect(validateFormula(FIVE('排序号')).ok).toBe(true);
    expect(validateFormula(`${FIVE('排序号').slice(0, -1)}, ${GRADE})`)).toMatchObject({
      ok: false,
      errors: [{ code: 'ARGUMENT_COUNT' }],
    });
  });

  it('第 4、5 参数是字段引用：与本人取值相同的人员一起排名（方案一 且 P7，项目 PRJ_02）', () => {
    // 方案一 × P7 × PRJ_02：a 90、c 80、e 60
    expect(['a', 'c', 'e'].map((id) => rankOf(members, FIVE('排序号'), id))).toEqual([num(1), num(2), num(3)]);
    expect(rankOf(members, FIVE('百分位'), 'c')).toEqual(num(66.67));
    // d（P8）组内只有自己
    expect(rankOf(members, FIVE('排序号'), 'd')).toEqual(num(1));
  });

  it('第 4、5 参数也可写条件表达式：作为筛选', () => {
    const formula = `Ranking("排序号", ${SCORE}, ${PROJECT_NAME}="PRJ_02", ${PLAN}="方案一", ${GRADE}="P7")`;
    expect(rankOf(members, formula, 'e')).toEqual(num(3));
    expect(rankOf(members, formula, 'd')).toMatchObject({ code: 'OUT_OF_SCOPE' });
  });
});

describe('AC-EXP-19 兼容 2～4 参旧写法（缺省的范围参数 = 不限定）', () => {
  const GRADE = '任职记录.职级';
  const members = [
    member('a', 90, { [GRADE]: 'P7' }),
    member('b', 80, { [GRADE]: 'P7' }),
    member('c', 80, { [GRADE]: 'P7' }),
    member('d', 70, { [GRADE]: 'P7' }),
    member('e', 99, { [GRADE]: 'P8' }),
  ];

  it('2 参 ≡ 5 参不限定范围：总体 = 端口给出的全部人员', () => {
    expect(rankOf(members, `Ranking("排序号", ${SCORE})`, 'b')).toEqual(num(3));
    expect(rankOf(members, `Ranking("百分位", ${SCORE})`, 'b')).toEqual(num(60));
  });

  it('3 参：第 3 参数为条件（数据范围）', () => {
    expect(rankOf(members, `Ranking("排序号", ${SCORE}, ${GRADE}="P7")`, 'b')).toEqual(num(2));
  });

  it('3 参：第 3 参数为字段引用 → 与本人同值的人员', () => {
    expect(rankOf(members, `Ranking("排序号", ${SCORE}, ${GRADE})`, 'd')).toEqual(num(4));
    expect(rankOf(members, `Ranking("排序号", ${SCORE}, ${GRADE})`, 'e')).toEqual(num(1));
  });

  it('4 参（本租户写法）：条件 + 分组字段，结果与对应 5 参一致', () => {
    const four = `Ranking("排序号", ${SCORE}, ${GRADE}="P7", ${GRADE})`;
    const five = `Ranking("排序号", ${SCORE}, ${GRADE}="P7", ${GRADE}, ${PLAN})`;
    expect(members.slice(0, 4).map((m) => rankOf(members, four, m.id))).toEqual([num(1), num(2), num(2), num(4)]);
    expect(members.slice(0, 4).map((m) => rankOf(members, five, m.id))).toEqual([num(1), num(2), num(2), num(4)]);
  });

  it('模式写法：排序号 / 排名 / rank、百分位 / percentile 同义；其他写法计算失败', () => {
    for (const mode of ['排序号', '排名', 'rank', 'RANK']) {
      expect(rankOf(members, `Ranking("${mode}", ${SCORE})`, 'a')).toEqual(num(2));
    }
    for (const mode of ['百分位', 'percentile']) {
      expect(rankOf(members, `Ranking("${mode}", ${SCORE})`, 'a')).toEqual(num(40));
    }
    expect(rankOf(members, `Ranking("名次", ${SCORE})`, 'a')).toMatchObject({ code: 'ARGUMENT_TYPE' });
  });
});

describe('AC-EXP-19 本人的排序字段', () => {
  it('不是数值（非数字文本）：计算失败 TYPE_CONVERSION，不再误报“不满足人员范围条件”', () => {
    const members = [member('a', '缺考'), member('b', 80)];
    expect(rankOf(members, SITE('排序号'), 'a')).toMatchObject({ code: 'TYPE_CONVERSION' });
    expect(rankOf(members, SITE('排序号'), 'b')).toEqual(num(1));
  });

  it('本人无权读取排序字段：FIELD_FORBIDDEN（其他人照常）', () => {
    const members: InMemoryRankingMember[] = [{ ...member('a', 90), forbidden: [SCORE] }, member('b', 80)];
    expect(rankOf(members, SITE('排序号'), 'a')).toMatchObject({ code: 'FIELD_FORBIDDEN' });
    expect(rankOf(members, SITE('排序号'), 'b')).toEqual(num(1));
  });

  it('单选字段按选项值参与排名', () => {
    const members = [member('a', { optionValue: 3, label: '高' }), member('b', { optionValue: 1, label: '低' })];
    expect(ranks(members, SITE('排序号'))).toEqual([num(1), num(2)]);
  });
});

describe('AC-EXP-19 排名在全体计算对象上一次性求值（DEC-301②，R3-T04 分批计算契约）', () => {
  const item = (field: string, formula: string): ComputationItem => ({ field, priority: 1, formula });
  const ITEMS = [
    item('盘点对象.名次', `Ranking("排序号", ${SCORE}, ${PROJECT_NAME}="PRJ_02", ${PLAN})`),
    item('盘点对象.百分位', `Ranking("百分位", ${SCORE}, ${PROJECT_NAME}="PRJ_02", ${PLAN})`),
  ];
  const DATA = [
    member('s1', 88),
    member('s2', null),
    member('s3', 88),
    member('s4', 70),
    member('s5', 95, { [PLAN]: '方案二' }),
    member('s6', 61),
    member('s7', 70),
  ];
  const subjects = () => DATA.map((m) => inMemorySubject(m.id, m.fields));
  const valuesOf = (results: Record<string, Record<string, EvaluationResult>>) =>
    Object.fromEntries(
      Object.entries(results).map(([id, fields]) => [
        id,
        Object.fromEntries(Object.entries(fields).map(([field, result]) => [field, valueOf(result)])),
      ]),
    );

  it('一次 evaluateBatch：名次与百分位', () => {
    const batch = evaluateBatch(ITEMS, subjects(), { calendar: CALENDAR, project: PROJECT });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(valuesOf(batch.results)).toEqual({
      s1: { '盘点对象.名次': num(1), '盘点对象.百分位': num(20) },
      s2: { '盘点对象.名次': EMPTY_NUMBER, '盘点对象.百分位': EMPTY_NUMBER },
      s3: { '盘点对象.名次': num(1), '盘点对象.百分位': num(20) },
      s4: { '盘点对象.名次': num(3), '盘点对象.百分位': num(60) },
      s5: { '盘点对象.名次': num(1), '盘点对象.百分位': num(100) },
      s6: { '盘点对象.名次': num(5), '盘点对象.百分位': num(100) },
      s7: { '盘点对象.名次': num(3), '盘点对象.百分位': num(60) },
    });
  });

  it('分批调用（每批注入全体人员作为排名范围）与一次性求值结果一致；逐人单独求值也一致', () => {
    const whole = evaluateBatch(ITEMS, subjects(), { calendar: CALENDAR, project: PROJECT });
    if (!whole.ok) throw new Error('一次性求值失败');
    const ports = createInMemoryPorts({ ranking: DATA });
    const all = subjects();
    const merged: Record<string, Record<string, EvaluationResult>> = {};
    for (const part of [all.slice(0, 3), all.slice(3, 5), all.slice(5)]) {
      const batch = evaluateBatch(ITEMS, part, { calendar: CALENDAR, project: PROJECT, ports });
      if (!batch.ok) throw new Error('分批求值失败');
      Object.assign(merged, batch.results);
    }
    expect(valuesOf(merged)).toEqual(valuesOf(whole.results));
    for (const m of DATA) {
      const single = rankOf(DATA, ITEMS[1]!.formula, m.id);
      expect(single).toEqual(valueOf(whole.results[m.id]!['盘点对象.百分位']!));
    }
  });

  it('同一计算项目内排名表只算一次：排序字段的读取次数与人数成线性（300 人不超过 3 × 300 次）', () => {
    let reads = 0;
    const counted = (subject: SubjectReader): SubjectReader => ({
      id: subject.id,
      resolveField(path) {
        if (path === SCORE) reads += 1;
        return subject.resolveField(path);
      },
    });
    const many = Array.from({ length: 300 }, (_, i) => counted(inMemorySubject(`m${i}`, member(`m${i}`, i).fields)));
    const batch = evaluateBatch([ITEMS[0]!], many, { calendar: CALENDAR, project: PROJECT });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(valueOf(batch.results.m0!['盘点对象.名次']!)).toEqual(num(300));
    expect(valueOf(batch.results.m299!['盘点对象.名次']!)).toEqual(num(1));
    expect(reads).toBeLessThanOrEqual(3 * 300);
  });

  it('含 Def 变量（裸词）的范围参数仍逐人求值，结果正确', () => {
    const formula = `Def(方案, "方案一"); Ranking("排序号", ${SCORE}, ${PLAN} = 方案)`;
    const batch = evaluateBatch([item('盘点对象.名次', formula)], subjects(), { calendar: CALENDAR });
    if (!batch.ok) throw new Error('求值失败');
    expect(valueOf(batch.results.s4!['盘点对象.名次']!)).toEqual(num(3));
    expect(valueOf(batch.results.s5!['盘点对象.名次']!)).toMatchObject({ code: 'OUT_OF_SCOPE' });
  });

  it('同值范围按 = 的口径：盘点年度 "2026" 与 2026 同组', () => {
    const YEAR = '盘点活动.盘点年度';
    const members = [member('a', 90, { [YEAR]: '2026' }), member('b', 80, { [YEAR]: 2026 }), member('c', 99)];
    const formula = `Ranking("排序号", ${SCORE}, ${YEAR})`;
    expect(rankOf(members, formula, 'b')).toEqual(num(2));
    expect(rankOf(members, formula, 'c')).toEqual(num(1));
  });

  it('5000 人批量排名（两种模式 × 按方案分组）在 5 秒内完成（本机约 1 秒，留 CI 余量）', () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      inMemorySubject(`m${i}`, member(`m${i}`, i % 997, { [PLAN]: `方案${i % 7}` }).fields),
    );
    const started = performance.now();
    const batch = evaluateBatch(ITEMS, many, { calendar: CALENDAR, project: PROJECT });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(batch.ok).toBe(true);
  });
});

describe('AC-EXP-19 元数据与保存检查（DEC-260、DEC-287）', () => {
  const kinds: Record<string, StaticKind> = {
    [SCORE]: 'number',
    [PROJECT_NAME]: 'text',
    [PLAN]: 'text',
    '盘点对象.入职日期': 'date',
    '盘点对象.是否关键': 'boolean',
  };
  const fieldKind = (path: string) => kinds[path];
  const check = (formula: string) => validateFormula(formula, { fieldKind });

  it('保留“在待办中触发计算时不计算”标记，返回数值', () => {
    const spec = createDefaultRegistry().resolve('Ranking');
    expect(spec?.skipInTodoTrigger).toBe(true);
    expect(spec?.returns).toBe('number');
  });

  it('模式写成常量但不是 "百分位" / "排序号"：保存报错', () => {
    expect(check(`Ranking("名次", ${SCORE})`)).toMatchObject({ ok: false, errors: [{ code: 'ARGUMENT_TYPE' }] });
  });

  it('排序字段不是字段引用：保存报错', () => {
    expect(check(`Ranking("排序号", ${SCORE} + 1)`)).toMatchObject({ ok: false, errors: [{ code: 'ARGUMENT_TYPE' }] });
  });

  it('排序字段确定是日期 / 是否：保存报错；类型不确定：提示不阻断', () => {
    expect(check('Ranking("排序号", 盘点对象.入职日期)')).toMatchObject({ ok: false });
    expect(check('Ranking("排序号", 盘点对象.是否关键)')).toMatchObject({ ok: false });
    const uncertain = check('Ranking("排序号", 盘点对象.未登记字段)');
    expect(uncertain.ok).toBe(true);
    if (uncertain.ok) expect(uncertain.warnings).toMatchObject([{ code: 'TYPE_UNCERTAIN' }]);
  });

  it('范围参数既不是字段引用、也确定不是条件：保存报错；类型不确定的表达式：提示', () => {
    expect(check(`Ranking("排序号", ${SCORE}, 1 + 2)`)).toMatchObject({
      ok: false,
      errors: [{ code: 'ARGUMENT_TYPE' }],
    });
    expect(check(`Ranking("排序号", ${SCORE}, ${PROJECT_NAME}="PRJ_02", "方案一")`)).toMatchObject({ ok: false });
    const uncertain = check(`Ranking("排序号", ${SCORE}, 如果 ${SCORE} > 1 那么 ${PLAN} 否则 盘点对象.是否关键)`);
    expect(uncertain.ok).toBe(true);
    if (uncertain.ok) expect(uncertain.warnings.map((w) => w.code)).toContain('TYPE_UNCERTAIN');
  });

  it('原站写法（条件 + 字段）、文本年度比较（DEC-270）均通过保存检查且无提示', () => {
    const site = check(SITE('百分位'));
    expect(site).toMatchObject({ ok: true, warnings: [] });
    expect(check(`Ranking("百分位", ${SCORE}, 盘点活动.盘点年度>"2025", ${PLAN})`).ok).toBe(true);
  });
});
