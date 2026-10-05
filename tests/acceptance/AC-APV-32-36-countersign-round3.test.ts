/**
 * F-003 第三轮（PR #58 astra 第二轮复审 P2-N1、P2-N2）：
 * AC-APV-32 回归——系统交接 / 停用接管合并席位后重新结算前复核业务版本：业务单已被改动时，旧票不能使节点流转；
 * AC-APV-36 回归——会签节点前加签未完成即因流转而结束时，撤回不能绕过前加签义务（同 F4：不能恢复的加签义务拒绝撤回）。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type TaskView,
} from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
};
const FIRST: NodeInput = { key: 'out_head', name: '调出负责人审批', approver: 'latest_record_department_head' };
const FINAL: NodeInput = { key: 'final', name: '调出负责人确认', approver: 'latest_record_department_head' };

const pendingOf = (view: InstanceView) => view.tasks.filter((task) => task.status === 'pending');

function taskOf(view: InstanceView, userId: string, status = 'pending', nodeKey = 'joint'): TaskView {
  const task = view.tasks
    .filter((item) => item.assigneeUserId === userId && item.status === status && item.nodeKey === nodeKey)
    .at(-1);
  expect(task, `${userId} 在 ${nodeKey} 的 ${status} 任务`).toBeDefined();
  return task!;
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

async function act(w: ApprovalWorld, view: InstanceView, userId: string, action: 'approve' | 'reject') {
  return w.json<InstanceView>(await w.taskAction(userId, taskOf(view, userId).id, action, view.revision));
}

function retrieve(w: ApprovalWorld, userId: string, taskId: string, revision: number) {
  return w.request(userId, 'POST', `${BASE}/tasks/${taskId}/retrieve`, { ifMatch: revision });
}

/** 模拟绕过审批的写入路径（导入、向后更新）给申请追加了一版载荷（同 AC-APV-TRF-28）。 */
async function bumpPayload(w: ApprovalWorld, businessId: string) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`INSERT INTO employment_payload_versions
      SELECT (jsonb_populate_record(NULL::employment_payload_versions, to_jsonb(p) || jsonb_build_object(
        'id', gen_random_uuid(), 'version_no', p.version_no + 1, 'place', '绕过修改'))).*
      FROM employment_payload_versions p WHERE p.business_id=${businessId}::uuid
      ORDER BY p.version_no DESC LIMIT 1`),
  );
}

describe('AC-APV-32 回归：系统接管合并席位后的重新结算复核业务版本（P2-N1）', () => {
  it('需所有人同意、A 已同意：载荷被改动后把异常待办交接给 A，席位合并但不流转，业务单不获批', async () => {
    const w = await approvalWorld(database().db, 'apv-r3-merge-stale');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [FIRST, { ...JOINT, transitionRule: { type: 'all' } }] });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '原地点' });
    const submitted = await w.submit(draft);
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(submitted)[0]!.id, 'approve', submitted.revision),
    );
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('joint');
    await bumpPayload(w, draft.id);
    const stale = await w.taskAction(w.exceptionAdmin, taskOf(view, w.exceptionAdmin).id, 'approve', view.revision);
    expect(await reasonOf(stale)).toEqual({ status: 409, reason: 'APPROVAL_BUSINESS_CHANGED' });

    const configAdmin = await w.member('配置管理员');
    const handover = await w.json<{ tasks: number }>(
      await w.request(configAdmin, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: s.inHead.userId },
      }),
    );
    expect(handover.tasks).toBe(1);
    const after = await w.detail(view.id);
    expect(after).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(taskOf(after, s.inHead.userId, 'merged')).toBeDefined();
    expect(after.logs.filter((log) => log.event === 'countersign_flow')).toEqual([]);
    expect((await w.business(draft.id)).status).toBe('in_review');
    // 实例已冻结（审批动作一律 APPROVAL_BUSINESS_CHANGED），发起人撤回后可重新提交，不会卡死。
    expect((await w.instanceAction(w.hr.id, after.id, 'withdraw', after.revision)).status).toBe(200);
  });
});

describe('AC-APV-36 回归：前加签未完成即因流转而结束时，撤回不能绕过前加签（P2-N2，DEC-152 / F4）', () => {
  const nodes: NodeInput[] = [{ ...JOINT, actions: { addSign: true, retrieve: true } }, FINAL];

  it('A 前加签 C、C 未处理，B 同意使节点流转：B 不能撤回（无法恢复未完成的前加签义务），详情不公布撤回', async () => {
    const w = await approvalWorld(database().db, 'apv-r3-before-retrieve');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes });
    const submitted = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const signer = await w.member('前加签人');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.inHead.userId, taskOf(submitted, s.inHead.userId).id, 'add-sign', submitted.revision, {
        userIds: [signer],
        type: 'before',
      }),
    );
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(taskOf(view, signer, 'ended')).toBeDefined();
    expect((await w.detail(view.id, s.inHrbp.userId)).actions).not.toContain('retrieve');
    const approved = taskOf(view, s.inHrbp.userId, 'approved');
    expect(await reasonOf(await retrieve(w, s.inHrbp.userId, approved.id, view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_NOT_RETRIEVABLE',
    });
    const unchanged = await w.detail(view.id);
    expect(unchanged).toMatchObject({ currentNodeKey: 'final', revision: view.revision });
  });

  it('前加签已完成（C 已同意、回到 A）后 B 同意使节点流转：B 仍可撤回，A 恢复待办', async () => {
    const w = await approvalWorld(database().db, 'apv-r3-before-done-retrieve');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes });
    const submitted = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const signer = await w.member('前加签人');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.inHead.userId, taskOf(submitted, s.inHead.userId).id, 'add-sign', submitted.revision, {
        userIds: [signer],
        type: 'before',
      }),
    );
    view = await act(w, view, signer, 'approve');
    expect(taskOf(view, s.inHead.userId)).toBeDefined();
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    view = await w.json(
      await retrieve(w, s.inHrbp.userId, taskOf(view, s.inHrbp.userId, 'approved').id, view.revision),
    );
    expect(view.currentNodeKey).toBe('joint');
    expect(
      pendingOf(view)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.inHead.userId, s.inHrbp.userId].sort());
  });
});
