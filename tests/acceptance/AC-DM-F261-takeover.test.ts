/** F-261 P2-R2-1：实际入队事务提交后消费，覆盖派生命令和无 HTTP 的系统接管。 */
import './support/exit-gate-enforced.js';
import { getUser, sql, withTenant, setUserStatus } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { approvalWorld, transferScene, type NodeInput, type InstanceView } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { cmd, tenantApi } from './support/tenant-api.js';
import { queueExitAccount } from '../../apps/api/src/modules/employment/exit-account-store.js';
import { settledOrBlocked } from './support/pg-interleave.js';

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

async function takeoverScene(label: string, inReview = true) {
  const x = await scene(label, inReview);
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
  const process = await x.w.json<{ revision: number }>(
    await x.w.request(x.w.hr.id, 'GET', `${BASE}/processes/${x.view.processId}`),
  );
  await x.w.json(
    await x.w.request(x.w.hr.id, 'POST', `${BASE}/processes/${x.view.processId}/discard`, {
      ifMatch: process.revision,
    }),
  );
  // 真实交接入口会登记替代人，但 HR 是本单发起人，按 DEC-092 跳过自己发起的实例。
  const receipt = await x.w.json<{ tasks: number; skipped: { instanceId: string }[] }>(
    await x.w.request(x.w.hr.id, 'POST', `${BASE}/exception-admins/handover`, {
      ifMatch: 0,
      body: { fromUserId: x.w.exceptionAdmin, toUserId: x.s.inHead.userId },
    }),
  );
  expect(receipt.tasks).toBe(0);
  expect(receipt.skipped.map((item) => item.instanceId)).toContain(x.view.id);
  expect(pending(x, await x.w.detail(x.view.id)).assigneeUserId).toBe(x.w.exceptionAdmin);
  return x;
}
async function takeover(x: Scene, kind: 'remove' | 'system', key = cmd().commandId) {
  if (kind === 'remove') {
    const member = await x.w.json<{ membershipRevision: number }>(
      await x.w.request(x.w.hr.id, 'GET', `/api/tenant/permission/users/${x.w.exceptionAdmin}`),
    );
    return async () =>
      x.w.json(
        await x.w.request(x.w.hr.id, 'POST', `/api/tenant/permission/users/${x.w.exceptionAdmin}/remove`, {
          ifMatch: member.membershipRevision,
          idempotencyKey: key,
        }),
      );
  }
  const source = (await getUser(x.w.db, x.w.exceptionAdmin))!;
  return () =>
    setUserStatus(
      x.w.db,
      {
        userId: source.id,
        status: 'disabled',
        expectedRevision: source.revision,
      },
      { actorUserId: x.w.hr.id, commandId: key },
    );
}
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
it.each([
  ['remove', true],
  ['remove', false],
  ['system', true],
  ['system', false],
] as const)('AC-DM-F261：%s 接管：审批中开关 %s，提交后立即消费并支持同键重放', async (kind, enabled) => {
  const x = await takeoverScene(`takeover-${kind}-${enabled}`, enabled);
  const invoke = await takeover(x, kind);
  x.past();
  await invoke();
  const next = await x.w.detail(x.view.id);
  expect(pending(x, next).assigneeUserId).toBe(x.s.inHead.userId);
  expect((await x.w.business(x.view.businessId)).status).toBe('in_review');
  await account(x, enabled); // 任何调度之前直接断言。
  const saved = await getUser(x.w.db, x.s.subject.userId);
  await invoke();
  expect(await getUser(x.w.db, x.s.subject.userId)).toEqual(saved);
  await runEmploymentActivations(x.w.db, cmd(), { tenantId: x.w.tenant.id }, { clock: x.w.clock });
  await account(x, enabled);
});
it('AC-DM-F261：复用原提交命令键的无权/异路径请求，不消费原任务', async () => {
  const x = await scene('review-command-conflict');
  const [task] = await withTenant(x.w.db, x.w.tenant.id, async (tx) =>
    rows<{ commandId: string }>(
      await tx.execute(sql`
    SELECT command_id AS "commandId" FROM exit_account_tasks
    WHERE tenant_id=${x.w.tenant.id} AND business_id=${x.view.businessId}::uuid`),
    ),
  );
  x.past();
  const response = await x.w.request(x.s.outHead.userId, 'POST', `${BASE}/tasks/${pending(x).id}/approve`, {
    ifMatch: x.view.revision,
    idempotencyKey: task!.commandId,
    body: {},
  });
  expect(response.status).toBe(409);
  await account(x, false);
});

it('AC-DM-F261：调动中间与末节点推进不生成离退休账号任务', async () => {
  const w = await approvalWorld(database().db, 'review-transfer-no-account');
  const s = await transferScene(w);
  await w.publishedProcess({ nodes: [first, second] });
  let v = await w.submit(
    await w.application(s.subject.employeeId, { departmentId: s.to }, { effectiveDate: '2026-10-15' }),
  );
  for (let i = 0; i < 2; i++) {
    const t = w.pending(v)[0]!;
    v = await w.json<InstanceView>(await w.taskAction(t.assigneeUserId, t.id, 'approve', v.revision));
    const counts = await withTenant(w.db, w.tenant.id, async (tx) =>
      rows<{ n: number }>(
        await tx.execute(sql`
      SELECT count(*)::int AS n FROM exit_account_tasks WHERE tenant_id=${w.tenant.id}`),
      ),
    );
    expect(counts[0]!.n).toBe(0);
    expect((await getUser(w.db, s.subject.userId))!.status).toBe('active');
  }
});

it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-DM-F261：系统接管与调度锁交错：提交后再消费，不递归争用旧事务锁',
  async () => {
    const x = await takeoverScene('takeover-lock');
    const invoke = await takeover(x, 'system');
    x.past();
    let release!: () => void, held!: () => void;
    const ready = new Promise<void>((r) => {
      held = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holder = withTenant(x.w.db, x.w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM exit_account_tasks
      WHERE tenant_id=${x.w.tenant.id} AND business_id=${x.view.businessId}::uuid FOR UPDATE`);
      held();
      await gate;
    });
    await ready;
    const taking = invoke();
    let scheduling: Promise<unknown> | undefined;
    try {
      expect(await settledOrBlocked(x.w.db, taking, 1)).toBe('blocked');
      scheduling = runEmploymentActivations(x.w.db, cmd(), { tenantId: x.w.tenant.id }, { clock: x.w.clock });
      expect(await settledOrBlocked(x.w.db, scheduling, 2)).toBe('blocked');
    } finally {
      release();
    }
    await holder;
    await taking;
    await scheduling;
    await account(x, true);
    const saved = await getUser(x.w.db, x.s.subject.userId);
    await invoke();
    expect(await getUser(x.w.db, x.s.subject.userId)).toEqual(saved);
  },
);

it.each(['commit', 'rollback', 'savepoint-rollback', 'parent-rollback'] as const)(
  'AC-DM-F261：结构守护：queueExitAccount 的 %s 只由根事务实际提交决定是否消费',
  async (mode) => {
    const x = await scene(`transaction-${mode}`);
    x.past();
    const ctx = {
      tenantId: x.w.tenant.id,
      timezone: 'Asia/Shanghai',
      now: x.w.clock(),
      userId: x.w.hr.id,
      commandId: cmd().commandId,
      expectedRevision: 0,
    };
    const abort = new Error('合成事务回滚');
    const write = withTenant(x.w.db, x.w.tenant.id, async (tx) => {
      if (mode === 'rollback') {
        await queueExitAccount(tx, ctx, x.view.businessId);
        throw abort;
      }
      const child = tx.transaction(async (savepoint) => {
        await queueExitAccount(savepoint, ctx, x.view.businessId);
        if (mode === 'savepoint-rollback') throw abort;
      });
      if (mode === 'savepoint-rollback') await expect(child).rejects.toBe(abort);
      else await child;
      if (mode === 'parent-rollback') throw abort;
    });
    if (mode === 'rollback' || mode === 'parent-rollback') await expect(write).rejects.toBe(abort);
    else await write;
    await account(x, mode === 'commit');
    if (mode === 'commit') {
      const [task] = await withTenant(x.w.db, x.w.tenant.id, (tx) =>
        tx
          .execute(
            sql`
        SELECT status FROM exit_account_tasks WHERE tenant_id=${x.w.tenant.id}
        AND business_id=${x.view.businessId}::uuid`,
          )
          .then((r) => rows<{ status: string }>(r)),
      );
      expect(task!.status).toBe('disabled');
    }
  },
);
