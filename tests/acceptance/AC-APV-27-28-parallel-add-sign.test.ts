/**
 * F-003：并加签与“开启加签须有同意出口线”的发布校验（DEC-117、DEC-144，`14` §11.4、§12，CustomerKB 109710739）。
 * AC-APV-27 并加签只在会签节点可用：并加签人与原审批人同时审批、无先后，计入节点流转规则（DEC-144）；单人节点仍只有
 * 前 / 后加签（DEC-095 口径不变），对单人节点请求并加签、对会签节点请求前 / 后加签都返回明确错误；嵌套加签维持拒绝
 * （F5）；加签人驳回沿用现有规则，任一人驳回即整单驳回。
 * AC-APV-28 节点出口动作与发布校验：勾选加签（或开启相同 / 历史相同审批人自动处理）而没有「同意」出口动作时发布被拒；
 * 「不同意」出口动作只在配置了时可用（单人节点同样，一人不同意即沿不同意流转）。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type ProcessView,
  type TaskView,
} from './AC-APV-support.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
  actions: { addSign: true },
};
const FINAL: NodeInput = { key: 'final', name: '一级组织负责人审批', approver: 'record_first_level_org_head' };

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

async function started(w: ApprovalWorld, nodes: readonly NodeInput[]) {
  const s = await transferScene(w);
  const finance = await w.member('财务');
  await w.publishedProcess({ nodes });
  return { s, finance, view: await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to })) };
}

function parallel(w: ApprovalWorld, actor: string, view: InstanceView, userIds: string[]) {
  return w.taskAction(actor, taskOf(view, actor).id, 'add-sign', view.revision, { userIds, type: 'parallel' });
}

async function act(w: ApprovalWorld, view: InstanceView, userId: string, action: 'approve' | 'disagree' | 'reject') {
  return w.json<InstanceView>(await w.taskAction(userId, taskOf(view, userId).id, action, view.revision));
}

describe('AC-APV-27 并加签（只在会签节点）', () => {
  it('任一人同意即可：并加签人与原审批人同时审批，加签人同意即流转，其余任务因节点已通过而结束', async () => {
    const w = await approvalWorld(database().db, 'apv-ps-any');
    const { s, finance, view: submitted } = await started(w, [JOINT, FINAL]);
    let view = await w.json<InstanceView>(await parallel(w, s.inHead.userId, submitted, [finance]));
    expect(view.currentNodeKey).toBe('joint');
    expect(
      pendingOf(view)
        .map((task) => [task.assigneeUserId, task.origin])
        .sort(),
    ).toEqual(
      [
        [s.inHead.userId, 'resolved'],
        [s.inHrbp.userId, 'resolved'],
        [finance, 'add_sign_parallel'],
      ].sort(),
    );
    expect(taskOf(view, finance).parentTaskId).toBe(taskOf(view, s.inHead.userId).id);
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'add_sign_parallel', detail: expect.objectContaining({ toUserId: finance }) }),
      ]),
    );
    expect((await w.todos(finance)).items).toEqual([expect.objectContaining({ instanceId: view.id })]);
    view = await act(w, view, finance, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(taskOf(view, s.inHead.userId, 'ended')).toBeDefined();
    expect(taskOf(view, s.inHrbp.userId, 'ended')).toBeDefined();
  });

  it('需所有人同意：并加签人也计入，原审批人都同意后仍要等加签人同意才流转', async () => {
    const w = await approvalWorld(database().db, 'apv-ps-all');
    const { s, finance, view: submitted } = await started(w, [{ ...JOINT, transitionRule: { type: 'all' } }, FINAL]);
    let view = await w.json<InstanceView>(await parallel(w, s.inHead.userId, submitted, [finance]));
    view = await act(w, view, s.inHead.userId, 'approve');
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: finance })]);
    view = await act(w, view, finance, 'approve');
    expect(view.currentNodeKey).toBe('final');
  });

  it('单人节点请求并加签、会签节点请求后加签：都返回明确错误，任务不动（会签前加签见 AC-APV-36，DEC-152）', async () => {
    const w = await approvalWorld(database().db, 'apv-ps-types');
    const s = await transferScene(w);
    const finance = await w.member('财务');
    await w.publishedProcess({ nodes: [{ ...TRANSFER_NODES[0]!, actions: { addSign: true } }, JOINT] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const single = pendingOf(view)[0]!;
    expect(
      await reasonOf(
        await w.taskAction(s.outHead.userId, single.id, 'add-sign', view.revision, {
          userIds: [finance],
          type: 'parallel',
        }),
      ),
    ).toEqual({ status: 409, reason: 'APPROVAL_ADD_SIGN_TYPE_UNSUPPORTED' });
    view = await w.json(await w.taskAction(s.outHead.userId, single.id, 'approve', view.revision));
    expect(
      await reasonOf(
        await w.taskAction(s.inHead.userId, taskOf(view, s.inHead.userId).id, 'add-sign', view.revision, {
          userIds: [finance],
          type: 'after',
        }),
      ),
    ).toEqual({ status: 409, reason: 'APPROVAL_ADD_SIGN_TYPE_UNSUPPORTED' });
    const unchanged = await w.detail(view.id);
    expect(unchanged.revision).toBe(view.revision);
    expect(pendingOf(unchanged)).toHaveLength(2);
  });

  it('加签人不能再加签；不能加签给本节点已在办的审批人；加签人驳回即整单驳回', async () => {
    const w = await approvalWorld(database().db, 'apv-ps-nested');
    const { s, finance, view: submitted } = await started(w, [{ ...JOINT, transitionRule: { type: 'all' } }, FINAL]);
    const auditor = await w.member('审计');
    expect(await reasonOf(await parallel(w, s.inHead.userId, submitted, [s.inHrbp.userId]))).toEqual({
      status: 400,
      reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE',
    });
    let view = await w.json<InstanceView>(await parallel(w, s.inHead.userId, submitted, [finance]));
    expect(await reasonOf(await parallel(w, finance, view, [auditor]))).toEqual({
      status: 409,
      reason: 'APPROVAL_ADD_SIGN_NESTED',
    });
    const signerView = await w.detail(view.id, finance);
    expect(signerView.actions).toEqual(expect.arrayContaining(['approve', 'reject']));
    expect(signerView.actions).not.toContain('addSign');
    view = await w.json(
      await w.taskAction(finance, taskOf(view, finance).id, 'reject', view.revision, { comment: '预算不足' }),
    );
    expect(view.status).toBe('returned');
    expect(pendingOf(view)).toEqual([]);
    expect(taskOf(view, s.inHead.userId, 'cancelled')).toBeDefined();
  });

  it('加签人的「不同意」同样按流转规则计数（任一人同意即可：「不同意」= 整数 1）', async () => {
    const w = await approvalWorld(database().db, 'apv-ps-disagree');
    const { s, finance, view: submitted } = await started(w, [{ ...JOINT, exits: ['approve', 'disagree'] }, FINAL]);
    let view = await w.json<InstanceView>(await parallel(w, s.inHead.userId, submitted, [finance]));
    view = await act(w, view, finance, 'disagree');
    expect(view.status).toBe('disapproved');
    expect(taskOf(view, s.inHead.userId, 'ended')).toBeDefined();
  });
});

describe('AC-APV-28 节点出口动作与发布校验', () => {
  let priority = 0;
  /** 每条流程用不同优先级，能发布的几条不会因同优先级被拒（DEC-096）。 */
  async function publishResult(w: ApprovalWorld, nodes: readonly NodeInput[]) {
    const draft: ProcessView = await w.createProcess({ nodes, priority: ++priority });
    return w.request(w.hr.id, 'POST', `${BASE}/processes/${draft.id}/publish`, { ifMatch: draft.revision });
  }

  it('勾选加签的节点没有「同意」出口动作：草稿可保存，发布被拒；有同意出口动作后可以发布', async () => {
    const w = await approvalWorld(database().db, 'apv-exit-publish');
    for (const node of [
      { ...TRANSFER_NODES[0]!, actions: { addSign: true }, exits: ['disagree'] as const },
      { ...JOINT, exits: ['disagree'] as const },
    ]) {
      const response = await publishResult(w, [node]);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string; details: { reason: string } } };
      expect(body.error.details.reason).toBe('APPROVAL_ADD_SIGN_APPROVE_EXIT_REQUIRED');
      expect(body.error.message).toBe(`勾选加签的${node.name}节点必须配置同意出口线`);
    }
    const auto = await publishResult(w, [{ ...TRANSFER_NODES[0]!, sameAssigneeSkip: true, exits: ['disagree'] }]);
    expect(await reasonOf(auto)).toEqual({ status: 400, reason: 'APPROVAL_AUTO_APPROVE_EXIT_REQUIRED' });
    const fixed = await publishResult(w, [{ ...TRANSFER_NODES[0]!, actions: { addSign: true } }]);
    expect(fixed.status).toBe(200);
    const vetoOnly = await publishResult(w, [{ ...TRANSFER_NODES[0]!, exits: ['disagree'] }]);
    expect(vetoOnly.status).toBe(200);
  });

  it('单人节点：缺省只有「同意」出口动作；配了「不同意」时一人不同意即沿不同意连线流转到结束', async () => {
    const w = await approvalWorld(database().db, 'apv-exit-single');
    const s = await transferScene(w);
    const process = await w.publishedProcess({
      nodes: [{ ...TRANSFER_NODES[0]!, exits: ['approve', 'disagree'] }, FINAL],
    });
    expect(process.currentVersion!.nodes[1]).toMatchObject({ kind: 'single', exits: ['approve'] });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    expect((await w.detail(view.id, s.outHead.userId)).actions).toContain('disagree');
    const ended = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'disagree', view.revision, { comment: '不同意' }),
    );
    expect(ended).toMatchObject({ status: 'disapproved', currentNodeKey: null });
    expect((await w.detail(view.id)).actions).not.toContain('withdraw');
    expect(ended.tasks.find((task) => task.nodeKey === 'out_head')).toMatchObject({
      status: 'disagreed',
      comment: '不同意',
    });
  });
});
