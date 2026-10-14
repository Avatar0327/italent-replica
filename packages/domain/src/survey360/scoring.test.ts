import { describe, expect, it } from 'vitest';
import { allowedScoreMethods, type QuestionnaireModel, validateQuestionnaire } from './questionnaire.js';
import { aggregateScores, answerableItems, excellentLimit, isExcellent, maxTotal, scoreSheet } from './scoring.js';

const options = (scaleId: string, values: (number | null)[]) =>
  values.map((value, i) => ({
    id: `${scaleId}-${i}`,
    scaleId,
    label: String(value),
    value,
    notScored: value === null,
    remarkRequired: false,
  }));

const keyBehavior: QuestionnaireModel = {
  type: 'key_behavior',
  scoreMethod: 'weighted_average',
  roles: [
    { roleId: 'self', weight: 0, isSelf: true },
    { roleId: 'boss', weight: 5, isSelf: false },
    { roleId: 'peer', weight: 3, isSelf: false },
    { roleId: 'sub', weight: 2, isSelf: false },
  ],
  scales: [{ id: 's', name: '分值', options: options('s', [1, 2, 3, 4, 5, null]) }],
  dimensions: [
    { id: 'c', parentId: null, name: '复合', weight: 100, scaleId: null, roleIds: [] },
    { id: 'b1', parentId: 'c', name: '基础1', weight: 60, scaleId: null, roleIds: [] },
    { id: 'b2', parentId: 'c', name: '基础2', weight: 40, scaleId: null, roleIds: ['boss'] },
  ],
  questions: [
    { id: 'q1', dimensionId: 'b1', text: '题1', weight: 1, scaleId: 's', roleIds: [] },
    { id: 'q2', dimensionId: 'b1', text: '题2', weight: 3, scaleId: 's', roleIds: [] },
    { id: 'q3', dimensionId: 'b2', text: '题3', weight: 1, scaleId: 's', roleIds: [] },
  ],
};

describe('角色加权计分（E3-R11）', () => {
  it('题目 → 基础指标 → 复合指标逐层加权平均', () => {
    const scores = scoreSheet(
      keyBehavior,
      'boss',
      new Map([
        ['q1', 's-4'],
        ['q2', 's-2'],
        ['q3', 's-0'],
      ]),
    );
    // b1 = (5×1 + 3×3)/4 = 3.5；b2 = 1；c = (3.5×60 + 1×40)/100 = 2.5
    expect(scores.dimensions.get('b1')).toBe(3.5);
    expect(scores.total).toBeCloseTo(2.5, 10);
  });

  it('限定角色之外的指标不参与该评价者计分（E3-R8），不计分选项不按 0 分（E3-R6）', () => {
    expect(answerableItems(keyBehavior, 'peer')).toEqual(['q1', 'q2']);
    const peer = scoreSheet(
      keyBehavior,
      'peer',
      new Map([
        ['q1', 's-3'],
        ['q2', 's-5'],
        ['q3', 's-4'],
      ]),
    );
    expect(peer.total).toBe(4);
    expect(peer.questions.get('q2')).toBeNull();
  });

  it('缺失角色的权重从分子分母同时去掉（E3-R13，AC-360-04 的 3.69）', () => {
    const flat: QuestionnaireModel = {
      ...keyBehavior,
      scales: [{ id: 's', name: '分值', options: options('s', [3.5, 4]) }],
      dimensions: [{ id: 'd', parentId: null, name: '指标', weight: 1, scaleId: null, roleIds: [] }],
      questions: [{ id: 'q', dimensionId: 'd', text: '题', weight: 1, scaleId: 's', roleIds: [] }],
    };
    const sheet = (roleId: string, option: string) => ({
      roleId,
      isSelf: false,
      scores: scoreSheet(flat, roleId, new Map([['q', option]])),
    });
    const rows = aggregateScores(flat, [sheet('boss', 's-0'), sheet('peer', 's-1')]);
    const other = rows.find((r) => r.level === 'questionnaire' && r.scope === 'other')!;
    expect(Number(other.score!.toFixed(2))).toBe(3.69);
    expect(rows.some((r) => r.roleId === 'sub')).toBe(false);
  });
});

describe('等级评定与总分规则（E3-R7）', () => {
  const rating = (scales: QuestionnaireModel['scales'], scaleIds: [string, string]): QuestionnaireModel => ({
    type: 'rating',
    scoreMethod: 'weighted_sum',
    roles: [{ roleId: 'boss', weight: 1, isSelf: false }],
    scales,
    dimensions: [
      { id: 'c', parentId: null, name: '复合', weight: 100, scaleId: null, roleIds: [] },
      { id: 'b1', parentId: 'c', name: '基础1', weight: 30, scaleId: scaleIds[0], roleIds: [] },
      { id: 'b2', parentId: 'c', name: '基础2', weight: 70, scaleId: scaleIds[1], roleIds: [] },
    ],
    questions: [],
  });

  it('同一复合指标下须同一套评定等级；≥2 套只能加权求和；含不计分项只能加权平均', () => {
    const two = rating(
      [
        { id: 'x', name: 'x', options: options('x', [10, 20]) },
        { id: 'y', name: 'y', options: options('y', [50, 100]) },
      ],
      ['x', 'y'],
    );
    expect(validateQuestionnaire(two).map((i) => i.code)).toContain('RATING_MIXED_SCALES');
    expect(allowedScoreMethods(two)).toEqual(['weighted_sum']);
    const withNone = rating([{ id: 'x', name: 'x', options: options('x', [1, 2, null]) }], ['x', 'x']);
    expect(allowedScoreMethods(withNone)).toEqual(['weighted_average']);
    expect(validateQuestionnaire(withNone).map((i) => i.code)).toContain('SCORE_METHOD_NOT_ALLOWED');
  });

  it('基础指标权重之和须为 100%', () => {
    const model = rating([{ id: 'x', name: 'x', options: options('x', [1, 2]) }], ['x', 'x']);
    const bad = { ...model, dimensions: model.dimensions.map((d) => (d.id === 'b2' ? { ...d, weight: 60 } : d)) };
    expect(validateQuestionnaire(bad).map((i) => i.code)).toContain('WEIGHTS_NOT_100');
    expect(validateQuestionnaire(model)).toEqual([]);
  });

  it('加权求和：Σ(分 × 权重%)', () => {
    const model = rating([{ id: 'x', name: 'x', options: options('x', [10, 20]) }], ['x', 'x']);
    const total = scoreSheet(
      model,
      'boss',
      new Map([
        ['b1', 'x-1'],
        ['b2', 'x-0'],
      ]),
    ).total;
    expect(total).toBeCloseTo(20 * 0.3 + 10 * 0.7, 10);
  });
});

describe('优秀率控制（E3-R9）', () => {
  it('12 人 × 20% → 3；满分按每题最高计分选项', () => {
    expect(excellentLimit(12, 20)).toBe(3);
    expect(excellentLimit(10, 20)).toBe(2);
    expect(maxTotal(keyBehavior, 'boss')).toBe(5);
    expect(isExcellent(4.5, 5, 90)).toBe(true);
    expect(isExcellent(4.49, 5, 90)).toBe(false);
  });
});
