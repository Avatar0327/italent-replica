/**
 * REQ-APV-003 节点动作：同意 / 驳回（驳回到发起人，同单修改后重提）/ 转交 / 撤销 / 催办 / 加签，
 * 节点开关「驳回意见必填」（DEC-059），管理员不得代签、只能转交或干预并入审计（DEC-063 / DEC-070），
 * 禁止盲审（DEC-058 / DEC-069）。
 */
import { randomUUID } from 'node:crypto';
import { auditEvents, type Db, eq, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  grantVisibleFields,
  permissionAdmin,
  TRANSFER_NODES,
  transferScene,
  type InstanceView,
} from './AC-APV-support.js';
import { createProfile } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

function current(view: InstanceView) {
  const tasks = view.tasks.filter((task) => task.status === 'pending');
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

async function errorOf(response: Response) {
  return {
    status: response.status,
    body: (await response.json()) as { error: { message: string; details?: unknown } },
  };
}

describe('AC-APV-16 驳回意见必填（节点开关，出厂关）', () => {
  it('开启的节点空意见驳回被拒；未开启的节点可直接驳回；驳回后同单修改重提（DEC-053）', async () => {
    const w = await approvalWorld(database().db, 'apv-reject');
    const s = await transferScene(w);
    const process = await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head', rejectCommentRequired: true },
        { key: 'in_head', approver: 'record_department_head', rejectResubmit: 'rejecting_node' },
      ],
    });
    expect(process.currentVersion!.nodes[1]).toMatchObject({ rejectCommentRequired: false });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to, place: '旧地点' });
    let view = await w.submit(draft);
    const blank = await errorOf(await w.taskAction(s.outHead.userId, current(view).id, 'reject', view.revision));
    expect(blank).toMatchObject({ status: 400, body: { error: { details: { reason: 'APPROVAL_COMMENT_REQUIRED' } } } });
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));
    view = await w.json(await w.taskAction(s.inHead.userId, current(view).id, 'reject', view.revision));
    expect(view).toMatchObject({ status: 'returned' });
    let business = await w.business(draft.id);
    expect(business).toMatchObject({ status: 'rejected' });

    const patched = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'PATCH', `/api/tenant/employment/businesses/${draft.id}`, {
        ifMatch: business.revision,
        body: { fields: { place: '修改后地点' } },
      }),
    );
    const resubmitted = await w.json<{ status: string }>(
      await w.submitRaw({ id: draft.id, revision: patched.revision }),
    );
    expect(resubmitted.status).toBe('in_review');
    view = await w.detail(view.id);
    // 驳回节点配置“提交到驳回节点”：重提后直接回到调入负责人，同一实例、同一版本。
    expect(view).toMatchObject({ status: 'running', currentNodeKey: 'in_head', versionNo: 1 });
    expect(current(view)).toMatchObject({ assigneeUserId: s.inHead.userId });
    view = await w.json(await w.taskAction(s.inHead.userId, current(view).id, 'approve', view.revision));
    expect(view.status).toBe('approved');
    business = await w.business(draft.id);
    expect(business).toMatchObject({ status: 'effective', fields: { place: '修改后地点' } });
  });
});

describe('转交、加签、催办、撤销（节点动作开关与消息规则）', () => {
  it('转交 / 加签受节点开关控制；催办通知当前审批人；消息规则按接收人生成通知', async () => {
    const w = await approvalWorld(database().db, 'apv-actions');
    const s = await transferScene(w);
    const helper = await w.member('加签人');
    const delegate = await w.member('转交对象');
    await w.publishedProcess({
      nodes: [
        { key: 'out_head', approver: 'latest_record_department_head', actions: { urge: 'inherit' } },
        {
          key: 'in_head',
          approver: 'record_department_head',
          actions: { transfer: true, addSign: true, urge: 'inherit' },
          messageRules: [
            {
              trigger: 'approve',
              channels: ['inbox', 'email'],
              template: 'TenantBase.Ygddtz',
              recipient: 'subject_employee',
            },
          ],
        },
      ],
    });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const denied = await errorOf(
      await w.taskAction(s.outHead.userId, current(view).id, 'transfer', view.revision, { toUserId: delegate }),
    );
    expect(denied.status).toBe(409);
    view = await w.json(await w.instanceAction(w.hr.id, view.id, 'urge', view.revision));
    const urged = await w.json<{ items: { kind: string; instanceId: string }[] }>(
      await w.request(s.outHead.userId, 'GET', '/api/tenant/approval/notifications'),
    );
    expect(urged.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'urge', instanceId: view.id })]),
    );
    const others = await w.json<{ items: unknown[] }>(
      await w.request(delegate, 'GET', '/api/tenant/approval/notifications'),
    );
    expect(others.items).toEqual([]);
    view = await w.json(await w.taskAction(s.outHead.userId, current(view).id, 'approve', view.revision));

    const selfTransfer = await errorOf(
      await w.taskAction(s.inHead.userId, current(view).id, 'transfer', view.revision, { toUserId: s.subject.userId }),
    );
    expect(selfTransfer.status).toBe(409);
    view = await w.json(
      await w.taskAction(s.inHead.userId, current(view).id, 'transfer', view.revision, { toUserId: delegate }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: delegate, origin: 'transfer' });
    expect((await w.todos(s.inHead.userId)).items).toEqual([]);
    // DEC-095 后加签：本人同意后再由被加签人审批。
    view = await w.json(
      await w.taskAction(delegate, current(view).id, 'add-sign', view.revision, { userIds: [helper], type: 'after' }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: helper, origin: 'add_sign_after' });
    expect(view.status).toBe('running');
    view = await w.json(await w.taskAction(helper, current(view).id, 'approve', view.revision));
    expect(view.status).toBe('approved');
    const subjectInbox = await w.json<{ items: { kind: string; channel: string; template: string }[] }>(
      await w.request(s.subject.userId, 'GET', '/api/tenant/approval/notifications'),
    );
    expect(subjectInbox.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', channel: 'inbox', template: 'TenantBase.Ygddtz' }),
        expect.objectContaining({ kind: 'message', channel: 'email', template: 'TenantBase.Ygddtz' }),
      ]),
    );
  });

  it('AC-TRF-28 发起人撤回：流程结束，任职申请回到草稿；非发起人不能撤回', async () => {
    const w = await approvalWorld(database().db, 'apv-withdraw');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const draft = await w.application(s.subject.employeeId, { departmentId: s.to });
    const view = await w.submit(draft);
    expect((await w.instanceAction(s.outHead.userId, view.id, 'withdraw', view.revision)).status).toBe(403);
    const withdrawn = await w.json<InstanceView>(await w.instanceAction(w.hr.id, view.id, 'withdraw', view.revision));
    expect(withdrawn.status).toBe('withdrawn');
    expect(withdrawn.tasks.every((task) => task.status !== 'pending')).toBe(true);
    expect(await w.business(draft.id)).toMatchObject({ status: 'draft', record: null });
    expect((await w.todos(s.outHead.userId)).items).toEqual([]);
  });

  it('revision 不一致返回 409；同一 Idempotency-Key 重放不重复执行', async () => {
    const w = await approvalWorld(database().db, 'apv-idempotent');
    const s = await transferScene(w);
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    const view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const task = current(view).id;
    expect((await w.taskAction(s.outHead.userId, task, 'approve', view.revision + 5)).status).toBe(409);
    const key = randomUUID();
    const path = `/api/tenant/approval/tasks/${task}/approve`;
    const first = await w.request(s.outHead.userId, 'POST', path, {
      ifMatch: view.revision,
      idempotencyKey: key,
      body: {},
    });
    const replay = await w.request(s.outHead.userId, 'POST', path, {
      ifMatch: view.revision,
      idempotencyKey: key,
      body: {},
    });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const after = await w.detail(view.id);
    expect(after.logs.filter((log) => log.event === 'approve')).toHaveLength(1);
    expect((await w.request(s.outHead.userId, 'POST', path, { ifMatch: view.revision, body: {} })).status).toBe(409);
  });
});

// 异常管理员恰为发起人 / 异动本人的情形已按 DEC-091 改为回避（转其直线经理或拒绝提交），
// 见 AC-APV-04-routing-rules（清单 15）。

describe('AC-APV-17 / AC-APV-20 管理员不得代签，只能转交或干预', () => {
  it('管理员直接同意被拒；转交与改审批人成功并入审计；转交给自己须填理由并醒目标注', async () => {
    const w = await approvalWorld(database().db, 'apv-admin');
    const s = await transferScene(w);
    const admin = await w.member('流程管理员');
    // F-067：转交目标须是已绑定员工且在操作人范围内，纯账号不能作为目标
    const other = (await w.person('新审批人', s.from)).userId;
    await w.publishedProcess({ nodes: TRANSFER_NODES });
    let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
    const task = current(view);
    const forged = await errorOf(await w.taskAction(admin, task.id, 'approve', view.revision));
    expect(forged.status).toBe(403);
    view = await w.json(
      await w.instanceAction(admin, view.id, 'admin-transfer', view.revision, {
        taskId: task.id,
        toUserId: other,
        reason: '原审批人休假',
      }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: other, origin: 'admin_transfer' });
    view = await w.json(
      await w.instanceAction(admin, view.id, 'admin-intervene', view.revision, {
        kind: 'reassign',
        taskId: current(view).id,
        toUserId: s.outHead.userId,
        reason: '改回原审批人',
      }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: s.outHead.userId, origin: 'admin_intervene' });
    const noReason = await errorOf(
      await w.instanceAction(admin, view.id, 'admin-transfer', view.revision, {
        taskId: current(view).id,
        toUserId: admin,
      }),
    );
    expect(noReason).toMatchObject({
      status: 400,
      body: { error: { details: { reason: 'APPROVAL_REASON_REQUIRED' } } },
    });
    view = await w.json(
      await w.instanceAction(admin, view.id, 'admin-transfer', view.revision, {
        taskId: current(view).id,
        toUserId: admin,
        reason: '紧急处理',
      }),
    );
    expect(current(view)).toMatchObject({ assigneeUserId: admin, adminSelfTransfer: true });
    view = await w.json(await w.taskAction(admin, current(view).id, 'approve', view.revision));
    expect(view.tasks.find((t) => t.nodeKey === 'out_head' && t.status === 'approved')).toMatchObject({
      assigneeUserId: admin,
      adminSelfTransfer: true,
    });
    expect(view.logs.filter((log) => log.adminSelfTransfer).map((log) => log.event)).toEqual(
      expect.arrayContaining(['admin_transfer', 'approve']),
    );
    const audits = await withTenant(w.db, w.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, view.id)),
    );
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['approval.admin.transfer', 'approval.admin.intervene', 'approval.admin.self_transfer']),
    );
    const transfer = audits.find((a) => a.action === 'approval.admin.transfer')!;
    expect(transfer).toMatchObject({
      actorUserId: admin,
      before: expect.objectContaining({ assigneeUserId: s.outHead.userId }),
      after: expect.objectContaining({ assigneeUserId: other, reason: '原审批人休假' }),
    });
    const flagged = await w.json<{ items: { instanceId: string; event: string }[] }>(
      await w.request(admin, 'GET', '/api/tenant/approval/admin-logs?adminSelfTransfer=true'),
    );
    expect(flagged.items).toEqual(expect.arrayContaining([expect.objectContaining({ instanceId: view.id })]));
  });
});

/** 盲审场景：调出负责人只能看到部门 / 生效日期 / 地点，申请改了职级；流程的异常管理员另设。 */
async function blindScene(db: Db, label: string) {
  const w = await approvalWorld(db, label);
  const s = await transferScene(w);
  const world = await permissionAdmin(w);
  // DEC-205：本夹具显式替代自动经理后备字段，确保被测审批人确实没有职级查看权。
  await createProfile(world, 'department_manager_self_service');
  await grantVisibleFields(world, s.outHead.userId, ['id', 'departmentId', 'effectiveDate', 'place']);
  const exceptionAdmin = await w.member('异常管理员');
  const levelType = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/job/level-types', {
      ifMatch: 0,
      body: { name: '职级体系', code: 'LT', startDate: '2020-01-01' },
    }),
    201,
  );
  const level = await w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', '/api/tenant/job/levels', {
      ifMatch: 0,
      body: { name: '高级', code: 'L9', level: 9, levelTypeId: levelType.id, startDate: '2020-01-01' },
    }),
    201,
  );
  await w.publishedProcess({ exceptionAdminUserId: exceptionAdmin, nodes: TRANSFER_NODES });
  const real = tenantApi(db, { authorize: undefined, clock: w.clock });
  const act = (task: string, action: 'approve' | 'reject', revision: number) =>
    real.request('POST', `/api/tenant/approval/tasks/${task}/${action}`, {
      ...w.as(s.outHead.userId),
      ifMatch: revision,
      body: { comment: '意见' },
    });
  const submitBlind = (employeeId: string) =>
    w.application(employeeId, { departmentId: s.to, levelId: level.id }).then((draft) => w.submit(draft));
  return { w, s, real, exceptionAdmin, act, submitBlind };
}

const blindLogs = (view: InstanceView) => view.logs.filter((log) => log.event === 'blind_review_exception_admin');

describe('AC-APV-14 禁止盲审（DEC-058 / DEC-069）', () => {
  it('变更字段无查看权：同意、驳回均被拒，任务自动转异常管理员；字段未变化时不受限', async () => {
    const db = database().db;
    const { w, s, real, exceptionAdmin, act, submitBlind } = await blindScene(db, 'apv-blind');
    let view = await submitBlind(s.subject.employeeId);
    const opened = await real.request('GET', `/api/tenant/approval/instances/${view.id}`, w.as(s.outHead.userId));
    expect(opened.status).toBe(200);
    const approve = await errorOf(await act(current(view).id, 'approve', view.revision));
    expect(approve).toMatchObject({
      status: 403,
      body: {
        error: { message: '本单含您无权查看且已变更的字段，无法审批', details: { reason: 'APPROVAL_BLIND_REVIEW' } },
      },
    });
    view = await w.detail(view.id);
    expect(current(view)).toMatchObject({
      assigneeUserId: exceptionAdmin,
      isExceptionAdmin: true,
      origin: 'blind_review',
    });
    expect(blindLogs(view)).toHaveLength(1);
    // 已转走的原任务不再待办：先校验任务状态（409），不再进入盲审出路。
    const closed = await errorOf(
      await act(view.tasks.find((t) => t.assigneeUserId === s.outHead.userId)!.id, 'reject', view.revision),
    );
    expect(closed).toMatchObject({ status: 409, body: { error: { details: { reason: 'APPROVAL_TASK_CLOSED' } } } });

    const colleague = await w.person('同部门员工', s.from);
    let second = await submitBlind(colleague.employeeId);
    const reject = await errorOf(await act(current(second).id, 'reject', second.revision));
    expect(reject).toMatchObject({ status: 403, body: { error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } } });
    second = await w.detail(second.id);
    expect(current(second)).toMatchObject({ assigneeUserId: exceptionAdmin, origin: 'blind_review' });

    const plain = await w.submit(await w.application(s.manager.employeeId, { departmentId: s.to }));
    const ok = await act(current(plain).id, 'approve', plain.revision);
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(blindLogs(await w.detail(plain.id))).toHaveLength(0);
  });

  it('先校验 revision 与任务状态：过期 revision 返回 409 且不自动转交；并发两次只转交一次', async () => {
    const { w, s, exceptionAdmin, act, submitBlind } = await blindScene(database().db, 'apv-blind-race');
    let view = await submitBlind(s.subject.employeeId);
    const task = current(view).id;
    const stale = await errorOf(await act(task, 'approve', view.revision - 1));
    expect(stale.status).toBe(409);
    view = await w.detail(view.id);
    expect(current(view)).toMatchObject({ id: task, assigneeUserId: s.outHead.userId });
    expect(blindLogs(view)).toHaveLength(0);
    expect((await w.todos(exceptionAdmin)).items).toEqual([]);

    const raced = await Promise.all([act(task, 'approve', view.revision), act(task, 'reject', view.revision)]);
    expect(raced.map((response) => response.status).sort()).toEqual([403, 409]);
    view = await w.detail(view.id);
    expect(blindLogs(view)).toHaveLength(1);
    expect(view.tasks.filter((t) => t.origin === 'blind_review')).toHaveLength(1);
    expect(current(view)).toMatchObject({ assigneeUserId: exceptionAdmin, origin: 'blind_review' });
  });
});
