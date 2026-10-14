/**
 * R3-T07 PR-B 第 3 轮 R2-6（DEC-124 / DEC-318 K-39）：“驳回到上一步”与跳转一样重置有效审批历史的边界——上一步的
 * 办理人要重新办理，不能因节点开启“历史同人自动跳过”而沿用驳回前的同意（被自动 history_skip）。
 * IDP（员工 → 指导人）与其他开启了该动作的单人流程（调动：调出负责人 → 调入 HRBP）走同一路径，一起覆盖。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, TRANSFER_NODES, transferScene, type InstanceView } from './AC-APV-support.js';
import { planWorld } from './AC-IDP-plan-support.js';

const testDb = useTestDb();
const APV = '/api/tenant/approval';

const pending = (view: InstanceView) => view.tasks.filter((t) => t.status === 'pending');

describe('R2-6：驳回到上一步后上一步的办理人重新办理', () => {
  it('IDP：员工节点开启历史同人跳过，指导人驳回到上一步 → 员工拿到新待办', async () => {
    const w = await planWorld(testDb().db, 'idp-rp-history', {
      nodes: { idp_employee: { historySameAssigneeSkip: true } },
    });
    const plan = await w.submit(await w.startedPlan(), 1, w.employee.userId);
    const { instance, task } = await w.pendingTask(plan, 1, w.manager.userId);
    const back = await w.http(w.manager.userId, 'POST', `${APV}/tasks/${task.id}/reject-previous`, {
      ifMatch: instance.revision,
      body: { comment: '目标再细化' },
    });
    expect(back.status, await back.clone().text()).toBe(200);
    const after = await w.instanceOf(plan, 1);
    expect(pending(after)).toEqual([
      expect.objectContaining({ nodeKey: 'set_goals', assigneeUserId: w.employee.userId }),
    ]);
    expect(after.tasks.filter((t) => t.status === 'history_skip')).toEqual([]);
  });

  it('调动：调出负责人节点开启历史同人跳过，调入 HRBP 驳回到上一步 → 调出负责人拿到新待办', async () => {
    const w = await approvalWorld(testDb().db, 'apv-rp-history');
    const s = await transferScene(w);
    await w.publishedProcess({
      nodes: [
        { ...TRANSFER_NODES[0]!, historySameAssigneeSkip: true },
        { ...TRANSFER_NODES[1]!, actions: { rejectToPrevious: true } },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, pending(view)[0]!.id, 'approve', view.revision));
    const hrbpTask = pending(view)[0]!;
    expect(hrbpTask).toMatchObject({ nodeKey: 'in_hrbp' });
    const back = await w.request(s.inHrbp.userId, 'POST', `${APV}/tasks/${hrbpTask.id}/reject-previous`, {
      ifMatch: view.revision,
      body: { comment: '请调出部门复核' },
    });
    expect(back.status, await back.clone().text()).toBe(200);
    const after = await w.detail(view.id);
    expect(pending(after)).toEqual([
      expect.objectContaining({ nodeKey: 'out_head', assigneeUserId: s.outHead.userId }),
    ]);
    expect(after.tasks.filter((t) => t.status === 'history_skip')).toEqual([]);
  });
});
