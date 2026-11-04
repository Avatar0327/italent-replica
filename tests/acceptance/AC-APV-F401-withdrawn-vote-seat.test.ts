/**
 * F-401（F-392 Sol high R1 P2）：会签节点上已撤回的同意不再占席。
 * 会签 A、B 同意 → A 撤回 → 转给 C → C 转回 A：A 的旧同意已被撤回、由撤回后的新待办接续，转回应成功且只计一票；
 * 未撤回的同意（B）仍占席，转给 B 仍报 APPROVAL_ALREADY_NODE_ASSIGNEE（一人一票，F-003 P2-1）。
 */
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
  approvers: [
    { type: 'department', value: 'record_department_head' },
    { type: 'department', value: 'record_department_hrbp' },
  ],
  actions: { transfer: true, retrieve: true },
  transitionRule: { type: 'all' },
};
const FINAL: NodeInput = {
  key: 'final',
  name: '调出负责人确认',
  approver: { type: 'department', value: 'latest_record_department_head' },
};

function taskOf(view: InstanceView, userId: string, status: string): TaskView {
  const task = view.tasks
    .filter((item) => item.assigneeUserId === userId && item.status === status && item.nodeKey === 'joint')
    .at(-1);
  expect(task, `${userId} 在 joint 的 ${status} 任务`).toBeDefined();
  return task!;
}

async function act(w: ApprovalWorld, view: InstanceView, userId: string, action: 'approve' | 'transfer', body = {}) {
  return w.taskAction(userId, taskOf(view, userId, 'pending').id, action, view.revision, body);
}

async function reasonOf(response: Response) {
  const body = (await response.json()) as { error?: { details?: { reason?: string } } };
  return { status: response.status, reason: body.error?.details?.reason };
}

/** A（inHead）、B（inHrbp）都同意后 A 撤回，A 的新待办回到本节点；C 是节点外的第三人。 */
async function aRetrieved(name: string) {
  const w = await approvalWorld(database().db, name);
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [JOINT, FINAL] });
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
  let view = await w.submit(draft);
  view = await w.json<InstanceView>(await act(w, view, s.inHead.userId, 'approve'));
  view = await w.json<InstanceView>(await act(w, view, s.inHrbp.userId, 'approve'));
  expect(view.currentNodeKey).toBe('final');
  const retrieved = await w.request(
    s.inHead.userId,
    'POST',
    `${BASE}/tasks/${taskOf(view, s.inHead.userId, 'approved').id}/retrieve`,
    {
      ifMatch: view.revision,
    },
  );
  view = await w.json<InstanceView>(retrieved);
  expect(view.currentNodeKey).toBe('joint');
  return { w, s, view, c: await w.member('转交接手人') };
}

describe('AC-APV-F401 已撤回的同意不占会签席位', () => {
  it('A、B 同意 → A 撤回 → 转给 C → C 转回 A 成功，A 再同意只计一票', async () => {
    const { w, s, view: retrieved, c } = await aRetrieved('apv-f401-back-to-a');
    let view = await w.json<InstanceView>(await act(w, retrieved, s.inHead.userId, 'transfer', { toUserId: c }));
    expect(taskOf(view, c, 'pending')).toBeDefined();
    const back = await act(w, view, c, 'transfer', { toUserId: s.inHead.userId });
    expect(await reasonOf(back.clone())).toEqual({ status: 200, reason: undefined });
    view = await w.json<InstanceView>(back);
    expect(view.tasks.filter((task) => task.status === 'pending').map((task) => task.assigneeUserId)).toEqual([
      s.inHead.userId,
    ]);
    view = await w.json<InstanceView>(await act(w, view, s.inHead.userId, 'approve'));
    expect(view.currentNodeKey).toBe('final');
    // 第二次流转：A（新票）与 B 各一票，撤回的旧票不计。
    const flows = view.logs.filter((log) => log.event === 'countersign_flow');
    expect(flows).toHaveLength(2);
    expect(flows[1]).toMatchObject({ detail: { exit: 'approve', count: 2, threshold: 2 } });
  });

  it('对照：未撤回的同意仍占席——A 撤回后转给 C、C 转给 B（B 的同意仍有效）仍报一人一票', async () => {
    const { w, s, view: retrieved, c } = await aRetrieved('apv-f401-voted-b');
    const view = await w.json<InstanceView>(await act(w, retrieved, s.inHead.userId, 'transfer', { toUserId: c }));
    expect(await reasonOf(await act(w, view, c, 'transfer', { toUserId: s.inHrbp.userId }))).toEqual({
      status: 400,
      reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE',
    });
  });
});
