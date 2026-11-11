/**
 * AC-F476-08（P8 IDP 片）：办理 → 修改 → 两条读取路径（docs/08_设计/F-476 §9）。
 * 本片覆盖：IDP 阶段的办理份带非空真实详情；办理后事源被修改，办理人读到办理时内容，在办人 / 发起人读到当前内容；
 * 第二条路径（驳回到上一步后再次办理）新办理份取新内容、旧办理份不变。
 * 留给 P4～P7 / P9：入转调离、合同 / 子集 / 兼职、Offer、测评 / 退休意向、交接与登记收口。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { planWorld } from './AC-IDP-plan-support.js';
import {
  ANALYSIS_A,
  copiesOfPlan,
  copyGoalNames,
  expectRealDetail,
  GOAL_A,
  GOAL_B,
  goalNames,
  handledThenModified,
  seen,
  TASK_A,
  TASK_B,
  taskNames,
} from './AC-F476-idp-support.js';

const testDb = useTestDb();

describe('AC-F476-08 IDP：办理后修改，办理人读办理时内容', () => {
  it('员工已办理（提交）后指导人改了目标 / 任务：员工读到办理时的目标、任务、个人综述；指导人（在办）与计划所有者读到当前内容', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-08-read');
    const { plan, instanceId } = await handledThenModified(w);

    const asEmployee = await seen(w, w.employee.userId, plan.id);
    expect(goalNames(asEmployee)).toEqual([GOAL_A]);
    expect(taskNames(asEmployee)).toEqual([TASK_A]);
    expect(asEmployee.analyses?.map((a) => a.currentAnalysis)).toEqual([ANALYSIS_A]);
    expect(asEmployee.contentView).toMatchObject({ mode: 'frozen', instanceId });

    const asTutor = await seen(w, w.manager.userId, plan.id);
    expect(goalNames(asTutor)).toEqual([GOAL_B]);
    expect(taskNames(asTutor)).toEqual([TASK_B]);
    expect(asTutor.contentView).toMatchObject({ mode: 'live' });

    // 计划所有者（发起人）看当前内容，且不受办理份影响
    const asOwner = await w.readPlan(plan.id);
    expect(goalNames(asOwner)).toEqual([GOAL_B]);
  });

  it('办理份带非空真实详情：目标、任务、个人综述都在，不是空 values 的通用快照', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-08-copy');
    const { plan } = await handledThenModified(w);
    const copies = await copiesOfPlan(w, plan.id);
    expect(copies).toHaveLength(1);
    expectRealDetail(copies[0]);
    expect(copyGoalNames(copies[0])).toEqual([GOAL_A]);
    expect(copies[0]!.text).toContain(ANALYSIS_A);
    expect(copies[0]!.text).toContain(TASK_A);
    expect(copies[0]!.text).not.toContain(GOAL_B);
  });

  it('第二条路径：指导人驳回到上一步，员工改后再提交 → 新办理份取新内容，旧办理份不变，员工读最新办理份', async () => {
    const w = await planWorld(testDb().db, 'f476-idp-08-again');
    const { plan, goalId, instanceId } = await handledThenModified(w);
    const NEW_NAME = 'ZZ_驳回后新目标';

    const { instance, task } = await w.pendingTask(plan, 1, w.manager.userId);
    const back = await w.http(w.manager.userId, 'POST', `/api/tenant/approval/tasks/${task.id}/reject-previous`, {
      ifMatch: instance.revision,
      body: { comment: '目标再细化' },
    });
    expect(back.status, await back.clone().text()).toBe(200);

    // 员工重新在办：读当前内容（含指导人刚改的 B）
    expect(goalNames(await seen(w, w.employee.userId, plan.id))).toEqual([GOAL_B]);

    await w.ok(await w.execute(w.employee.userId, 'PATCH', `/plans/${plan.id}/goals/${goalId}`, { name: NEW_NAME }));
    await w.submit(plan, 1, w.employee.userId);
    await w.ok(
      await w.execute(w.manager.userId, 'PATCH', `/plans/${plan.id}/goals/${goalId}`, { name: 'ZZ_再次改动' }),
    );

    const all = await copiesOfPlan(w, plan.id);
    // 驳回到上一步本身也是一次办理：指导人也留下一份（办理时看到的是 B）
    expect(all).toHaveLength(3);
    expect(copyGoalNames(all[1])).toEqual([GOAL_B]);
    expect(all[1]!.actor_user_id).toBe(w.manager.userId);
    const copies = all.filter((copy) => copy.actor_user_id === w.employee.userId);
    expect(copyGoalNames(copies[0])).toEqual([GOAL_A]); // 旧办理份不变
    expect(copyGoalNames(copies[1])).toEqual([NEW_NAME]);

    const asEmployee = await seen(w, w.employee.userId, plan.id);
    expect(goalNames(asEmployee)).toEqual([NEW_NAME]);
    expect(asEmployee.contentView).toMatchObject({ mode: 'frozen', instanceId });
  });
});
