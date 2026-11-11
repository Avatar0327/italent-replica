/**
 * AC-F476-15（P8 IDP，第 1 轮审查返工 P2-2）：候选实例集合 = 计划各阶段的全部审批实例，不只是当前指针。
 * 可达流程：员工提交目标 A → 指导人改成 B → 指导人选“不同意”：阶段记开启失败、approval_instance_id 清空。
 * 此后员工读自己已办的 A（不是现值 B）；指定原实例 → 200；HR 重开阶段后旧实例仍能定位。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { planWorld, type PlanView } from './AC-IDP-plan-support.js';
import { GOAL_A, GOAL_B, goalNames, handledThenModified, seen, TASK_A, taskNames } from './AC-F476-idp-support.js';

const testDb = useTestDb();
const tutorMayDisagree = { nodes: { idp_tutor: { exits: ['approve', 'disagree'] as ('approve' | 'disagree')[] } } };

/** 员工提交 A → 指导人改成 B（仍在办）→ 指导人不同意。 */
async function disagreed(label: string) {
  const w = await planWorld(testDb().db, label, tutorMayDisagree);
  const handled = await handledThenModified(w);
  const { instance, task } = await w.pendingTask(handled.plan, 1, w.manager.userId);
  const response = await w.taskAction(w.manager.userId, task.id, 'disagree', instance.revision, { comment: '不同意' });
  expect(response.status, await response.clone().text()).toBe(200);
  const plan = await w.readPlan(handled.plan.id);
  expect(plan.stages[0], '前置：阶段应记开启失败且实例指针已清空').toMatchObject({
    status: 'failed',
    failureReason: 'APPROVAL_DISAPPROVED',
    approvalInstanceId: null,
  });
  return { w, plan, instanceId: handled.instanceId };
}

const items = (plan: PlanView) => [{ id: plan.id, revision: plan.revision }];

describe('AC-F476-15 IDP：候选实例含已不在阶段指针上的实例', () => {
  it('指导人不同意后：员工读到自己办理时的 A（不是现值 B）', async () => {
    const { w, plan, instanceId } = await disagreed('f476-idp-15-disagree');
    const asEmployee = await seen(w, w.employee.userId, plan.id);
    expect(goalNames(asEmployee)).toEqual([GOAL_A]);
    expect(taskNames(asEmployee)).toEqual([TASK_A]);
    expect(asEmployee.contentView).toMatchObject({ mode: 'frozen', instanceId });
  });

  it('指导人不同意后：指定原实例 → 200 且是办理份；别人的计划实例仍 404', async () => {
    const { w, plan, instanceId } = await disagreed('f476-idp-15-disagree-pick');
    const picked = await seen(w, w.employee.userId, plan.id, `?instanceId=${instanceId}`);
    expect(goalNames(picked)).toEqual([GOAL_A]);
    expect(picked.contentView).toMatchObject({ mode: 'frozen', instanceId });

    const other = await handledThenModified(await planWorld(testDb().db, 'f476-idp-15-disagree-other'));
    const foreign = await w.realHttp(
      w.employee.userId,
      'GET',
      `/api/tenant/idp/plans/${plan.id}?instanceId=${other.instanceId}`,
    );
    expect(foreign.status).toBe(404);
  });

  it('阶段重开后：员工在办新实例读现值，指定旧实例仍定位到旧办理份（A）', async () => {
    const { w, plan, instanceId } = await disagreed('f476-idp-15-reopen');
    const receipts = await w.ok<{ receipts: { status: number; outcome: string }[] }>(
      await w.intervene('start-next', { items: items(plan), runningMode: 'skipRunning' }),
    );
    expect(receipts.receipts[0]).toMatchObject({ status: 200, outcome: 'opened' });
    const reopened = await w.readPlan(plan.id);
    expect(reopened.stages[0]!.approvalInstanceId).toBeTruthy();
    expect(reopened.stages[0]!.approvalInstanceId).not.toBe(instanceId);

    const current = await seen(w, w.employee.userId, plan.id);
    expect(current.contentView).toMatchObject({ mode: 'live', instanceId: reopened.stages[0]!.approvalInstanceId });
    expect(goalNames(current)).toEqual([GOAL_B]);

    const old = await seen(w, w.employee.userId, plan.id, `?instanceId=${instanceId}`);
    expect(old.contentView).toMatchObject({ mode: 'frozen', instanceId });
    expect(goalNames(old)).toEqual([GOAL_A]);
  });
});
