/**
 * F-070（#151 / #159 审查存量 P3；真 PostgreSQL 锁交错，PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 手动异常交接只在“批里可能推进任职业务”时才取租户组织锁（org/locks.ts：组织锁保留租户粒度，所以不能收窄到单个组织，
 * 只能收窄到“要不要取”）。取组织锁的理由（F-065）：调动要取编制锁；会签合席结算可能推进业务、落地时校验部门要取组织锁。
 * - 仅改派（单人节点的离职申请，不会合席）：交接排队等实例锁时不持组织锁，同租户的普通组织写入不被它挡住；
 * - 会签合席（替代人已在本节点占着一席，非调动任职业务）：仍持组织锁，守住 F-065 / F-017 的保护。
 * 全局取锁顺序不变：员工闭包 / 多员工业务头 → 组织 / 编制 → 账号 / 成员 → 剩余业务头 → 实例。
 */
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { createUser, grantMembership, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { approvalWorld, transferScene } from './AC-APV-support.js';
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

/** 外部账号 U 持有离职申请（非调动任职业务）的异常待办；countersign 时 U 占会签节点里无人可办的那一席。 */
async function leaveScene(label: string, countersign: boolean) {
  const w = await approvalWorld(database().db, label);
  const s = await transferScene(w);
  const source = await createUser(
    w.db,
    { email: `${label}-${randomUUID()}@example.com`, displayName: '外部异常管理员' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: source.id, expectedRevision: 0 }, cmd());
  await w.setOrgRoles(s.from, { hrbp: null });
  const process = await w.publishedProcess({
    approvalType: 'leave',
    conditions: LEAVE_CONDITION,
    nodes: [NODES.outHead, countersign ? COUNTERSIGN : { key: 'hrbp', approver: 'record_department_hrbp' }],
    exceptionAdminUserId: source.id,
  });
  const employee = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/employment/employees/${s.subject.employeeId}`),
  );
  const created = await w.json<{ id: string; revision: number }>(
    await w.request(w.hr.id, 'POST', `/api/tenant/employment/employees/${s.subject.employeeId}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'leave', mode: 'application', lastWorkDate: '2026-10-20', fields: {} },
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
async function organizationLockFreeWhileHandoverQueued(f: Awaited<ReturnType<typeof leaveScene>>) {
  let handedOver: Promise<Response> = Promise.resolve(new Response());
  let free: boolean | undefined;
  await withTenant(f.w.db, f.w.tenant.id, async (barrier) => {
    await barrier.execute(sql`SELECT id FROM approval_instances
      WHERE tenant_id=${f.w.tenant.id} AND id=${f.view.id}::uuid FOR UPDATE`);
    handedOver = f.handover();
    await waitForBlocked(f.w.db, 1);
    free = await f.tryOrganizationLock().then(
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
  it('仅改派（不会合席）：交接排队等实例锁时不持组织锁，普通组织写入不被挡住；交接结果不变', async () => {
    const f = await leaveScene('f070-reassign-only', false);
    expect(await organizationLockFreeWhileHandoverQueued(f)).toBe(true);
    expect(pendingOf(await f.w.detail(f.view.id))).toEqual([expect.objectContaining({ assigneeUserId: f.successor })]);
  });

  it('会签合席（替代人已占本节点一席，非调动任职业务）：仍持组织锁，守住合席结算 / 落地的保护', async () => {
    const f = await leaveScene('f070-countersign-merge', true);
    expect(await organizationLockFreeWhileHandoverQueued(f)).toBe(false);
  });
});
