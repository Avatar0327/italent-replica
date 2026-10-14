import { describe, expect, it } from 'vitest';
import {
  evaluationActions,
  evaluationPatch,
  validateDates,
  insertActivityChain,
} from '../../apps/web/src/evaluation/model.js';
import { questionnaireContent, validateQuestionnaireSelection } from '../../apps/web/src/survey360/model.js';

describe('AC-FE-R3b-01 活动配置与状态边界', () => {
  it('开始晚于结束拒绝，业务日期直接比较、不按浏览器时区换算', () => {
    expect(validateDates('2026-10-20', '2026-10-19')).toBe(false);
    expect(validateDates('2026-10-20', '2026-10-20')).toBe(true);
    expect(validateDates(null, null)).toBe(true);
  });
  it('已有报名不可取消发布；未知或已完成状态没有状态操作', () => {
    expect(evaluationActions({ status: 'draft', applyCount: 0 })).toEqual(['publish']);
    expect(evaluationActions({ status: 'published', applyCount: 0 })).toEqual(['unpublish']);
    expect(evaluationActions({ status: 'published', applyCount: 1 })).toEqual([]);
    expect(evaluationActions({ status: 'published' })).toEqual([]);
    expect(evaluationActions({ status: 'completed', applyCount: 0 })).toEqual([]);
  });
  it('局部编辑仅提交实际变化的可编辑字段，保留显式清空、不回传状态和隐蔽字段', () => {
    expect(
      evaluationPatch(
        { name: '旧名', endDate: '2026-10-20', status: 'draft' },
        { name: '新名', endDate: null, status: 'published', year: 2026 },
        ['name', 'endDate'],
      ),
    ).toEqual({ name: '新名', endDate: null });
    expect(evaluationPatch({ name: '相同' }, { name: '相同' }, ['name'])).toEqual({});
  });
});
describe('AC-FE-R3b-02 套卷与评价关系', () => {
  it('评价对象至少一套最多三套，不允许重复', () => {
    expect(validateQuestionnaireSelection([])).toBe(false);
    expect(validateQuestionnaireSelection(['a', 'b', 'c'])).toBe(true);
    expect(validateQuestionnaireSelection(['a', 'b', 'c', 'd'])).toBe(false);
    expect(validateQuestionnaireSelection(['a', 'a'])).toBe(false);
  });
  it('套卷响应 ID 转回稳定 key，只提交白名单内容，父指标和量表引用不丢失', () => {
    const content = questionnaireContent({
      roles: [{ id: 'r1', key: 'peer', roleId: 'role1', weight: 1 }],
      scales: [{ id: 's1', key: 'scale', name: '等级', options: [{ id: 'o', key: 'yes', label: '符合', value: 5 }] }],
      dimensions: [
        { id: 'd1', key: 'parent', name: '能力', weight: 100, parentId: null, scaleId: null },
        { id: 'd2', key: 'child', name: '协作', weight: 100, parentId: 'd1', scaleId: 's1' },
      ],
      questions: [{ id: 'q1', key: 'q', dimensionId: 'd2', scaleId: 's1', text: '主动沟通', weight: 1 }],
    });
    expect(content.dimensions[1]).toMatchObject({ parentKey: 'parent', scaleKey: 'scale' });
    expect(content.questions[0]).toMatchObject({ dimensionKey: 'child', scaleKey: 'scale' });
    expect(content.roles[0]).not.toHaveProperty('id');
    expect(content.scales[0]?.options[0]).not.toHaveProperty('id');
  });
  it('引用被裁剪时拒绝编辑，不能把缺失的引用变成空引用保存', () => {
    expect(() =>
      questionnaireContent({
        roles: [],
        scales: [],
        dimensions: [],
        questions: [{ key: 'q', dimensionId: 'hidden', scaleId: 'hidden', text: '题目' }],
      }),
    ).toThrow();
  });
});

it('AC-FE-R3b-07 新增材料环节插在结果发布之前，已有环节稳定标识不变', () => {
  const apply = { id: 'first', type: 'apply' };
  const result = { id: 'last', type: 'result' };
  const chains: { id?: string; type: string }[] = [apply, result];
  expect(insertActivityChain(chains, { type: 'material' })).toEqual([apply, { type: 'material' }, result]);
});
