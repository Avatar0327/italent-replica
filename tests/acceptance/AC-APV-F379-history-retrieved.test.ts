/**
 * F-379（F-318a R2 P2-F4）：“历史审批人相同 → 自动同意”只认未被撤回的同意（DEC-097、DEC-124）；
 * 系统自动同意（same_skip / history_skip）仍参与历史比较，口径不变（DEC-106、DEC-114）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
type Scene = Awaited<ReturnType<typeof transferScene>>;
const historyApprove = { historySameAssigneeSkip: true, historySameAssigneeResult: 'approve' as const };

async function threeNodeScene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await w.publishedProcess({
    nodes: [
      {
        key: 'one',
        approver: { type: 'specified', value: s.outHead.userId },
        actions: { retrieve: true, transfer: true },
      },
      { key: 'two', approver: { type: 'specified', value: s.inHead.userId } },
      { key: 'three', approver: { type: 'specified', value: s.outHead.userId }, ...historyApprove },
    ],
  });
  const current = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  return { w, s, current };
}

async function act(response: Response): Promise<InstanceView> {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as InstanceView;
}

/** 当前唯一待办，且属于 user。 */
function onlyPending(w: ApprovalWorld, current: InstanceView, user: string) {
  const pending = w.pending(current);
  expect(pending.map((task) => task.assigneeUserId)).toEqual([user]);
  return pending[0]!;
}

async function approvePending(w: ApprovalWorld, current: InstanceView, user: string) {
  const task = onlyPending(w, current, user);
  return act(await w.taskAction(user, task.id, 'approve', current.revision));
}

async function retrieve(w: ApprovalWorld, current: InstanceView, user: string, taskId: string) {
  const path = `/api/tenant/approval/tasks/${taskId}/retrieve`;
  return act(await w.request(user, 'POST', path, { ifMatch: current.revision, body: {} }));
}

async function transferPending(w: ApprovalWorld, current: InstanceView, from: string, to: string) {
  const task = onlyPending(w, current, from);
  return act(await w.taskAction(from, task.id, 'transfer', current.revision, { toUserId: to }));
}

const tasksOf = (current: InstanceView, nodeKey: string) =>
  current.tasks
    .filter((task) => task.nodeKey === nodeKey)
    .map((task) => ({ status: task.status, origin: task.origin, assigneeUserId: task.assigneeUserId }));

const historySkipped = (s: Scene) => [{ status: 'approved', origin: 'history_skip', assigneeUserId: s.outHead.userId }];

describe('AC-APV-F379 历史相同自动处理排除已撤回的同意', () => {
  it('A 同意节点一后撤回并转交 C、C 同意：节点三给 A 人工待办，不按历史相同自动通过', async () => {
    const { w, s, current: submitted } = await threeNodeScene('f379-retrieved-transfer');
    let current = submitted;
    const original = onlyPending(w, current, s.outHead.userId);
    current = await approvePending(w, current, s.outHead.userId);
    current = await retrieve(w, current, s.outHead.userId, original.id);
    const replacement = await w.person('接手审批人', s.from);
    current = await transferPending(w, current, s.outHead.userId, replacement.userId);
    current = await approvePending(w, current, replacement.userId);
    current = await approvePending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'three')).toEqual([
      { status: 'pending', origin: 'resolved', assigneeUserId: s.outHead.userId },
    ]);
    expect(current.status).toBe('running');
  });

  it('反例：A 同意节点一且未撤回，节点三仍按历史相同自动同意', async () => {
    const { w, s, current: submitted } = await threeNodeScene('f379-kept');
    let current = submitted;
    current = await approvePending(w, current, s.outHead.userId);
    current = await approvePending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'three')).toEqual(historySkipped(s));
    expect(current.status).toBe('approved');
  });

  it('撤回后由 A 本人重新同意：新同意有效，节点三按历史相同自动同意', async () => {
    const { w, s, current: submitted } = await threeNodeScene('f379-reapproved');
    let current = submitted;
    const original = onlyPending(w, current, s.outHead.userId);
    current = await approvePending(w, current, s.outHead.userId);
    current = await retrieve(w, current, s.outHead.userId, original.id);
    current = await approvePending(w, current, s.outHead.userId);
    current = await approvePending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'three')).toEqual(historySkipped(s));
    expect(current.status).toBe('approved');
  });

  it('系统自动同意（same_skip）仍计入历史同意：A 未人工同意，节点四仍按历史相同自动同意', async () => {
    const w = await approvalWorld(database().db, 'f379-auto-approval');
    const s = await transferScene(w);
    const outHead = { type: 'specified' as const, value: s.outHead.userId };
    await w.publishedProcess({
      nodes: [
        { key: 'one', approver: outHead, actions: { transfer: true } },
        { key: 'two', approver: outHead, sameAssigneeSkip: true, sameAssigneeResult: 'approve' },
        { key: 'three', approver: { type: 'specified', value: s.inHead.userId } },
        { key: 'four', approver: outHead, ...historyApprove },
      ],
    });
    let current = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const replacement = await w.person('接手审批人', s.from);
    current = await transferPending(w, current, s.outHead.userId, replacement.userId);
    current = await approvePending(w, current, replacement.userId);
    expect(tasksOf(current, 'two')).toEqual([
      { status: 'approved', origin: 'same_skip', assigneeUserId: s.outHead.userId },
    ]);
    current = await approvePending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'four')).toEqual(historySkipped(s));
    expect(current.status).toBe('approved');
  });
});
