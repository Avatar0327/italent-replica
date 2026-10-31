/** F-261 P2-1：审批只推进实例时，也须在请求返回前按 DM-R9 消费到期账号任务。 */
import './support/exit-gate-enforced.js';
import { getUser } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene, type NodeInput, type InstanceView } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const BASE = '/api/tenant/approval';
const first: NodeInput = {
  key: 'first',
  approver: { type: 'department', value: 'latest_record_department_head' },
  exits: ['approve', 'disagree'],
  actions: { transfer: true, addSign: true, copySend: true, retrieve: true, jump: true },
};
const second: NodeInput = {
  key: 'second',
  approver: { type: 'object_field', value: 'direct_manager' },
  actions: { rejectToPrevious: true },
};
async function scene(
  label: string,
  inReview = true,
  nodes: readonly NodeInput[] = [first, second],
  kind: 'leave' | 'retirement' = 'leave',
) {
  const w = await approvalWorld(database().db, `f261-apv-${label}`);
  const s = await transferScene(w);
  await installExitSeeds(w.db, w.tenant.id);
  await w.publishedProcess({
    approvalType: kind,
    conditions: {
      items: [
        {
          no: 1,
          field: 'processCode',
          operator: 'eq',
          value: kind === 'leave' ? 'DimissionProcessNew' : 'RetireProcess',
        },
      ],
    },
    nodes,
  });
  await w.json(
    await w.request(w.hr.id, 'PUT', '/api/tenant/employment/exit-account/settings', {
      ifMatch: 0,
      body: { earlyEnabled: true, basis: 'actual_leave_date', time: '19:00', inReview },
    }),
  );
  async function submit(employeeId = s.subject.employeeId) {
    const employee = await w.json<{ revision: number }>(
      await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${employeeId}`),
    );
    const draft = await w.json<{ id: string; revision: number }>(
      await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${employeeId}/businesses`, {
        ifMatch: employee.revision,
        body: {
          kind,
          mode: 'application',
          lastWorkDate: kind === 'retirement' ? '2026-10-01' : '2026-10-15',
          fields: {},
          ...(kind === 'leave' ? { exit: { exitTypeCode: 'voluntary', actualLeaveDate: '2026-10-01' } } : {}),
        },
      }),
      201,
    );
    return w.submit(draft);
  }
  const view = await submit();
  expect((await getUser(w.db, s.subject.userId))!.status).toBe('active');
  return { w, s, view, submit, past: () => w.setNow('2026-10-01T11:01:00Z') };
}
type Scene = Awaited<ReturnType<typeof scene>>;
const pending = (x: Scene, view = x.view) => x.w.pending(view)[0]!;
async function account(x: Scene, disabled: boolean, userId = x.s.subject.userId) {
  expect((await getUser(x.w.db, userId))!.status).toBe(disabled ? 'disabled' : 'active');
  expect((await x.w.request(userId, 'GET', '/api/tenant/employment/exit-account/tasks')).status).toBe(
    disabled ? 401 : 200,
  );
}
async function action(x: Scene, name: string, body = {}, view = x.view, actor = pending(x, view).assigneeUserId) {
  return x.w.json<InstanceView>(
    await x.w.request(actor, 'POST', `${BASE}/tasks/${pending(x, view).id}/${name}`, {
      ifMatch: view.revision,
      body,
    }),
  );
}

function taskInput(kind: string, other: string) {
  if (kind.startsWith('add-')) return { type: kind.slice(4), userIds: [other] };
  if (kind === 'transfer') return { toUserId: other };
  if (kind === 'cc') return { userIds: [other] };
  return { toNodeKey: 'second' };
}

describe('AC-DM-04 审批推进即时停用', () => {
  it.each([false, true])('两节点普通同意，审批中开关=%s；先断言 HTTP 结果，再调度', async (inReview) => {
    const x = await scene(`intermediate-${inReview}`, inReview);
    x.past();
    const next = await action(x, 'approve');
    expect(next).toMatchObject({ status: 'running', currentNodeKey: 'second' });
    expect((await x.w.business(x.view.businessId)).status).toBe('in_review');
    // 必须早于任何调度调用：定时补偿成功不能掩盖请求内遗漏。
    await account(x, inReview);
    const before = await getUser(x.w.db, x.s.subject.userId);
    await runEmploymentActivations(x.w.db, cmd(), { tenantId: x.w.tenant.id }, { clock: x.w.clock });
    await account(x, inReview);
    expect(await getUser(x.w.db, x.s.subject.userId)).toEqual(before);
  });

  it('退休中间节点同意也立即消费同一任务出口', async () => {
    const x = await scene('retirement', true, [first, second], 'retirement');
    x.past();
    expect((await action(x, 'approve')).currentNodeKey).toBe('second');
    await account(x, true);
  });

  it('盲审自动转交虽然返回 403，但已提交推进也必须即时停用', async () => {
    const x = await scene('blind');
    const restricted = tenantApi(x.w.db, {
      clock: x.w.clock,
      authorize: (request) => !(request.userId === x.s.outHead.userId && request.action === 'data.scope.all'),
    });
    x.past();
    const response = await restricted.request('POST', `${BASE}/tasks/${pending(x).id}/approve`, {
      ...x.w.as(x.s.outHead.userId),
      ifMatch: x.view.revision,
      body: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_BLIND_REVIEW' } } });
    const next = await x.w.detail(x.view.id);
    expect(pending(x, next)).toMatchObject({ origin: 'blind_review', assigneeUserId: x.w.exceptionAdmin });
    await account(x, true);
  });

  it('异常管理员批量交接：在途离职单仍审批中，原任务关联交接命令并即时消费', async () => {
    const x = await scene('exception-handover');
    const restricted = tenantApi(x.w.db, {
      clock: x.w.clock,
      authorize: (request) => !(request.userId === x.s.outHead.userId && request.action === 'data.scope.all'),
    });
    expect(
      (
        await restricted.request('POST', `${BASE}/tasks/${pending(x).id}/approve`, {
          ...x.w.as(x.s.outHead.userId),
          ifMatch: x.view.revision,
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(pending(x, await x.w.detail(x.view.id)).assigneeUserId).toBe(x.w.exceptionAdmin);
    await account(x, false);
    x.past();
    const receipt = await x.w.json<{ tasks: number }>(
      await x.w.request(x.s.manager.userId, 'POST', `${BASE}/exception-admins/handover`, {
        ifMatch: 0,
        body: { fromUserId: x.w.exceptionAdmin, toUserId: x.s.inHead.userId },
      }),
    );
    expect(receipt.tasks).toBe(1);
    expect(pending(x, await x.w.detail(x.view.id)).assigneeUserId).toBe(x.s.inHead.userId);
    expect((await x.w.business(x.view.businessId)).status).toBe('in_review');
    await account(x, true);
  });

  it.each(['all', 'custom', 'any'] as const)('会签规则 %s：未达条件或流转到下一节点均即时停用', async (type) => {
    const x = await scene(`joint-${type}`, true, [
      {
        ...first,
        kind: 'countersign',
        approvers: [
          { type: 'department', value: 'latest_record_department_head' },
          { type: 'object_field', value: 'direct_manager' },
        ],
        approver: undefined,
        transitionRule:
          type === 'custom'
            ? { type, rules: { approve: { kind: 'count', value: 2 }, disagree: { kind: 'count', value: 2 } } }
            : { type },
      },
      { key: 'second', approver: { type: 'custom_variable', value: 'owner' } },
    ]);
    x.past();
    const next = await action(x, 'approve');
    expect(next).toMatchObject({ status: 'running', currentNodeKey: type === 'any' ? 'second' : 'first' });
    expect(x.w.pending(next).length).toBeGreaterThan(0);
    await account(x, true);
  });

  it.each(['transfer', 'add-before', 'add-after', 'add-parallel', 'cc', 'jump'])(
    '审批中心动作 %s 关联本次命令并即时消费',
    async (kind) => {
      const x = await scene(
        kind,
        true,
        kind === 'add-parallel'
          ? [
              {
                ...first,
                kind: 'countersign',
                approver: undefined,
                approvers: [
                  { type: 'department', value: 'latest_record_department_head' },
                  { type: 'object_field', value: 'direct_manager' },
                ],
                transitionRule: { type: 'all' },
              },
              second,
            ]
          : undefined,
      );
      const other = await x.w.member('合成接手人');
      x.past();
      const name = kind.startsWith('add-') ? 'add-sign' : kind;
      const body = taskInput(kind, other);
      const next = await action(x, name, body);
      expect(next.status).toBe('running');
      expect((await x.w.business(x.view.businessId)).status).toBe('in_review');
      await account(x, true);
    },
  );

  it.each(['retrieve', 'reject-previous'])('%s 回到前一节点仍在审批中，过点即时停用', async (kind) => {
    const x = await scene(kind);
    const originalTask = pending(x).id;
    const next = await action(x, 'approve');
    await account(x, false);
    x.past();
    const result =
      kind === 'retrieve'
        ? await x.w.json<InstanceView>(
            await x.w.request(x.s.outHead.userId, 'POST', `${BASE}/tasks/${originalTask}/retrieve`, {
              ifMatch: next.revision,
              body: {},
            }),
          )
        : await action(x, kind, { comment: '合成退回原因' }, next);
    expect(result).toMatchObject({ status: 'running', currentNodeKey: 'first' });
    await account(x, true);
  });

  it.each(['before', 'after'])('加签 %s 在点前发起，点后加签人同意即时停用', async (type) => {
    const x = await scene(`signer-${type}`);
    const other = await x.w.member('合成加签人');
    const next = await action(x, 'add-sign', { type, userIds: [other] });
    await account(x, false);
    x.past();
    expect((await action(x, 'approve', {}, next, other)).status).toBe('running');
    await account(x, true);
  });

  it.each(['admin-transfer', 'reassign', 'admin-jump'])('管理员 %s 也走统一持久出口', async (kind) => {
    const x = await scene(kind);
    const other = x.s.inHead.userId;
    x.past();
    const delegation = {
      taskId: pending(x).id,
      toUserId: other,
      reason: '合成改派原因',
      ...(kind === 'reassign' ? { kind } : {}),
    };
    const body = kind === 'admin-jump' ? { kind: 'jump', toNodeKey: 'second', reason: '合成干预原因' } : delegation;
    const next = await x.w.json<InstanceView>(
      await x.w.instanceAction(
        x.w.exceptionAdmin,
        x.view.id,
        kind === 'admin-transfer' ? kind : 'admin-intervene',
        x.view.revision,
        body,
      ),
    );
    expect(next.status).toBe('running');
    await account(x, true);
  });

  it.each(['reject', 'disagree', 'withdraw'])('%s 离开审批中状态，不应按审批中规则停用', async (kind) => {
    const x = await scene(kind);
    x.past();
    const next =
      kind === 'withdraw'
        ? await x.w.json<InstanceView>(await x.w.instanceAction(x.w.hr.id, x.view.id, kind, x.view.revision, {}))
        : await action(x, kind, { comment: '合成拒绝原因' });
    expect(next.status).not.toBe('running');
    await account(x, false);
  });

  it('本人可审批配置：办理人的账号停用不改写已提交的成功回执', async () => {
    const x = await scene('self-takeover', true, [
      { ...first, actions: { ...first.actions, avoidSelf: false } },
      second,
    ]);
    const own = await x.submit(x.s.outHead.employeeId);
    expect(pending(x, own).assigneeUserId).toBe(x.s.outHead.userId);
    x.past();
    await action(x, 'cc', { userIds: [x.s.inHead.userId] }, own);
    await account(x, true, x.s.outHead.userId);
    const next = await x.w.detail(own.id);
    // 全局停用沿用 DEC-123 既有异常待办接管范围；普通待办不在本次返工扩展。
    expect(pending(x, next)).toMatchObject({ origin: 'resolved', assigneeUserId: x.s.outHead.userId });
  });

  it('现有合同批量同意拒绝离职任务，不误推进或消费；离退休没有独立批量入口', async () => {
    const x = await scene('batch-boundary');
    x.past();
    const receipt = await x.w.json<{ items: { status: number }[] }>(
      await x.w.request(x.s.outHead.userId, 'POST', '/api/tenant/contracts/todos/batch', {
        ifMatch: 0,
        body: { action: 'approve', items: [{ id: pending(x).id, revision: x.view.revision }] },
      }),
    );
    expect(receipt.items).toMatchObject([{ status: 404 }]);
    expect((await x.w.detail(x.view.id)).revision).toBe(x.view.revision);
    await account(x, false);
  });

  it('多单逐条同意：各命令只消费本单；同命令重放不重复停用', async () => {
    const x = await scene('multiple');
    const other = await x.w.person('合成第二员工', x.s.from, { directManagerId: x.s.manager.employeeId });
    const secondView = await x.submit(other.employeeId);
    x.past();
    const idempotencyKey = cmd().commandId;
    const path = `${BASE}/tasks/${pending(x).id}/approve`;
    const options = { ifMatch: x.view.revision, body: {}, idempotencyKey };
    await x.w.json(await x.w.request(x.s.outHead.userId, 'POST', path, options));
    await account(x, true);
    await account(x, false, other.userId);
    const before = await getUser(x.w.db, x.s.subject.userId);
    await x.w.json(await x.w.request(x.s.outHead.userId, 'POST', path, options));
    expect(await getUser(x.w.db, x.s.subject.userId)).toEqual(before);
    await action(x, 'approve', {}, secondView);
    await account(x, true, other.userId);
  });

  it('拒绝的旧 revision 与无权审批不关联任务；催办不推进实例也不触发', async () => {
    const x = await scene('denied');
    x.past();
    const path = `${BASE}/tasks/${pending(x).id}/approve`;
    expect(
      (await x.w.request(x.s.outHead.userId, 'POST', path, { ifMatch: x.view.revision - 1, body: {} })).status,
    ).toBe(409);
    expect((await x.w.request(x.w.hr.id, 'POST', path, { ifMatch: x.view.revision, body: {} })).status).toBe(403);
    await x.w.json(await x.w.instanceAction(x.w.hr.id, x.view.id, 'urge', x.view.revision));
    await account(x, false);
  });
});
