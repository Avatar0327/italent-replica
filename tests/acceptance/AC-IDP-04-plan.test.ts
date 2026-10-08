/**
 * AC-IDP-04 计划侧（docs/02_业务建模/28 §5；IDP-R9 模板通用目标只对之后新发起的计划生效；PR 描述 K-48）：
 * 模板已被引用后新增通用目标 → 已发起的计划不变，新发起的计划带上该目标。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { otherTutor, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

describe('AC-IDP-04 通用目标只对之后新发起的计划生效', () => {
  it('已建计划带入当时的通用目标；之后新增的通用目标只出现在新计划里', async () => {
    const w = await planWorld(testDb().db, 'idp-ac04');
    const first = await w.createPlan();
    expect(first.goals!.map((g) => [g.name, g.sourceType, g.commonGoalId, g.measure, g.suggestion])).toEqual([
      ['提升跨部门沟通', 'common', w.firstCommonGoal.id, '季度 360 评分 ≥ 4', '主持周会'],
    ]);
    // 模板已被计划引用，仍可维护通用目标（IDP-R12 只限制模块增删）
    const template = await w.ok<{ referenced: boolean }>(
      await w.http(w.hrUser, 'GET', `/api/tenant/idp/templates/${w.template.id}`),
    );
    expect(template.referenced).toBe(true);
    const added = await w.commonGoal('建立技术影响力');
    const unchanged = await w.readPlan(first.id);
    expect(unchanged.goals!.map((g) => g.name)).toEqual(['提升跨部门沟通']);
    expect(unchanged.revision).toBe(first.revision);

    const second = await w.createPlan({ name: '第二份计划', ...otherTutor(w) }, w.hrUser, w.outsider);
    expect(second.goals!.map((g) => [g.name, g.commonGoalId])).toEqual([
      ['提升跨部门沟通', w.firstCommonGoal.id],
      ['建立技术影响力', added.id],
    ]);
  });

  it('改通用目标的内容同样不影响已建计划', async () => {
    const w = await planWorld(testDb().db, 'idp-ac04-edit');
    const plan = await w.createPlan();
    const response = await w.http(
      w.hrUser,
      'PATCH',
      `/api/tenant/idp/templates/${w.template.id}/common-goals/${w.firstCommonGoal.id}`,
      { ifMatch: w.template.revision, body: { measure: '改过的衡量标准' } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await w.readPlan(plan.id)).goals![0]!.measure).toBe('季度 360 评分 ≥ 4');
  });
});
