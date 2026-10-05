/**
 * F-003 第二轮（PR #58 astra 首审 P2-1～4、DEC-144、DEC-152）：
 * AC-APV-32 会签一人一票——用户 ID 按数据库 UUID 语义规范化，已投过票的人不能再被加签 / 转交进来，系统交接让同一人
 * 承接多席时只计一票；AC-APV-33 「不同意」达标沿不同意连线流转到结束（流程结束、业务不生效）；AC-APV-34 系统自动结束 /
 * 撤回导致的取消不阻止审批人撤回；AC-APV-35 合并席位保留全部候选人（DEC-114）；AC-APV-36 会签节点前加签（DEC-152）；
 * AC-APV-37 驳回是节点开关；另补“只结算一次”守卫的区分测试（P3）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import type { CountersignApprovalNode } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { settleCountersign } from '../../apps/api/src/modules/approval/countersign.js';
import { openRun } from '../../apps/api/src/modules/approval/engine.js';
import { loadTasks } from '../../apps/api/src/modules/approval/store.js';
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

/** 调入部门负责人（inHead）与 HRBP（inHrbp）会签，缺省为任一人同意即可。 */
const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
};
const FINAL: NodeInput = { key: 'final', name: '调出负责人确认', approver: 'latest_record_department_head' };
const BOTH_EXITS = ['approve', 'disagree'] as const;

const pendingOf = (view: InstanceView) => view.tasks.filter((task) => task.status === 'pending');
const upper = (userId: string) => userId.toUpperCase();

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

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

async function started(w: ApprovalWorld, nodes: readonly NodeInput[]) {
  const s = await transferScene(w);
  await w.publishedProcess({ nodes });
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
  return { s, draft, view: await w.submit(draft) };
}

async function act(w: ApprovalWorld, view: InstanceView, userId: string, action: 'approve' | 'disagree' | 'reject') {
  return w.json<InstanceView>(await w.taskAction(userId, taskOf(view, userId).id, action, view.revision));
}

function addSign(w: ApprovalWorld, actor: string, view: InstanceView, userIds: string[], type: string) {
  return w.taskAction(actor, taskOf(view, actor).id, 'add-sign', view.revision, { userIds, type });
}

function retrieve(w: ApprovalWorld, userId: string, taskId: string, revision: number) {
  return w.request(userId, 'POST', `${BASE}/tasks/${taskId}/retrieve`, { ifMatch: revision });
}

describe('AC-APV-32 会签一人一票（P2-1）', () => {
  it('路径一：已同意的人不能再被并加签或转交进来；同一人只计一票，整数 2 需要两个人', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-voted');
    const rules = { approve: { kind: 'count' as const, value: 2 } };
    const { s, view: submitted } = await started(w, [
      { ...JOINT, actions: { addSign: true, transfer: true }, transitionRule: { type: 'custom', rules } },
      FINAL,
    ]);
    let view = await act(w, submitted, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('joint');
    expect(await reasonOf(await addSign(w, s.inHrbp.userId, view, [s.inHead.userId], 'parallel'))).toEqual({
      status: 400,
      reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE',
    });
    const hrbpTask = taskOf(view, s.inHrbp.userId);
    expect(
      await reasonOf(
        await w.taskAction(s.inHrbp.userId, hrbpTask.id, 'transfer', view.revision, { toUserId: s.inHead.userId }),
      ),
    ).toEqual({ status: 400, reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE' });
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    const voters = view.tasks.filter((task) => task.nodeKey === 'joint' && task.status === 'approved');
    expect(voters.map((task) => task.assigneeUserId).sort()).toEqual([s.inHead.userId, s.inHrbp.userId].sort());
  });

  it('路径二：用户 ID 按数据库 UUID 语义规范化——大写写法的本人、本节点审批人同样被认出', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-uppercase');
    const { s, view: submitted } = await started(w, [
      { ...JOINT, actions: { addSign: true, transfer: true }, transitionRule: { type: 'all' } },
      FINAL,
    ]);
    const head = taskOf(submitted, s.inHead.userId);
    const cases: [string, Record<string, unknown>, string][] = [
      ['add-sign', { userIds: [upper(s.inHead.userId)], type: 'parallel' }, 'APPROVAL_USER_INVALID'],
      ['add-sign', { userIds: [upper(s.inHrbp.userId)], type: 'parallel' }, 'APPROVAL_ALREADY_NODE_ASSIGNEE'],
      ['transfer', { toUserId: upper(s.inHead.userId) }, 'APPROVAL_USER_INVALID'],
      ['transfer', { toUserId: upper(s.inHrbp.userId) }, 'APPROVAL_ALREADY_NODE_ASSIGNEE'],
    ];
    for (const [action, body, reason] of cases) {
      const response = await w.taskAction(s.inHead.userId, head.id, action as 'transfer', submitted.revision, body);
      expect(await reasonOf(response), JSON.stringify(body)).toEqual({ status: 400, reason });
    }
    const outsider = await w.member('外部加签人');
    const duplicated = await addSign(w, s.inHead.userId, submitted, [outsider, upper(outsider)], 'parallel');
    expect(await reasonOf(duplicated)).toEqual({ status: 400, reason: 'APPROVAL_USER_INVALID' });
    // 以大写写法的身份操作：仍认得是本人的任务。
    const view = await w.json<InstanceView>(
      await w.taskAction(upper(s.inHead.userId), head.id, 'approve', submitted.revision),
    );
    expect(view.tasks.find((task) => task.id === head.id)).toMatchObject({ status: 'approved' });
    expect(view.currentNodeKey).toBe('joint');
  });

  it('系统交接让同一接手人承接多席：多出的席位记为“由同一人接手、不重复计票”，按一人一票结算', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-handover-merge');
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    // 会签 HRBP 一席为空 → 异常管理员（中间节点，DEC-054 / 098）；会签前先过调出负责人。
    const first: NodeInput = { key: 'out_head', name: '调出负责人审批', approver: 'latest_record_department_head' };
    await w.publishedProcess({ nodes: [first, { ...JOINT, transitionRule: { type: 'all' } }, FINAL] });
    const submitted = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const before = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(submitted)[0]!.id, 'approve', submitted.revision),
    );
    expect(taskOf(before, w.exceptionAdmin)).toMatchObject({ isExceptionAdmin: true });
    const configAdmin = await w.member('配置管理员');
    const handover = await w.json<{ tasks: number }>(
      await w.request(configAdmin, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: s.inHead.userId },
      }),
    );
    expect(handover.tasks).toBe(1);
    let view = await w.detail(before.id);
    expect(taskOf(view, s.inHead.userId, 'merged')).toMatchObject({ origin: 'handover', isExceptionAdmin: true });
    expect(pendingOf(view).filter((task) => task.assigneeUserId === s.inHead.userId)).toHaveLength(1);
    expect(view.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'countersign_merge',
          detail: expect.objectContaining({ toUserId: s.inHead.userId, reason: '由同一人接手、不重复计票' }),
        }),
      ]),
    );
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
  });
});

describe('AC-APV-33 「不同意」达标沿不同意连线流转到结束（P2-2，DEC-144）', () => {
  it('会签：流程结束、业务单“未通过”不生效，不能撤回、不能重提；其余待办自动结束，不进入下一节点', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-disagree-end');
    const { s, draft, view: submitted } = await started(w, [{ ...JOINT, exits: BOTH_EXITS }, FINAL]);
    const view = await act(w, submitted, s.inHead.userId, 'disagree');
    expect(view).toMatchObject({ status: 'disapproved', currentNodeKey: null });
    expect(taskOf(view, s.inHead.userId, 'disagreed')).toBeDefined();
    expect(taskOf(view, s.inHrbp.userId, 'ended')).toBeDefined();
    expect(view.tasks.some((task) => task.nodeKey === 'final')).toBe(false);
    expect(view.logs).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: 'disapprove', nodeKey: 'joint' })]),
    );
    const business = await w.business(draft.id);
    expect(business.status).toBe('disapproved');
    const initiatorView = await w.detail(view.id);
    expect(initiatorView.actions).not.toContain('withdraw');
    expect(initiatorView.actions).not.toContain('resubmit');
    expect(await reasonOf(await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_CLOSED',
    });
    expect((await w.submitRaw(business)).status).toBe(409);
  });

  it('员工子集变更：「不同意」后申请记为“未通过”，子集不写入，不能在原单重提', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-disagree-personnel');
    const s = await transferScene(w);
    const settings = await w.request(w.hr.id, 'PUT', '/api/tenant/settings/personnel.self_service_fields', {
      ifMatch: 0,
      body: { value: { education: ['school'] } },
    });
    expect(settings.status).toBe(200);
    await w.publishedProcess({
      approvalType: 'personnel_change',
      conditions: { items: [{ no: 1, field: 'request.subset', operator: 'eq', value: 'education' }] },
      nodes: [{ key: 'head', approver: 'latest_record_department_head', formFields: ['school'], exits: BOTH_EXITS }],
    });
    const path = `/api/tenant/personnel/employees/${s.subject.employeeId}/subsets/education`;
    const record = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', path, { ifMatch: 0, body: { school: '甲校', educationLevel: '本科' } }),
      201,
    );
    const created = await w.json<{ id: string }>(
      await w.request(s.subject.userId, 'POST', '/api/tenant/personnel/change-requests', {
        ifMatch: 0,
        body: {
          employeeId: s.subject.employeeId,
          subset: 'education',
          recordId: record.id,
          targetRevision: record.revision,
          values: { school: '乙校' },
        },
      }),
      201,
    );
    const submitted = await w.instanceOf(created.id, s.subject.userId);
    const ended = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, pendingOf(submitted)[0]!.id, 'disagree', submitted.revision),
    );
    expect(ended).toMatchObject({ status: 'disapproved', currentNodeKey: null });
    const status = await withTenant(w.db, w.tenant.id, async (tx) =>
      rowsOf<{ status: string }>(
        await tx.execute(sql`SELECT status FROM personnel_change_requests WHERE id=${created.id}::uuid`),
      ),
    );
    expect(status).toEqual([{ status: 'disapproved' }]);
    expect(
      await reasonOf(
        await w.instanceAction(s.subject.userId, ended.id, 'resubmit', ended.revision, { corrections: {} }),
      ),
    ).toEqual({ status: 409, reason: 'APPROVAL_NOT_RETURNED' });
  });
});

describe('AC-APV-34 系统自动结束 / 撤回导致的取消不阻止审批人撤回（P2-3）', () => {
  it('上游单人节点同意后，下一会签节点因相同审批人自动同意而通过、另一席自动结束：上游审批人仍可撤回', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-retrieve-upstream');
    const nodes: NodeInput[] = [
      {
        key: 'out_head',
        name: '调出负责人审批',
        approver: 'latest_record_department_head',
        actions: { retrieve: true },
      },
      {
        ...JOINT,
        approvers: ['latest_record_department_head', 'record_department_hrbp'],
        sameAssigneeSkip: true,
      },
      { key: 'final', name: '调入负责人审批', approver: 'record_department_head' },
    ];
    const { s, view: submitted } = await started(w, nodes);
    const first = taskOf(submitted, s.outHead.userId, 'pending', 'out_head');
    let view = await w.json<InstanceView>(
      await w.taskAction(s.outHead.userId, first.id, 'approve', submitted.revision),
    );
    expect(view.currentNodeKey).toBe('final');
    expect(taskOf(view, s.outHead.userId, 'approved')).toMatchObject({ origin: 'same_skip' });
    expect(taskOf(view, s.inHrbp.userId, 'ended')).toBeDefined();
    expect((await w.detail(view.id, s.outHead.userId)).actions).toContain('retrieve');
    view = await w.json(await retrieve(w, s.outHead.userId, first.id, view.revision));
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'out_head' });
    expect(taskOf(view, s.inHead.userId, 'cancelled', 'final')).toBeDefined();
    view = await w.json(
      await w.taskAction(
        s.outHead.userId,
        taskOf(view, s.outHead.userId, 'pending', 'out_head').id,
        'approve',
        view.revision,
      ),
    );
    expect(view.currentNodeKey).toBe('final');
  });

  it('需所有人同意：A 撤回再同意后，B 仍可撤回（之前那次流转被撤回取消的下游待办不算人工处理）', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-retrieve-twice');
    const { s, view: submitted } = await started(w, [
      { ...JOINT, transitionRule: { type: 'all' }, actions: { retrieve: true } },
      FINAL,
    ]);
    let view = await act(w, submitted, s.inHead.userId, 'approve');
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    view = await w.json(
      await retrieve(w, s.inHead.userId, taskOf(view, s.inHead.userId, 'approved').id, view.revision),
    );
    expect(view.currentNodeKey).toBe('joint');
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect((await w.detail(view.id, s.inHrbp.userId)).actions).toContain('retrieve');
    view = await w.json(
      await retrieve(w, s.inHrbp.userId, taskOf(view, s.inHrbp.userId, 'approved').id, view.revision),
    );
    expect(view.currentNodeKey).toBe('joint');
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.inHrbp.userId, origin: 'retrieve' })]);
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(pendingOf(view)).toEqual([expect.objectContaining({ nodeKey: 'final' })]);
  });
});

describe('AC-APV-35 合并席位保留全部候选人（P2-4，DEC-114）', () => {
  it('第一表达式回避本人后转经理 H、第二表达式直接是 H：合并为一席，下一节点仍为 H 时按相同审批人自动同意（与仿真一致）', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-merged-candidates');
    const s = await transferScene(w);
    // 调出部门负责人 = 异动本人（自审回避转其直线经理 H），调入部门负责人 = H。
    await w.setOrgRoles(s.from, { head: s.subject.employeeId });
    await w.setOrgRoles(s.to, { head: s.manager.employeeId });
    const nodes: NodeInput[] = [
      { ...JOINT, approvers: ['latest_record_department_head', 'record_department_head'] },
      { key: 'again', name: '调入负责人复核', approver: 'record_department_head', sameAssigneeSkip: true },
      { key: 'final', name: '调入HRBP审核', approver: 'record_department_hrbp' },
    ];
    const process = await w.publishedProcess({ nodes });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const seats = view.tasks.filter((task) => task.nodeKey === 'joint' && task.status === 'pending');
    expect(seats.map((task) => task.assigneeUserId)).toEqual([s.manager.userId]);
    view = await act(w, view, s.manager.userId, 'approve');
    expect(taskOf(view, s.manager.userId, 'approved', 'again')).toMatchObject({ origin: 'same_skip' });
    expect(view.currentNodeKey).toBe('final');

    const simulated = await w.json<{ nodes: { key: string; status: string; resolution?: string }[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/processes/${process.id}/simulate`, {
        body: {
          scope: 'published',
          data: {
            values: { processCode: 'TransferProcessNew' },
            relations: {
              latest_record_department_head: s.subject.userId,
              record_department_head: s.manager.userId,
              record_department_hrbp: s.inHrbp.userId,
            },
            managers: { [s.subject.userId]: s.manager.userId },
            subjectUserId: s.subject.userId,
          },
        },
      }),
    );
    expect(simulated.nodes[1]).toMatchObject({ key: 'again', status: 'pass', resolution: 'same_skip' });
  });
});

describe('AC-APV-36 会签节点前加签（DEC-152）', () => {
  it('任一人同意即可：前加签人依次先审，同意后回到原席位；前加签人的同意不计入流转规则', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-before-any');
    const { s, view: submitted } = await started(w, [{ ...JOINT, actions: { addSign: true } }, FINAL]);
    const [first, second] = [await w.member('前加签人一'), await w.member('前加签人二')];
    const head = taskOf(submitted, s.inHead.userId);
    let view = await w.json<InstanceView>(await addSign(w, s.inHead.userId, submitted, [first, second], 'before'));
    expect(view.tasks.find((task) => task.id === head.id)).toMatchObject({ status: 'add_signed' });
    expect(taskOf(view, first)).toMatchObject({ origin: 'add_sign_before', parentTaskId: head.id });
    expect(view.tasks.find((task) => task.assigneeUserId === second)).toMatchObject({ status: 'queued' });
    view = await act(w, view, first, 'approve');
    expect(view.currentNodeKey).toBe('joint');
    view = await act(w, view, second, 'approve');
    expect(view.currentNodeKey).toBe('joint');
    expect(
      pendingOf(view)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.inHead.userId, s.inHrbp.userId].sort());
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(taskOf(view, s.inHrbp.userId, 'ended')).toBeDefined();
    expect(view.logs.filter((log) => log.event === 'countersign_flow')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ exit: 'approve', count: 1, threshold: 1 }) }),
    ]);
  });

  it('需所有人同意：前加签期间原席位仍未处理，其他人同意不使节点流转；前加签人不能不同意、不能再加签', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-before-all');
    const { s, view: submitted } = await started(w, [
      { ...JOINT, exits: BOTH_EXITS, transitionRule: { type: 'all' }, actions: { addSign: true } },
      FINAL,
    ]);
    const signer = await w.member('前加签人');
    let view = await w.json<InstanceView>(await addSign(w, s.inHead.userId, submitted, [signer], 'before'));
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('joint');
    const signerView = await w.detail(view.id, signer);
    expect(signerView.actions).toEqual(expect.arrayContaining(['approve', 'reject']));
    expect(signerView.actions).not.toContain('disagree');
    expect(signerView.actions).not.toContain('addSign');
    expect(await reasonOf(await w.taskAction(signer, taskOf(view, signer).id, 'disagree', view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_ACTION_DISABLED',
    });
    const outsider = await w.member('再加签人');
    expect(await reasonOf(await addSign(w, signer, view, [outsider], 'parallel'))).toEqual({
      status: 409,
      reason: 'APPROVAL_ADD_SIGN_NESTED',
    });
    view = await act(w, view, signer, 'approve');
    expect(view.currentNodeKey).toBe('joint');
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
  });

  it('前加签人驳回即整单驳回；会签节点不支持后加签；不能前加签给本节点的审批人', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-before-reject');
    const { s, view: submitted } = await started(w, [{ ...JOINT, actions: { addSign: true } }, FINAL]);
    const signer = await w.member('前加签人');
    expect(await reasonOf(await addSign(w, s.inHead.userId, submitted, [signer], 'after'))).toEqual({
      status: 409,
      reason: 'APPROVAL_ADD_SIGN_TYPE_UNSUPPORTED',
    });
    expect(await reasonOf(await addSign(w, s.inHead.userId, submitted, [s.inHrbp.userId], 'before'))).toEqual({
      status: 400,
      reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE',
    });
    let view = await w.json<InstanceView>(await addSign(w, s.inHead.userId, submitted, [signer], 'before'));
    view = await act(w, view, signer, 'reject');
    expect(view.status).toBe('returned');
    expect(pendingOf(view)).toEqual([]);
  });

  it('前加签期间其他人同意使节点流转（任一人同意即可）：原席位与前加签人的待办自动结束', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-before-flow');
    const { s, view: submitted } = await started(w, [{ ...JOINT, actions: { addSign: true } }, FINAL]);
    const signer = await w.member('前加签人');
    const head = taskOf(submitted, s.inHead.userId);
    let view = await w.json<InstanceView>(await addSign(w, s.inHead.userId, submitted, [signer], 'before'));
    view = await act(w, view, s.inHrbp.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    expect(view.tasks.find((task) => task.id === head.id)).toMatchObject({ status: 'ended' });
    expect(taskOf(view, signer, 'ended')).toBeDefined();
  });
});

describe('AC-APV-37 驳回是节点开关（F-003 第二轮）', () => {
  it('关闭后会签与单人节点都不能驳回（加签人同样），详情不公布；缺省开启', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-reject-switch');
    const { s, view: submitted } = await started(w, [
      { ...JOINT, actions: { addSign: true, reject: false } },
      { ...FINAL, actions: { reject: false } },
    ]);
    const process = await w.instanceOf(submitted.businessId);
    expect(process.id).toBe(submitted.id);
    const detail = await w.detail(submitted.id, s.inHead.userId);
    expect(detail.actions).toContain('approve');
    expect(detail.actions).not.toContain('reject');
    expect(
      await reasonOf(
        await w.taskAction(s.inHead.userId, taskOf(submitted, s.inHead.userId).id, 'reject', submitted.revision),
      ),
    ).toEqual({ status: 409, reason: 'APPROVAL_ACTION_DISABLED' });
    const signer = await w.member('并加签人');
    let view = await w.json<InstanceView>(await addSign(w, s.inHead.userId, submitted, [signer], 'parallel'));
    expect((await w.detail(view.id, signer)).actions).not.toContain('reject');
    expect(await reasonOf(await w.taskAction(signer, taskOf(view, signer).id, 'reject', view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_ACTION_DISABLED',
    });
    view = await act(w, view, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    const final = taskOf(view, s.outHead.userId, 'pending', 'final');
    expect(await reasonOf(await w.taskAction(s.outHead.userId, final.id, 'reject', view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_ACTION_DISABLED',
    });

    const defaults = await w.createProcess({ nodes: [JOINT, FINAL], priority: 9 });
    expect(defaults.latestVersion.nodes.map((node) => node.actions?.reject)).toEqual([true, true]);
  });
});

describe('P3 “只结算一次”守卫', () => {
  it('节点已流转后再次结算不会重复推进（直接调用结算，能区分有无守卫）', async () => {
    const w = await approvalWorld(database().db, 'apv-r2-settle-guard');
    const { s, view: submitted } = await started(w, [JOINT, FINAL]);
    const view = await act(w, submitted, s.inHead.userId, 'approve');
    expect(view.currentNodeKey).toBe('final');
    const counts = await withTenant(w.db, w.tenant.id, async (tx) => {
      const ctx = {
        tenantId: w.tenant.id,
        userId: s.inHead.userId,
        timezone: 'Asia/Shanghai',
        now: w.clock(),
        commandId: randomUUID(),
        expectedRevision: view.revision,
      };
      const run = await openRun(tx, ctx, view.id);
      const node = run.version.nodes.find((candidate) => candidate.key === 'joint') as CountersignApprovalNode;
      const approved = (await loadTasks(tx, w.tenant.id, view.id)).find(
        (task) => task.nodeKey === 'joint' && task.status === 'approved',
      )!;
      await settleCountersign(tx, run, node, approved);
      const [row] = rowsOf<{ flows: number; finals: number }>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM approval_instance_logs WHERE tenant_id=${w.tenant.id}
            AND instance_id=${view.id}::uuid AND event='countersign_flow') AS flows,
          (SELECT count(*)::int FROM approval_tasks WHERE tenant_id=${w.tenant.id}
            AND instance_id=${view.id}::uuid AND node_key='final') AS finals`),
      );
      return row;
    });
    expect(counts).toEqual({ flows: 1, finals: 1 });
  });
});
