/** F-261 / DEC-098、123、142、684：保护不回滚离职；逐租户接管及授权重试。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { bootstrapTenantAdmin } from '@italent/api';
import { getUser, grantMembership, permissionUserPersonLinks, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  approvalWorld,
  transferScene,
  TRANSFER_NODES,
  type ApprovalWorld,
  type InstanceView,
} from './AC-APV-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const EMP = '/api/tenant/employment';
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];
const pending = (v: InstanceView) => v.tasks.filter((t) => t.status === 'pending');
async function ok(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
  return response.json();
}
async function pendingException(w: ApprovalWorld, userId: string) {
  const s = await transferScene(w);
  await w.setOrgRoles(s.to, { hrbp: null });
  await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!, TRANSFER_NODES[1]!], exceptionAdminUserId: userId });
  let view = await w.submit(await w.application(s.subject.employeeId, { departmentId: s.to }));
  view = await w.json(await w.taskAction(s.outHead.userId, pending(view)[0]!.id, 'approve', view.revision));
  expect(pending(view)[0]!.assigneeUserId).toBe(userId);
  return view;
}
async function scene(label: string) {
  const w = await approvalWorld(database().db, `f261-${label}`);
  await installExitSeeds(w.db, w.tenant.id);
  await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.hr.id }, cmd());
  const admin = await w.member('合成预置管理员');
  await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: admin }, cmd());
  const dept = await w.org('合成离职部门');
  const employee = await w.employee('合成离职异常管理员');
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.insert(permissionUserPersonLinks).values({
      tenantId: w.tenant.id,
      userId: w.exceptionAdmin,
      employeeId: employee.id,
    }),
  );
  await w.hire(employee.id, { departmentId: dept });
  const instance = await pendingException(w, w.exceptionAdmin);
  const current = await ok(await w.request(w.hr.id, 'GET', `${EMP}/employees/${employee.id}`));
  const leave = await ok(
    await w.request(w.hr.id, 'POST', `${EMP}/employees/${employee.id}/businesses`, {
      ifMatch: current.revision,
      body: { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30', fields: {} },
    }),
    201,
  );
  return { w, admin, employee, instance, leave };
}
async function taskOf(f: Awaited<ReturnType<typeof scene>>) {
  return ok(await f.w.request(f.w.hr.id, 'GET', `${EMP}/exit-account/tasks/${f.leave.id}`));
}
async function handover(w: ApprovalWorld, fromUserId: string) {
  const successor = await w.member('合成替代人');
  const receipt = await ok(
    await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
      ifMatch: 0,
      body: { fromUserId, toUserId: successor },
    }),
  );
  expect(receipt.skipped.length).toBeGreaterThan(0);
  return successor;
}
async function retry(f: Awaited<ReturnType<typeof scene>>, key = randomUUID()) {
  const task = await taskOf(f);
  return f.w.request(f.w.hr.id, 'POST', `${EMP}/exit-account/tasks/${f.leave.id}/retry`, {
    ifMatch: task.revision,
    idempotencyKey: key,
    body: {},
  });
}

describe('F-261 保护及重试', () => {
  it('仍为流程异常管理员：离职已生效、账号仍有效，原因持久化、HR 与预置管理员收到同一待办；无权重试被拒', async () => {
    const f = await scene('blocked');
    expect(f.leave.status).toBe('effective');
    expect((await getUser(f.w.db, f.w.exceptionAdmin))!.status).toBe('active');
    const task = await taskOf(f);
    expect(task).toMatchObject({ status: 'blocked', reason: 'APPROVAL_EXCEPTION_ADMIN_HANDOVER_REQUIRED' });
    expect(task.recipientUserIds).toEqual(expect.arrayContaining([f.w.hr.id, f.admin]));
    const api = tenantApi(f.w.db, { clock: f.w.clock, authorize: (r) => r.action !== 'admin.user_manage' });
    const rejected = await api.request('POST', `${EMP}/exit-account/tasks/${f.leave.id}/retry`, {
      ...f.w.as(f.w.hr.id),
      ifMatch: task.revision,
      body: {},
    });
    expect(rejected.status).toBe(403);
    expect(await taskOf(f)).toEqual(task);
    expect((await getUser(f.w.db, f.w.exceptionAdmin))!.status).toBe('active');
  });

  it('手动完成异常管理员替换后重试同一任务，接管剩余待办；同键重放不重复停用或转派', async () => {
    const f = await scene('retry');
    const successor = await handover(f.w, f.w.exceptionAdmin);
    const task = await taskOf(f);
    const key = randomUUID();
    const send = () =>
      f.w.request(f.w.hr.id, 'POST', `${EMP}/exit-account/tasks/${f.leave.id}/retry`, {
        ifMatch: task.revision,
        idempotencyKey: key,
        body: {},
      });
    await ok(await send());
    const user = await getUser(f.w.db, f.w.exceptionAdmin);
    expect(user!.status).toBe('disabled');
    expect((await taskOf(f)).status).toBe('disabled');
    expect(pending(await f.w.detail(f.instance.id))[0]!.assigneeUserId).toBe(successor);
    await ok(await send());
    expect(await getUser(f.w.db, f.w.exceptionAdmin)).toEqual(user);
    const events = await withTenant(f.w.db, f.w.tenant.id, async (tx) =>
      rows(
        await tx.execute(sql`
      SELECT id FROM approval_outbox WHERE tenant_id=${f.w.tenant.id} AND object_id=${f.instance.id}::uuid
      AND event_type='approval.task.transferred'`),
      ),
    );
    expect(events).toHaveLength(1);
    const denied = tenantApi(f.w.db, { clock: f.w.clock, authorize: (r) => r.action !== 'admin.user_manage' });
    expect(
      (
        await denied.request('POST', `${EMP}/exit-account/tasks/${f.leave.id}/retry`, {
          ...f.w.as(f.w.hr.id),
          ifMatch: task.revision,
          idempotencyKey: key,
          body: {},
        })
      ).status,
    ).toBe(403);
  });

  it('DEC-142：另一租户保护同样拒绝，全部交接后才全局停用；两个租户接管、成员关系保持 active', async () => {
    const f = await scene('multi');
    const second = await approvalWorld(f.w.db, 'f261-other');
    await grantMembership(
      f.w.db,
      { tenantId: second.tenant.id, userId: f.w.exceptionAdmin, expectedRevision: 0 },
      cmd(),
    );
    const otherInstance = await pendingException(second, f.w.exceptionAdmin);
    const firstSuccessor = await handover(f.w, f.w.exceptionAdmin);
    await ok(await retry(f));
    expect((await taskOf(f)).status).toBe('blocked');
    expect((await getUser(f.w.db, f.w.exceptionAdmin))!.status).toBe('active');
    // 停用事务整体回滚：第一租户的接管也未部分提交。
    expect(pending(await f.w.detail(f.instance.id))[0]!.assigneeUserId).toBe(f.w.exceptionAdmin);
    const secondSuccessor = await handover(second, f.w.exceptionAdmin);
    await ok(await retry(f));
    expect((await getUser(f.w.db, f.w.exceptionAdmin))!.status).toBe('disabled');
    expect(pending(await f.w.detail(f.instance.id))[0]!.assigneeUserId).toBe(firstSuccessor);
    expect(pending(await second.detail(otherInstance.id))[0]!.assigneeUserId).toBe(secondSuccessor);
    for (const w of [f.w, second]) {
      const [member] = await withTenant(w.db, w.tenant.id, async (tx) =>
        rows<{ status: string }>(
          await tx.execute(sql`
        SELECT status FROM tenant_memberships WHERE tenant_id=${w.tenant.id} AND user_id=${f.w.exceptionAdmin}::uuid`),
        ),
      );
      expect(member!.status).toBe('active');
      expect((await w.request(f.w.exceptionAdmin, 'GET', `${EMP}/exit-account/tasks`)).status).toBe(401);
    }
    expect((await second.request(second.hr.id, 'GET', `${EMP}/exit-account/tasks/${f.leave.id}`)).status).toBe(404);
    expect(
      (
        await second.request(second.hr.id, 'POST', `${EMP}/exit-account/tasks/${f.leave.id}/retry`, {
          ifMatch: 0,
          body: {},
        })
      ).status,
    ).toBe(404);
  });
});
