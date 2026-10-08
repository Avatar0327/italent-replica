/**
 * AC-IDP-02（docs/02_业务建模/28 §5；IDP-R16 流程干预“跳转”只能在当前子流程内、不能跨阶段；Q-M0-115 ③⑥ 🟡）：
 * HR 在阶段 2 的第一个节点尝试向前跳转（到阶段 1 的节点）→ 拒绝；阶段内跳转可以。须填原因；负例前后比对不变。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorOf, planWorld, type PlanView, type Receipt } from './AC-IDP-plan-support.js';

const testDb = useTestDb();

async function atStageTwo(label: string) {
  const w = await planWorld(testDb().db, label);
  let plan = await w.startedPlan();
  await w.submit(plan, 1, w.employee.userId);
  plan = await w.submit(plan, 1, w.manager.userId);
  // 阶段 2 手动开启（HR“开启下个阶段”）
  const opened = await w.ok<{ receipts: Receipt[] }>(
    await w.intervene('start-next', { items: [{ id: plan.id, revision: plan.revision }], runningMode: 'skipRunning' }),
  );
  expect(opened.receipts).toEqual([expect.objectContaining({ id: plan.id, status: 200, outcome: 'opened' })]);
  plan = await w.readPlan(plan.id);
  expect(plan.currentStageName).toBe('中期回顾');
  expect(plan.currentNodeName).toBe('员工中期回顾');
  return { w, plan };
}

const jump = (w: Awaited<ReturnType<typeof atStageTwo>>['w'], plan: PlanView, body: Record<string, unknown>) =>
  w.http(w.hrUser, 'POST', `/api/tenant/idp/plans/${plan.id}/jump`, { ifMatch: plan.revision, body });

describe('AC-IDP-02 跳转不能跨阶段', () => {
  it('在阶段 2 第一个节点向前跳到阶段 1 的节点：409 IDP_JUMP_CROSS_STAGE，计划与审批实例不变', async () => {
    const { w, plan } = await atStageTwo('idp-ac02');
    const before = await w.instanceOf(plan, 2);
    for (const body of [
      { toNodeKey: 'approve_plan', reason: '退回修改目标' },
      { toNodeKey: 'approve_plan', stageId: plan.stages[0]!.id, reason: '退回修改目标' },
    ]) {
      const response = await jump(w, plan, body);
      expect(await errorOf(response)).toMatchObject({ status: 409, reason: 'IDP_JUMP_CROSS_STAGE' });
    }
    const after = await w.instanceOf(plan, 2);
    expect(after.revision).toBe(before.revision);
    expect(after.currentNodeKey).toBe('employee_mid');
    expect((await w.readPlan(plan.id)).revision).toBe(plan.revision);
  });

  it('阶段内跳转：跳到“指导人中期回顾”，待办转给指导人；不填原因 400', async () => {
    const { w, plan } = await atStageTwo('idp-ac02-in');
    const noReason = await jump(w, plan, { toNodeKey: 'tutor_mid' });
    expect(noReason.status).toBe(400);
    const response = await jump(w, plan, { toNodeKey: 'tutor_mid', reason: '员工休假，先由指导人回顾' });
    expect(response.status, await response.clone().text()).toBe(200);
    const instance = await w.instanceOf(plan, 2);
    expect(instance.currentNodeKey).toBe('tutor_mid');
    expect(instance.tasks.filter((t) => t.status === 'pending').map((t) => t.assigneeUserId)).toEqual([
      w.manager.userId,
    ]);
    expect((await w.readPlan(plan.id)).currentNodeName).toBe('指导人中期回顾');
  });
});
