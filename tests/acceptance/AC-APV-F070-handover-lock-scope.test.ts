/**
 * F-070（#151 / #159 审查存量 P3；真 PostgreSQL 锁交错，PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * F-140b / DEC-692：离职单一律预锁组织、编制与其他业务头，即使仅改派或没有调动申请也不豁免。
 * F-070 的“只在可能推进业务时才取”仍适用于退休单（mayAdvanceBusiness）；组织锁保留租户粒度。
 * - 离职仅改派：交接排队等实例锁时仍持组织锁，交接结果不变；
 * - 退休仅改派（不会合席）：不持组织锁，普通组织写入不被挡住；
 * - 离职会签合席：仍持组织锁、编制锁，守住 F-065 / F-017 的保护。
 * 全局取锁顺序不变：员工闭包 / 多员工业务头 → 组织 / 编制 → 账号 / 成员 → 剩余业务头 → 实例。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { cmd } from './support/tenant-api.js';
import { NODES, pendingOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const LEAVE_CONDITION = { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'DimissionProcessNew' }] };
const COUNTERSIGN = {
  key: 'joint',
  kind: 'countersign',
  name: '最终会签',
  approvers: ['record_department_head', 'record_department_hrbp'],
  transitionRule: { type: 'all' },
} as const;

/** 外部账号 U 持有离职 / 退休申请（非调动任职业务）的异常待办；countersign 时 U 占会签节点里无人可办的那一席。 */
async function leaveScene(
  label: string,
  countersign: boolean,
  withTransfer = false,
  kind: 'leave' | 'retirement' = 'leave',
) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  await installExitSeeds(w.db, w.tenant.id);
  const source = await createUser(
    w.db,
    { email: `${label}-${randomUUID()}@example.com`, displayName: '外部异常管理员' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  await w.setOrgRoles(s.from, { hrbp: null });
  const process = await w.publishedProcess({
    approvalType: kind,
    conditions:
      kind === 'leave'
        ? LEAVE_CONDITION
        : { items: [{ no: 1, field: 'processCode', operator: 'eq', value: 'RetireProcess' }] },
    nodes: [NODES.outHead, countersign ? COUNTERSIGN : { key: 'hrbp', approver: 'record_department_hrbp' }],
    exceptionAdminUserId: source.id,
  });
  // 同员工有一张未落地的调动申请：离职生效会回退它的带编分配，所以合席结算前要把编制锁也取齐（R2-T03 B3-3）
  if (withTransfer) await w.application(s.subject.employeeId, { departmentId: s.to });
  const created = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
      ifMatch: (
        await w.json<{ revision: number }>(
          await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
        )
      ).revision,
      body: {
        kind,
        mode: 'application',
        lastWorkDate: '2026-10-20',
        fields: {},
        ...(kind === 'leave' ? { exit: { exitTypeCode: 'voluntary' } } : {}),
      },
    }),
    201,
  );
  let view = await w.submit(created);
  view = await w.json(await w.taskAction(s.outHead.userId, pendingOf(view)[0]!.id, 'approve', view.revision));
  expect(pendingOf(view)).toEqual(expect.arrayContaining([expect.objectContaining({ assigneeUserId: source.id })]));
  // 仍是可用流程的异常管理员时拒绝交接以外的停用（DEC-098）；作废流程，在途实例按冻结版本继续
  await w.json(
    await w.request(w.hr.id, 'POST', `/api/tenant/approval/processes/${process.id}/discard`, {
      ifMatch: process.revision,
    }),
  );
  // DEC-092：离职申请由 HR 发起，HR 不能改派自己的单；另设一位租户管理员执行交接
  const admin = await w.member('交接管理员');
  await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: admin }, cmd());
  const successor = countersign ? s.outHead.userId : await w.member('替代人');
  return {
    w,
    view,
    source,
    s,
    created,
    handover: () =>
      w.request(admin, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: source.id, toUserId: successor },
      }),
    /** 同租户的普通组织写入要取的组织设置排他锁：NOWAIT，被挡住即抛 55P03。 */
    tryOrganizationLock: () =>
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT tenant_id FROM org_settings WHERE tenant_id=${w.tenant.id} FOR UPDATE NOWAIT`),
      ),
    /** 编制锁（establishment_settings）：NOWAIT，被挡住即抛 55P03。 */
    tryEstablishmentLock: () =>
      withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT tenant_id FROM establishment_settings WHERE tenant_id=${w.tenant.id} FOR UPDATE NOWAIT`),
      ),
    successor,
  };
}

/** NOWAIT 取不到锁：PostgreSQL 55P03（驱动或 ORM 可能把它包在 cause 里）。 */
function isLockNotAvailable(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } }).code ??
    (error as { cause?: { code?: string } }).cause?.code;
  return code === '55P03';
}

/** 交接停在实例锁上（已完成全部预锁）时，另一事务能否取到租户组织锁。 */
async function lockFreeWhileHandoverQueued(
  f: Awaited<ReturnType<typeof leaveScene>>,
  probe: 'tryOrganizationLock' | 'tryEstablishmentLock' = 'tryOrganizationLock',
) {
  let handedOver: Promise<Response> = Promise.resolve(new Response());
  let free: boolean | undefined;
  await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT id FROM approval_instances
      WHERE tenant_id=${f.w.tenant.id} AND id=${f.view.id}::uuid FOR UPDATE`);
    handedOver = f.handover();
    await waitForBlocked(f.w.db, 1);
    free = await f[probe]().then(
      () => true,
      (error: unknown) => {
        if (!isLockNotAvailable(error)) throw error;
        return false;
      },
    );
  });
  const response = await handedOver;
  expect(response.status, await response.clone().text()).toBe(200);
  return free;
}

describe.runIf(realPostgres)('AC-APV F-070 手动交接的组织锁范围（DEC-196 全局锁序不变）', () => {
  it('DEC-692 离职仅改派：F-140b 一律预锁，交接排队等实例锁时仍持组织锁；交接结果不变', async () => {
    const f = await leaveScene('f070-reassign-only', false);
    expect(await lockFreeWhileHandoverQueued(f)).toBe(false);
    expect(pendingOf(await f.w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
  });

  it('DEC-692 退休仅改派：仍按 mayAdvanceBusiness 不持组织锁，交接结果不变', async () => {
    const f = await leaveScene('f070-retirement-reassign-only', false, false, 'retirement');
    expect(await lockFreeWhileHandoverQueued(f)).toBe(true);
    expect(pendingOf(await f.w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
  });

  it('会签合席（替代人已占本节点一席，非调动任职业务）：仍持组织锁，守住合席结算 / 落地的保护', async () => {
    const f = await leaveScene('f070-countersign-merge', true);
    expect(await lockFreeWhileHandoverQueued(f)).toBe(false);
  });

  it('DEC-692 离职会签合席：有未落地调动申请时持编制锁；无调动申请时也一律预锁编制', async () => {
    const withTransfer = await leaveScene('f070-merge-with-transfer', true, true);
    expect(await lockFreeWhileHandoverQueued(withTransfer, 'tryEstablishmentLock')).toBe(false);
    const without = await leaveScene('f070-merge-no-transfer', true);
    expect(await lockFreeWhileHandoverQueued(without, 'tryEstablishmentLock')).toBe(false);
  });

  it('成员撤销接管合席结算并让离职生效：等组织锁期间尚未持有实例锁（锁序 组织 → 实例），放行后离职生效', async () => {
    const f = await leaveScene('f070-revoke-settle', true);
    const { w } = f;
    // 会签节点 all：先由异常管理员以外的席位同意，异常管理员 U 仍待办
    const outHeadTask = pendingOf(f.view).find((task) => task.assigneeUserId === f.s.outHead.userId)!;
    const view = await w.json<{ id: string }>(
      await w.taskAction(f.s.outHead.userId, outHeadTask.id, 'approve', f.view.revision),
    );
    // 发起人 HR 交接 U 的任务给已同意的席位：实例因本人发起被跳过，但替代人已登记，成员撤销时接管会合席结算
    const handover = await w.json<{ skipped: { instanceId: string }[] }>(
      await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: f.source.id, toUserId: f.s.outHead.userId },
      }),
    );
    expect(handover.skipped.map((item) => item.instanceId)).toContain(view.id);
    w.setNow('2026-10-21T02:00:00Z');
    const [membership] = await withTenant(w.db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT revision::int AS revision FROM tenant_memberships
        WHERE tenant_id=${w.tenant.id} AND user_id=${f.source.id}::uuid`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { revision: number }[];
    });
    let removed: Promise<Response> = Promise.resolve(new Response());
    let instanceFree: boolean | undefined;
    await withTenant(w.db, w.tenant.id, async (barrier) => {
      await barrier.execute(sql`SELECT tenant_id FROM org_settings WHERE tenant_id=${w.tenant.id} FOR UPDATE`);
      removed = w.request(w.hr.id, 'POST', `/api/tenant/permission/users/${f.source.id}/remove`, {
        ifMatch: membership!.revision,
      });
      await waitForBlocked(w.db, 1);
      instanceFree = await withTenant(w.db, w.tenant.id, (tx) =>
        tx.execute(sql`SELECT id FROM approval_instances WHERE tenant_id=${w.tenant.id}
          AND id=${view.id}::uuid FOR UPDATE NOWAIT`),
      ).then(
        () => true,
        (error: unknown) => {
          if (!isLockNotAvailable(error)) throw error;
          return false;
        },
      );
    });
    const response = await removed;
    expect(response.status, await response.clone().text()).toBe(200);
    expect(instanceFree, '等组织锁期间不应已持有实例锁').toBe(true);
    expect((await w.business(f.created.id)).status).toBe('effective');
  });
});
