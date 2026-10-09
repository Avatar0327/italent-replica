import { randomUUID } from 'node:crypto';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { PRESET_PROCESSES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { cmd, tenantApi, allowAll } from './support/tenant-api.js';
import { createProcess, publishProcess } from '../../apps/api/src/modules/approval/definitions.js';
import { rowsOf } from '../../apps/api/src/modules/contracts/context.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { dropFrozen, insertFrozen } from './support/f048.js';

const testDb = useTestDb();
/** @param options.omitAvoidSelf 节点不带自审回避开关（模拟手工新建、不传开关的流程，缺省关闭，DEC-329④） */
async function world(label: string, options: { omitAvoidSelf?: boolean } = {}) {
  const w = await contractWorld(testDb().db, label);
  const approver = await createUser(
    w.db,
    { email: `review-${randomUUID()}@example.com`, displayName: '合成审批人' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: approver.id, expectedRevision: 0 }, cmd());
  await withTenant(w.db, w.session.tenant.id, async (tx) => {
    for (const preset of PRESET_PROCESSES.filter((p) => p.approvalType.startsWith('contract_'))) {
      const ctx = {
        tenantId: w.session.tenant.id,
        userId: w.session.user.id,
        timezone: 'Asia/Shanghai',
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: 0,
      };
      const { avoidSelf: _avoidSelf, ...withoutAvoidSelf } = preset.definition.nodes[0]!.actions;
      const created = await createProcess(
        tx,
        ctx,
        { code: preset.code, approvalType: preset.approvalType },
        {
          ...preset.definition,
          exceptionAdminUserId: approver.id,
          nodes: [
            {
              ...preset.definition.nodes[0]!,
              ...(options.omitAvoidSelf ? { actions: withoutAvoidSelf } : {}),
              kind: 'single',
              approver: 'owner',
              exits: ['approve', 'disagree'],
            },
          ],
        },
      );
      await publishProcess(tx, { ...ctx, expectedRevision: created.revision }, created.id);
    }
  });
  async function pending() {
    return withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ id: string; instanceId: string; revision: number }>(
        await tx.execute(sql`SELECT t.id,t.instance_id AS "instanceId",i.revision FROM approval_tasks t
        JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
        WHERE t.status='pending' ORDER BY t.id`),
      ),
    );
  }
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const act = (action: string, items: { id: string; revision: number }[], user = approver.id) =>
    api.request('POST', '/api/tenant/contracts/todos/batch', {
      tenant: w.session.tenant.id,
      user,
      ifMatch: 0,
      body: { action, items: items.map(({ id, revision }) => ({ id, revision })) },
    });
  return { ...w, pending, act, api };
}

describe('R2-T06 四种申请和合并待办', () => {
  it('两条续签申请为独立实例；非审批人拒绝；驳回、发起人重提、不同意复用逐单审批动作', async () => {
    const w = await world('cttodos');
    const sources = [await w.create(), await w.create({ typeId: w.otherType.id })];
    const result = await w.request('POST', '/batch', {
      ifMatch: 0,
      body: {
        items: sources.map((c) => ({
          revision: c.revision,
          command: {
            operation: 'renew',
            mode: 'application',
            employeeId: w.employee.id,
            targetId: c.id,
            fields: { effectiveDate: '2026-10-01', endDate: '2027-09-30' },
          },
        })),
      },
    });
    expect(result.status, await result.clone().text()).toBe(200);
    const tasks = await w.pending();
    expect(new Set(tasks.map((t) => t.instanceId)).size).toBe(2);
    expect(await (await w.act('approve', tasks, w.session.user.id)).json()).toMatchObject({
      items: [{ status: 403 }, { status: 403 }],
    });
    expect(await (await w.act('reject', tasks)).json()).toMatchObject({ items: [{ status: 200 }, { status: 200 }] });
    const instances = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ id: string; revision: number }>(
        await tx.execute(sql`SELECT id,revision FROM approval_instances WHERE business_type='contract'`),
      ),
    );
    expect(await (await w.act('resubmit', instances, w.session.user.id)).json()).toMatchObject({
      items: [{ status: 200 }, { status: 200 }],
    });
    expect(await (await w.act('decline', await w.pending())).json()).toMatchObject({
      items: [{ status: 200 }, { status: 200 }],
    });
    expect(await w.list('in_review')).toHaveLength(0);
    expect(await w.list()).toHaveLength(2);
  });

  it.each(['change', 'terminate'] as const)('%s 申请在审批前不改变原合同，通过后才生效', async (operation) => {
    const w = await world(`ctapply${operation}`);
    const original = await w.create();
    const result = await w.request('POST', '/commands', {
      ifMatch: original.revision,
      body: {
        operation,
        mode: 'application',
        employeeId: w.employee.id,
        targetId: original.id,
        fields: operation === 'change' ? { effectiveDate: '2025-03-01' } : { actualTerminationDate: '2026-09-30' },
      },
    });
    expect(result.status, await result.clone().text()).toBe(201);
    expect((await w.list()).find((c) => c.id === original.id)?.status).toBe('valid');
    expect(await (await w.act('approve', await w.pending())).json()).toMatchObject({ items: [{ status: 200 }] });
    expect((await w.list()).find((c) => c.id === original.id)?.status).toBe('terminated');
  });

  it('原合同自动到期终止与审批通过的未来续签可以交错，续签仍按期生效', async () => {
    const w = await world('ctexpiryrenew');
    const source = await w.create({ endDate: '2026-10-01' });
    const result = await w.request('POST', '/commands', {
      ifMatch: 1,
      body: {
        operation: 'renew',
        mode: 'application',
        employeeId: w.employee.id,
        targetId: source.id,
        fields: { effectiveDate: '2026-10-02', endDate: '2027-10-01' },
      },
    });
    expect(result.status).toBe(201);
    expect(await (await w.act('approve', await w.pending())).json()).toMatchObject({ items: [{ status: 200 }] });
    await w.settings({ autoTerminate: true });
    const sweep = () =>
      runContractJobs(
        w.db,
        { tenantId: w.session.tenant.id },
        {
          clock: () => new Date('2026-10-02T01:00:00Z'),
          authorize: allowAll,
        },
      );
    await sweep();
    await sweep();
    expect(await w.list()).toHaveLength(2);
  });
});

describe('F-048 T9d 合并待办逐条回避（DEC-329）', () => {
  it('3 条待办其中 1 条办理人命中冻结值：该条 409，其余成功；同键重放逐条回执相同', async () => {
    const w = await world('ctf048batch');
    const thirdType = await w.request('POST', '/master-data/types', {
      ifMatch: 0,
      body: { code: randomUUID(), name: '实习协议' },
    });
    const third = (await thirdType.json()) as { id: string };
    const created = [
      await w.create(),
      await w.create({ typeId: w.otherType.id }),
      await w.create({ typeId: third.id }),
    ];
    const result = await w.request('POST', '/batch', {
      ifMatch: 0,
      body: {
        items: created.map((c) => ({
          revision: c.revision,
          command: {
            operation: 'renew',
            mode: 'application',
            employeeId: w.employee.id,
            targetId: c.id,
            fields: { effectiveDate: '2026-10-01', endDate: '2027-09-30' },
          },
        })),
      },
    });
    expect(result.status, await result.clone().text()).toBe(200);
    const tasks = await w.pending();
    expect(tasks).toHaveLength(3);
    const [owner] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ assignee_user_id: string }>(
        await tx.execute(sql`SELECT assignee_user_id::text FROM approval_tasks WHERE id=${tasks[0]!.id}::uuid`),
      ),
    );
    const approver = owner!.assignee_user_id;
    await insertFrozen(w.db, w.session.tenant.id, tasks[1]!.instanceId, approver);
    const send = () =>
      w.api.request('POST', '/api/tenant/contracts/todos/batch', {
        tenant: w.session.tenant.id,
        user: approver,
        ifMatch: 0,
        idempotencyKey: 'f048-batch',
        body: { action: 'approve', items: tasks.map(({ id, revision }) => ({ id, revision })) },
      });
    const first = (await (await send()).json()) as { items: { status: number }[] };
    expect(first.items.map((item) => item.status)).toEqual([200, 409, 200]);
    expect(await w.pending()).toEqual([expect.objectContaining({ id: tasks[1]!.id })]);
    const replay = (await (await send()).json()) as { items: { status: number }[] };
    expect(replay).toEqual(first);
  });
});

describe('F-048 T11 合同审批：缺省关闭与存量在途实例（DEC-329④）', () => {
  async function terminateApplication(w: Awaited<ReturnType<typeof world>>) {
    const original = await w.create();
    const result = await w.request('POST', '/commands', {
      ifMatch: original.revision,
      body: {
        operation: 'terminate',
        mode: 'application',
        employeeId: w.employee.id,
        targetId: original.id,
        fields: { actualTerminationDate: '2026-09-30' },
      },
    });
    expect(result.status, await result.clone().text()).toBe(201);
    return original;
  }

  const assigneesOf = (w: Awaited<ReturnType<typeof world>>) =>
    withTenant(w.db, w.session.tenant.id, async (tx) =>
      rowsOf<{ assignee_user_id: string; origin: string }>(
        await tx.execute(sql`SELECT assignee_user_id::text,origin FROM approval_tasks WHERE status='pending'`),
      ),
    );

  it('手工新建且不传开关：发起人是审批人时收到自己的待办（不再自审回避）', async () => {
    const w = await world('ctf048default', { omitAvoidSelf: true });
    await terminateApplication(w);
    expect(await assigneesOf(w)).toEqual([{ assignee_user_id: w.session.user.id, origin: 'resolved' }]);
  });

  it('存量在途实例（avoid_self=true、无冻结行）：发起人自审跳过转异常管理员，升级后继续办理并通过', async () => {
    const w = await world('ctf048legacy');
    const original = await terminateApplication(w);
    const [pending] = await w.pending();
    await dropFrozen(w.db, w.session.tenant.id, pending!.instanceId);
    expect(await assigneesOf(w)).toEqual([expect.objectContaining({ origin: 'exception_admin' })]);
    expect(await (await w.act('approve', [pending!])).json()).toMatchObject({ items: [{ status: 200 }] });
    expect((await w.list()).find((c) => c.id === original.id)?.status).toBe('terminated');
  });
});
