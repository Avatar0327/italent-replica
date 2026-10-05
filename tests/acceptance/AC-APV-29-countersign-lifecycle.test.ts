/**
 * F-003 / AC-APV-29：会签节点上已有动作的行为自洽，多条在途任务在转交、审批人撤回（DEC-097）、异常管理员交接与
 * 停用接管（DEC-098 / DEC-123）、管理员跳转、发起人撤回后重提时都正确处理，不留无人可办的任务。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { revokeMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  TRANSFER_NODES,
  transferScene,
  type ApprovalWorld,
  type InstanceView,
  type NodeInput,
  type TaskView,
} from './AC-APV-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';

const JOINT: NodeInput = {
  key: 'joint',
  name: '调入部门会签',
  kind: 'countersign',
  approvers: ['record_department_head', 'record_department_hrbp'],
  transitionRule: { type: 'all' },
};
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

function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

async function started(w: ApprovalWorld, nodes: readonly NodeInput[]) {
  const s = await transferScene(w);
  await w.publishedProcess({ nodes });
  const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
  return { s, draft, view: await w.submit(draft) };
}

async function approve(w: ApprovalWorld, view: InstanceView, userId: string) {
  return w.json<InstanceView>(await w.taskAction(userId, taskOf(view, userId).id, 'approve', view.revision));
}

function retrieve(w: ApprovalWorld, userId: string, taskId: string, revision: number) {
  return w.request(userId, 'POST', `${BASE}/tasks/${taskId}/retrieve`, { ifMatch: revision });
}

/** 没有无人可办的在途任务：每条待办的接手人都是本租户有效成员。 */
async function assertNoOrphans(w: ApprovalWorld, instanceId: string) {
  const orphans = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT t.id FROM approval_tasks t
        LEFT JOIN tenant_memberships m ON m.tenant_id=t.tenant_id AND m.user_id=t.assignee_user_id AND m.status='active'
        WHERE t.tenant_id=${w.tenant.id} AND t.instance_id=${instanceId}::uuid AND t.status='pending'
          AND m.user_id IS NULL`),
    ),
  );
  expect(orphans).toEqual([]);
}

describe('AC-APV-29 会签节点的转交', () => {
  it('会签任务可转交给本节点以外的人（票随任务走）；转给本节点已在办的人被拒，管理员转交同样', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-transfer');
    const { s, view: submitted } = await started(w, [{ ...JOINT, actions: { transfer: true } }, FINAL]);
    const outsider = await w.member('外部审批人');
    const admin = await w.member('流程管理员');
    const headTask = taskOf(submitted, s.inHead.userId);
    expect(
      await reasonOf(
        await w.taskAction(s.inHead.userId, headTask.id, 'transfer', submitted.revision, { toUserId: s.inHrbp.userId }),
      ),
    ).toEqual({ status: 400, reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE' });
    let view = await w.json<InstanceView>(
      await w.taskAction(s.inHead.userId, headTask.id, 'transfer', submitted.revision, { toUserId: outsider }),
    );
    expect(taskOf(view, outsider)).toMatchObject({ origin: 'transfer', parentTaskId: headTask.id });
    expect(taskOf(view, s.inHead.userId, 'transferred')).toBeDefined();
    expect(
      await reasonOf(
        await w.instanceAction(admin, view.id, 'admin-transfer', view.revision, {
          taskId: taskOf(view, outsider).id,
          toUserId: s.inHrbp.userId,
          reason: '调整审批人',
        }),
      ),
    ).toEqual({ status: 400, reason: 'APPROVAL_ALREADY_NODE_ASSIGNEE' });
    view = await approve(w, view, outsider);
    expect(view.currentNodeKey).toBe('joint');
    view = await approve(w, view, s.inHrbp.userId);
    expect(view.currentNodeKey).toBe('final');
  });
});

describe('AC-APV-29 会签节点的审批人撤回（DEC-097）', () => {
  it('节点尚未流转：只撤回本人的同意，其他审批人的待办不受影响；不能重复撤回', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-retrieve-open');
    const { s, view: submitted } = await started(w, [{ ...JOINT, actions: { retrieve: true } }, FINAL]);
    const headTask = taskOf(submitted, s.inHead.userId);
    const hrbpTask = taskOf(submitted, s.inHrbp.userId);
    let view = await approve(w, submitted, s.inHead.userId);
    expect((await w.detail(view.id, s.inHead.userId)).actions).toContain('retrieve');
    view = await w.json(await retrieve(w, s.inHead.userId, headTask.id, view.revision));
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(taskOf(view, s.inHead.userId)).toMatchObject({ origin: 'retrieve', parentTaskId: headTask.id });
    expect(view.tasks.find((task) => task.id === hrbpTask.id)).toMatchObject({ status: 'pending' });
    expect(await reasonOf(await retrieve(w, s.inHead.userId, headTask.id, view.revision))).toEqual({
      status: 409,
      reason: 'APPROVAL_NOT_RETRIEVABLE',
    });
    // 撤回后的旧同意不再计票：HRBP 同意后节点仍等负责人重新同意。
    view = await approve(w, view, s.inHrbp.userId);
    expect(view.currentNodeKey).toBe('joint');
    view = await approve(w, view, s.inHead.userId);
    expect(view.currentNodeKey).toBe('final');
  });

  it('任一人同意即可、节点已流转：撤回后取消下一节点待办，重开本人并恢复因节点通过而结束的任务', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-retrieve-any');
    const nodes = [{ ...JOINT, transitionRule: { type: 'any' as const }, actions: { retrieve: true } }, FINAL];
    const { s, view: submitted } = await started(w, nodes);
    const headTask = taskOf(submitted, s.inHead.userId);
    let view = await approve(w, submitted, s.inHead.userId);
    expect(view.currentNodeKey).toBe('final');
    const finalTask = taskOf(view, s.outHead.userId, 'pending', 'final');
    const endedHrbp = taskOf(view, s.inHrbp.userId, 'ended');
    view = await w.json(await retrieve(w, s.inHead.userId, headTask.id, view.revision));
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(view.tasks.find((task) => task.id === finalTask.id)).toMatchObject({ status: 'cancelled' });
    expect(taskOf(view, s.inHead.userId)).toMatchObject({ origin: 'retrieve' });
    expect(taskOf(view, s.inHrbp.userId)).toMatchObject({ origin: 'countersign_reopen', parentTaskId: endedHrbp.id });
    view = await approve(w, view, s.inHrbp.userId);
    expect(view.currentNodeKey).toBe('final');
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.outHead.userId, nodeKey: 'final' })]);
    await assertNoOrphans(w, view.id);
  });

  it('恢复时原审批人已不可审批（成员关系已撤销）：恢复的任务转异常管理员，不留无人可办的任务', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-retrieve-gone');
    const nodes = [{ ...JOINT, transitionRule: { type: 'any' as const }, actions: { retrieve: true } }, FINAL];
    const { s, view: submitted } = await started(w, nodes);
    const headTask = taskOf(submitted, s.inHead.userId);
    let view = await approve(w, submitted, s.inHead.userId);
    const endedHrbp = taskOf(view, s.inHrbp.userId, 'ended');
    const revision = await withTenant(w.db, w.tenant.id, async (tx) =>
      Number(
        rowsOf<{ revision: number }>(
          await tx.execute(sql`SELECT revision FROM tenant_memberships
            WHERE tenant_id=${w.tenant.id} AND user_id=${s.inHrbp.userId}::uuid`),
        )[0]!.revision,
      ),
    );
    await revokeMembership(w.db, { tenantId: w.tenant.id, userId: s.inHrbp.userId, expectedRevision: revision }, cmd());
    view = await w.json(await retrieve(w, s.inHead.userId, headTask.id, view.revision));
    expect(taskOf(view, w.exceptionAdmin)).toMatchObject({
      origin: 'exception_admin',
      isExceptionAdmin: true,
      parentTaskId: endedHrbp.id,
    });
    expect(
      pendingOf(view)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.inHead.userId, w.exceptionAdmin].sort());
    await assertNoOrphans(w, view.id);
  });

  it('需所有人同意、节点已流转：撤回后只有撤回人重新审批，其他人的同意保留', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-retrieve-all');
    const { s, view: submitted } = await started(w, [{ ...JOINT, actions: { retrieve: true } }, FINAL]);
    let view = await approve(w, submitted, s.inHead.userId);
    view = await approve(w, view, s.inHrbp.userId);
    expect(view.currentNodeKey).toBe('final');
    const hrbpApproved = taskOf(view, s.inHrbp.userId, 'approved');
    view = await w.json(await retrieve(w, s.inHrbp.userId, hrbpApproved.id, view.revision));
    expect(view.currentNodeKey).toBe('joint');
    expect(pendingOf(view)).toEqual([expect.objectContaining({ assigneeUserId: s.inHrbp.userId, origin: 'retrieve' })]);
    expect(taskOf(view, s.inHead.userId, 'approved')).toBeDefined();
    view = await approve(w, view, s.inHrbp.userId);
    expect(view.currentNodeKey).toBe('final');
  });
});

describe('AC-APV-29 会签节点的异常待办：交接与停用接管（DEC-098 / DEC-123）', () => {
  async function exceptionScene(label: string) {
    const w = await approvalWorld(database().db, label);
    const s = await transferScene(w);
    await w.setOrgRoles(s.to, { hrbp: null });
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, JOINT] });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
    expect(taskOf(view, w.exceptionAdmin)).toMatchObject({ isExceptionAdmin: true, nodeKey: 'joint' });
    return { w, s, view };
  }

  it('交接：会签节点里的异常待办转给替代人并计入流转规则；其余会签任务不动', async () => {
    const { w, s, view: before } = await exceptionScene('apv-cs-handover');
    const successor = await w.member('接任的异常管理员');
    const configAdmin = await w.member('配置管理员');
    const handover = await w.json<{ tasks: number }>(
      await w.request(configAdmin, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    expect(handover.tasks).toBe(1);
    let view = await w.detail(before.id);
    expect(taskOf(view, successor)).toMatchObject({ origin: 'handover', isExceptionAdmin: true });
    expect(taskOf(view, s.inHead.userId)).toMatchObject({ origin: 'resolved' });
    view = await approve(w, view, successor);
    expect(view.currentNodeKey).toBe('joint');
    view = await approve(w, view, s.inHead.userId);
    expect(view.status).toBe('approved');
  });

  it('停用接管：异常管理员停用时，会签节点里的异常待办转给替代人，不留无人可办的任务', async () => {
    const { w, s, view: before } = await exceptionScene('apv-cs-takeover');
    await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
    const successor = await w.member('接任的异常管理员');
    // HR 本人发起：交接时按 DEC-092 跳过这张单，只记下替代人；停用时由接管转给替代人。
    const handover = await w.json<{ skipped: { instanceId: string }[] }>(
      await w.request(w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    expect(handover.skipped.map((item) => item.instanceId)).toEqual([before.id]);
    const revision = await withTenant(w.db, w.tenant.id, async (tx) =>
      Number(
        rowsOf<{ revision: number }>(
          await tx.execute(sql`SELECT revision FROM tenant_memberships
            WHERE tenant_id=${w.tenant.id} AND user_id=${w.exceptionAdmin}::uuid`),
        )[0]!.revision,
      ),
    );
    await revokeMembership(
      w.db,
      { tenantId: w.tenant.id, userId: w.exceptionAdmin, expectedRevision: revision },
      cmd(),
    );
    const view = await w.detail(before.id);
    expect(taskOf(view, successor)).toMatchObject({ isExceptionAdmin: true });
    expect(taskOf(view, s.inHead.userId)).toMatchObject({ origin: 'resolved' });
    expect(pendingOf(view)).toHaveLength(2);
    await assertNoOrphans(w, view.id);
  });
});

describe('AC-APV-29 管理员跳转、发起人撤回后重提：会签节点重新激活', () => {
  it('管理员跳转回会签节点：取消在途待办，全部审批人重新审批', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-jump');
    const { s, view: submitted } = await started(w, [JOINT, FINAL]);
    const admin = await w.member('流程管理员');
    let view = await approve(w, submitted, s.inHead.userId);
    view = await approve(w, view, s.inHrbp.userId);
    expect(view.currentNodeKey).toBe('final');
    view = await w.json(
      await w.instanceAction(admin, view.id, 'admin-intervene', view.revision, {
        kind: 'jump',
        toNodeKey: 'joint',
        reason: '会签需重新确认',
      }),
    );
    expect(view.currentNodeKey).toBe('joint');
    const reopened = pendingOf(view);
    expect(reopened.map((task) => task.assigneeUserId).sort()).toEqual([s.inHead.userId, s.inHrbp.userId].sort());
    expect(new Set(reopened.map((task) => task.activationId)).size).toBe(1);
    expect(reopened[0]!.activationId).not.toBe(taskOf(view, s.inHead.userId, 'approved').activationId);
    view = await approve(w, view, s.inHead.userId);
    expect(view.currentNodeKey).toBe('joint');
  });

  it('发起人撤回：会签任务全部取消；重提后会签节点从头激活', async () => {
    const w = await approvalWorld(database().db, 'apv-cs-withdraw');
    const { s, draft, view: submitted } = await started(w, [JOINT, FINAL]);
    let view = await approve(w, submitted, s.inHead.userId);
    view = await w.json(await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision));
    expect(view.status).toBe('withdrawn');
    expect(pendingOf(view)).toEqual([]);
    expect(taskOf(view, s.inHrbp.userId, 'cancelled')).toBeDefined();
    await w.json(await w.submitRaw(await w.business(draft.id)));
    view = await w.instanceOf(draft.id);
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'joint' });
    expect(
      pendingOf(view)
        .map((task) => task.assigneeUserId)
        .sort(),
    ).toEqual([s.inHead.userId, s.inHrbp.userId].sort());
  });
});
