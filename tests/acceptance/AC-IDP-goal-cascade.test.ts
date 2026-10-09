/**
 * R3-T07 PR-B 第 2 轮 P2-7：删除目标级联删除其任务与目标回顾（DEC-309④-2 的级联清单补上目标这一层）。
 * 执行人对子对象的删除权 = 当前节点在该模块上的 RowEditIdpGoal（任务 / 目标回顾挂在它上面，🟡 K-12）；不论子对象是否
 * 存在都要求，缺了整次 403 IDP_NODE_BUTTON_DENIED，目标与子对象都不变（不部分删除）；同键重放同样复核。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanView, type PlanWorld } from './AC-IDP-plan-support.js';
import type { TemplateView } from './AC-IDP-support.js';

const testDb = useTestDb();
const IDP = '/api/tenant/idp';

/** 把制定计划节点上发展目标模块的按钮改成 buttons（模板先停用再发布）。 */
async function setGoalButtons(w: PlanWorld, buttons: readonly string[]) {
  const current = await w.ok<TemplateView>(await w.http(w.hrUser, 'GET', `${IDP}/templates/${w.template.id}`));
  const draft = await w.ok<TemplateView>(
    await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/unpublish`, { ifMatch: current.revision }),
  );
  const patched = await w.ok<TemplateView>(
    await w.http(w.hrUser, 'PATCH', `${IDP}/templates/${w.template.id}/modules/${w.goalModule.id}`, {
      ifMatch: draft.revision,
      body: { nodeSettings: [{ subProcessId: w.stageId(1), nodeKey: 'set_goals', enabled: true, buttons }] },
    }),
  );
  await w.ok(
    await w.http(w.hrUser, 'POST', `${IDP}/templates/${w.template.id}/publish`, { ifMatch: patched.revision }),
  );
}

describe('P2-7：删除目标须有子对象的删除权', () => {
  it('节点只有 RowDeleteIdpGoal、没有 RowEditIdpGoal：删除目标整次 403，目标与任务都还在', async () => {
    const w = await planWorld(testDb().db, 'idp-goal-cascade');
    let plan = await w.startedPlan();
    plan = await w.addGoal(plan, w.employee.userId, { name: '带任务的目标' });
    const goal = plan.goals!.find((g) => g.name === '带任务的目标')!;
    await w.ok(
      await w.execute(w.employee.userId, 'POST', `/plans/${plan.id}/goals/${goal.id}/tasks`, { name: '子任务' }),
      201,
    );
    await setGoalButtons(w, ['RowAddIdpGoal', 'RowDeleteIdpGoal']);
    const before = await w.readPlan(plan.id);
    const task = before.goals!.find((g) => g.id === goal.id)!.tasks[0]!;
    const direct = await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${goal.id}/tasks/${task.id}`);
    expect(await errorOf(direct)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
    const cascade = await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${goal.id}`);
    expect(await errorOf(cascade)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
    const after = await w.readPlan(plan.id);
    expect(after.revision).toBe(before.revision);
    expect(after.goals!.find((g) => g.id === goal.id)?.tasks.map((t) => t.id)).toEqual([task.id]);

    // 对照：两个按钮都有时可以删除（空目标同样要求两者，不按是否存在子对象区别对待）
    await setGoalButtons(w, ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal']);
    const removed = await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${goal.id}`);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(((await removed.json()) as PlanView).goals!.some((g) => g.id === goal.id)).toBe(false);
  });

  it('空目标也要求子对象删除权：没有 RowEditIdpGoal 时 403', async () => {
    const w = await planWorld(testDb().db, 'idp-goal-cascade-empty');
    let plan = await w.startedPlan();
    plan = await w.addGoal(plan, w.employee.userId, { name: '空目标' });
    const goal = plan.goals!.find((g) => g.name === '空目标')!;
    await setGoalButtons(w, ['RowAddIdpGoal', 'RowDeleteIdpGoal']);
    const response = await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${goal.id}`);
    expect(await errorOf(response)).toMatchObject({ status: 403, reason: 'IDP_NODE_BUTTON_DENIED' });
  });
});
