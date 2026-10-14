/**
 * AC-IDP-05（docs/02_业务建模/28 §5；IDP-R10 无目标校验；PR 描述 K-47）：发展目标模块开启无目标校验，员工未建目标就
 * 提交 → 拒绝（409 IDP_GOAL_REQUIRED，待办不动）；建了目标再提交通过。未开启时没有目标也能提交。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

describe('AC-IDP-05 无目标校验', () => {
  it('开启无目标校验：删光目标后提交 409，任务仍待办；新建目标后提交通过', async () => {
    const w = await planWorld(testDb().db, 'idp-ac05', { checkNoneGoal: true });
    let plan = await w.startedPlan();
    // 带入的通用目标由员工在“制定发展目标”节点删除（RowDeleteIdpGoal）
    const carried = plan.goals![0]!;
    const removed = await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${carried.id}`);
    expect(removed.status, await removed.clone().text()).toBe(200);
    plan = await w.readPlan(plan.id);
    expect(plan.goals).toEqual([]);

    const before = await w.instanceOf(plan, 1);
    expect(await errorOf(await w.submitRaw(plan, 1, w.employee.userId))).toMatchObject({
      status: 409,
      reason: 'IDP_GOAL_REQUIRED',
    });
    const after = await w.instanceOf(plan, 1);
    expect(after.revision).toBe(before.revision);
    expect(after.currentNodeKey).toBe('set_goals');

    await w.addGoal(plan, w.employee.userId, { name: '主导一次架构评审' });
    const submitted = await w.submit(plan, 1, w.employee.userId);
    expect(submitted.currentNodeName).toBe('审批发展计划');
  });

  it('未开启无目标校验：没有目标也能提交', async () => {
    const w = await planWorld(testDb().db, 'idp-ac05-off', { checkNoneGoal: false });
    let plan = await w.startedPlan();
    await w.execute(w.employee.userId, 'DELETE', `/plans/${plan.id}/goals/${plan.goals![0]!.id}`);
    plan = await w.submit(plan, 1, w.employee.userId);
    expect(plan.currentNodeName).toBe('审批发展计划');
  });
});
