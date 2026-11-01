/**
 * F-392（F-379 R1 转出）：撤回让流程回到被撤回同意所在的节点，撤回点之后的旧自动结果（历史相同 / 相同审批人等自动同意）
 * 随回退一并失效，不再作为“历史审批人相同”的依据；撤回点之前仍有效的自动同意照常参与历史比较（DEC-097、DEC-106、
 * DEC-124）。失效只是不再参与判定，任务与时间线全部保留。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type ApprovalWorld, type InstanceView } from './AC-APV-support.js';

const database = useTestDb();
type Scene = Awaited<ReturnType<typeof transferScene>>;
const historyApprove = { historySameAssigneeSkip: true, historySameAssigneeResult: 'approve' as const };

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

const historySkipped = (user: string) => ({ status: 'approved', origin: 'history_skip', assigneeUserId: user });

/** A → A（历史相同自动同意）→ B：A 同意首节点后，第二节点按历史相同自动同意，待办到 B。 */
async function rewindScene(label: string) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const a = { type: 'specified' as const, value: s.outHead.userId };
  await w.publishedProcess({
    nodes: [
      { key: 'one', approver: a, actions: { retrieve: true, transfer: true } },
      { key: 'two', approver: a, ...historyApprove },
      { key: 'three', approver: { type: 'specified', value: s.inHead.userId } },
    ],
  });
  let current = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  const original = onlyPending(w, current, s.outHead.userId);
  current = await approvePending(w, current, s.outHead.userId);
  expect(tasksOf(current, 'two')).toEqual([historySkipped(s.outHead.userId)]);
  onlyPending(w, current, s.inHead.userId);
  return { w, s, current, original };
}

/** 撤回首节点：待办回到 A，第二节点的旧自动同意保留在任务里。 */
async function retrieveFirst(scene: Awaited<ReturnType<typeof rewindScene>>) {
  const { w, s, original } = scene;
  return retrieve(w, scene.current, s.outHead.userId, original.id);
}

describe('AC-APV-F392 撤回后旧自动同意不再作为历史依据', () => {
  it('A 撤回首节点并转交 C、C 同意：第二节点重新给 A 人工待办，旧自动同意仍留在记录里', async () => {
    const scene = await rewindScene('f392-rewound');
    const { w, s } = scene;
    let current = await retrieveFirst(scene);
    const replacement = await w.person('接手审批人', s.from);
    current = await transferPending(w, current, s.outHead.userId, replacement.userId);
    current = await approvePending(w, current, replacement.userId);
    expect(tasksOf(current, 'two')).toEqual([
      historySkipped(s.outHead.userId),
      { status: 'pending', origin: 'resolved', assigneeUserId: s.outHead.userId },
    ]);
    expect(current.status).toBe('running');
    current = await approvePending(w, current, s.outHead.userId);
    onlyPending(w, current, s.inHead.userId);
  });

  it('反例：未撤回时第二节点照常按历史相同自动同意，流程到 B 后结束', async () => {
    const { w, s, current: started } = await rewindScene('f392-kept');
    const current = await approvePending(w, started, s.inHead.userId);
    expect(tasksOf(current, 'two')).toEqual([historySkipped(s.outHead.userId)]);
    expect(current.status).toBe('approved');
  });

  it('撤回后由 A 本人重新同意首节点：新同意有效，第二节点再次按历史相同自动同意', async () => {
    const scene = await rewindScene('f392-reapproved');
    const { w, s } = scene;
    let current = await retrieveFirst(scene);
    current = await approvePending(w, current, s.outHead.userId);
    expect(tasksOf(current, 'two')).toEqual([historySkipped(s.outHead.userId), historySkipped(s.outHead.userId)]);
    current = await approvePending(w, current, s.inHead.userId);
    expect(current.status).toBe('approved');
  });

  it('撤回点之前的自动同意仍有效：B 撤回节点三后重新同意，节点四仍凭节点二的自动同意按历史相同通过', async () => {
    const w = await approvalWorld(database().db, 'f392-before-rewind');
    const s: Scene = await transferScene(w);
    const a = { type: 'specified' as const, value: s.outHead.userId };
    const b = { type: 'specified' as const, value: s.inHead.userId };
    await w.publishedProcess({
      nodes: [
        { key: 'one', approver: a, actions: { transfer: true } },
        { key: 'two', approver: a, sameAssigneeSkip: true, sameAssigneeResult: 'approve' },
        { key: 'three', approver: b, actions: { retrieve: true } },
        { key: 'four', approver: a, ...historyApprove },
        { key: 'five', approver: b },
      ],
    });
    let current = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    // A 不亲自同意：首节点转交 C，节点二因与上一节点候选人相同而自动同意，A 的历史同意只来自这条自动同意
    const replacement = await w.person('接手审批人', s.from);
    current = await transferPending(w, current, s.outHead.userId, replacement.userId);
    current = await approvePending(w, current, replacement.userId);
    expect(tasksOf(current, 'two')).toEqual([
      { status: 'approved', origin: 'same_skip', assigneeUserId: s.outHead.userId },
    ]);
    const third = onlyPending(w, current, s.inHead.userId);
    current = await approvePending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'four')).toEqual([historySkipped(s.outHead.userId)]);
    current = await retrieve(w, current, s.inHead.userId, third.id);
    current = await approvePending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'four')).toEqual([historySkipped(s.outHead.userId), historySkipped(s.outHead.userId)]);
    onlyPending(w, current, s.inHead.userId);
    expect(tasksOf(current, 'five').map((task) => task.status)).toEqual(['cancelled', 'pending']);
  });
});
