import { describe, expect, it } from 'vitest';
import { type QuestionnaireModel, type Scale, validateQuestionnaire } from './questionnaire.js';
import { SURVEY360_LIMITS } from './rules.js';

const scale = (values: readonly (number | null)[]): Scale => ({
  id: 's',
  name: '分值',
  options: values.map((value, i) => ({
    id: `s-${i}`,
    scaleId: 's',
    label: String(value),
    value,
    notScored: value === null,
    remarkRequired: false,
  })),
});

/** 能启用的关键行为套卷；每个用例只改一处，断言只多出对应的问题编码。 */
const valid: QuestionnaireModel = {
  type: 'key_behavior',
  scoreMethod: 'weighted_average',
  roles: [
    { roleId: 'self', weight: 0, isSelf: true },
    { roleId: 'boss', weight: 6, isSelf: false },
    { roleId: 'peer', weight: 4, isSelf: false },
  ],
  scales: [scale([1, 2, 3])],
  dimensions: [{ id: 'd', parentId: null, name: '指标', weight: 100, scaleId: null, roleIds: [] }],
  questions: [{ id: 'q', dimensionId: 'd', text: '题', weight: 1, scaleId: 's', roleIds: [] }],
};

/** 能启用的等级评定套卷：基础指标直接挂评定等级，不设题目。 */
const rating: QuestionnaireModel = {
  ...valid,
  type: 'rating',
  dimensions: [{ id: 'd', parentId: null, name: '指标', weight: 100, scaleId: 's', roleIds: [] }],
  questions: [],
};

const codes = (model: QuestionnaireModel) => validateQuestionnaire(model).map((i) => i.code);
const withRole = (roleId: string, weight: number) =>
  valid.roles.map((r) => (r.roleId === roleId ? { ...r, weight } : r));

describe('套卷角色与权重（E3-R4、E3-R5；AC-360-02）', () => {
  it('基准套卷可启用', () => {
    expect(validateQuestionnaire(valid)).toEqual([]);
    expect(validateQuestionnaire(rating)).toEqual([]);
  });

  it('自评权重固定为 0', () => {
    expect(codes({ ...valid, roles: withRole('self', 1) })).toEqual(['SELF_WEIGHT_NOT_ZERO']);
  });

  it('他评角色权重不能全为 0；只有自评时报缺他评角色', () => {
    const zero = valid.roles.map((r) => ({ ...r, weight: 0 }));
    expect(codes({ ...valid, roles: zero })).toEqual(['OTHER_ROLE_WEIGHTS_ZERO']);
    expect(codes({ ...valid, roles: valid.roles.filter((r) => r.isSelf) })).toEqual(['NO_OTHER_ROLE']);
  });

  it('角色权重须为不小于 0 的整数', () => {
    expect(codes({ ...valid, roles: withRole('boss', -1) })).toEqual(['ROLE_WEIGHT_INVALID']);
    expect(codes({ ...valid, roles: withRole('boss', 1.5) })).toEqual(['ROLE_WEIGHT_INVALID']);
  });

  it(`单套卷最多 ${SURVEY360_LIMITS.rolesPerQuestionnaire} 个角色（含自评）`, () => {
    const roles = (count: number) => [
      { roleId: 'self', weight: 0, isSelf: true },
      ...Array.from({ length: count - 1 }, (_, i) => ({ roleId: `r${i}`, weight: 1, isSelf: false })),
    ];
    expect(codes({ ...valid, roles: roles(SURVEY360_LIMITS.rolesPerQuestionnaire) })).toEqual([]);
    expect(codes({ ...valid, roles: roles(SURVEY360_LIMITS.rolesPerQuestionnaire + 1) })).toEqual(['TOO_MANY_ROLES']);
  });

  it('限定的评价角色须在套卷角色中（E3-R8）', () => {
    const questions = [{ ...valid.questions[0]!, roleIds: ['customer'] }];
    expect(validateQuestionnaire({ ...valid, questions })).toEqual([
      expect.objectContaining({ code: 'ROLE_RESTRICTION_UNKNOWN', itemId: 'q' }),
    ]);
  });
});

describe('评定等级选项（E3-R6）', () => {
  it(`选项 1～${SURVEY360_LIMITS.optionsPerScale} 个，且至少有一个计分选项`, () => {
    const values = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
    expect(codes({ ...valid, scales: [scale(values(SURVEY360_LIMITS.optionsPerScale))] })).toEqual([]);
    expect(codes({ ...valid, scales: [scale(values(SURVEY360_LIMITS.optionsPerScale + 1))] })).toEqual([
      'OPTION_COUNT_INVALID',
    ]);
    expect(codes({ ...valid, scales: [scale([])] })).toEqual(['OPTION_COUNT_INVALID', 'SCALE_WITHOUT_SCORE']);
    expect(codes({ ...valid, scales: [scale([null])] })).toEqual(['SCALE_WITHOUT_SCORE']);
  });
});

describe('指标与题目结构（E3-R1、E3-R7）', () => {
  it('至少一个指标', () => {
    expect(codes({ ...valid, dimensions: [], questions: [] })).toEqual(['NO_DIMENSION']);
  });

  it('关键行为：基础指标下至少一道题，题目只能挂在基础指标下', () => {
    expect(validateQuestionnaire({ ...valid, questions: [] })).toEqual([
      expect.objectContaining({ code: 'LEAF_WITHOUT_QUESTION', itemId: 'd' }),
    ]);
    const composite = { id: 'c', parentId: null, name: '复合', weight: 100, scaleId: null, roleIds: [] };
    const dimensions = [composite, { ...valid.dimensions[0]!, parentId: 'c' }];
    const questions = [...valid.questions, { ...valid.questions[0]!, id: 'q-c', dimensionId: 'c' }];
    expect(validateQuestionnaire({ ...valid, dimensions, questions })).toEqual([
      expect.objectContaining({ code: 'QUESTION_ON_COMPOSITE', itemId: 'c' }),
    ]);
  });

  it('等级评定：不设题目，基础指标必须设置评定等级', () => {
    expect(validateQuestionnaire({ ...rating, questions: valid.questions })).toEqual([
      expect.objectContaining({ code: 'RATING_WITH_QUESTION', itemId: 'd' }),
    ]);
    const unscaled = rating.dimensions.map((d) => ({ ...d, scaleId: null }));
    expect(validateQuestionnaire({ ...rating, dimensions: unscaled })).toEqual([
      expect.objectContaining({ code: 'RATING_WITHOUT_SCALE', itemId: 'd' }),
    ]);
  });

  it('同级指标权重、同一指标下的题目权重都不能全为 0', () => {
    const zeroDimension = valid.dimensions.map((d) => ({ ...d, weight: 0 }));
    expect(validateQuestionnaire({ ...valid, dimensions: zeroDimension })).toEqual([
      expect.objectContaining({ code: 'WEIGHTS_ALL_ZERO', itemId: '' }),
    ]);
    const zeroQuestion = valid.questions.map((q) => ({ ...q, weight: 0 }));
    expect(validateQuestionnaire({ ...valid, questions: zeroQuestion })).toEqual([
      expect.objectContaining({ code: 'WEIGHTS_ALL_ZERO', itemId: 'd' }),
    ]);
  });

  it('关键行为只支持加权平均（E3-R1）', () => {
    expect(codes({ ...valid, scoreMethod: 'weighted_sum' })).toEqual(['SCORE_METHOD_NOT_ALLOWED']);
  });
});
