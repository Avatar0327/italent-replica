/**
 * 企业设置 · 用户管理的停用与移出租户（R1-T15）：一律调用 PR #35 的平台流程（`packages/db/src/platform-ops.ts`），
 * 不另写一套——移出租户 = revokeMembership（同事务经挂接点接管待办，DEC-123）；停用用户 = setUserStatus 全局停用。
 * DEC-098：仍是可用流程异常管理员的成员须先指定替代人，否则两者都拒绝。
 * 停用全局账号只允许账号仅属本租户时进行，不能借租户侧接口影响其他租户（硬规则 7）。
 */
import { auditEvents, createUser, eq, getUser, grantMembership, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { approvalWorld, permissionAdmin, TRANSFER_NODES } from './AC-APV-support.js';
import { BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import {
  getTenantUser,
  hrApi,
  listUsers,
  memberWithAdminRole,
  reasonOf,
  syntheticEmail,
  type TenantUserBody,
} from './AC-PRM-users-support.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';

const testDb = useTestDb();

describe('移出租户：调用平台撤销成员流程', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  async function internalUser(name: string): Promise<TenantUserBody> {
    const employee = await hr.employee(name, syntheticEmail('remove'));
    return (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
  }

  it('带成员关系 revision；旧 revision → 409；成功后成员关系 revoked、写审计，档案绑定保留', async () => {
    const target = await internalUser('移出对象');
    const path = `${BASE}/users/${target.userId}/remove`;
    const stale = await world.api.request('POST', path, { ...world.asAdmin, ifMatch: target.membershipRevision + 5 });
    expect(stale.status).toBe(409);
    const removed = await world.api.request('POST', path, { ...world.asAdmin, ifMatch: target.membershipRevision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toMatchObject({ membershipStatus: 'revoked', employeeId: target.employeeId });

    const events = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'tenant_membership.revoke')),
    );
    expect(events.some((e) => (e.after as { userId?: string } | null)?.userId === target.userId)).toBe(true);
    // 被移出的成员不能再访问本租户
    const denied = await world.api.request('GET', `${BASE}/me/objects/Demo.EmploymentRecord`, {
      user: target.userId,
      tenant: world.tenant.id,
    });
    expect(denied.status).toBe(403);
  });

  it('同一 Idempotency-Key 重放返回首次结果；不能移出他租户成员（按不存在处理）', async () => {
    const target = await internalUser('重放对象');
    const options = { ...world.asAdmin, ifMatch: target.membershipRevision, idempotencyKey: 'remove-replay-1' };
    const path = `${BASE}/users/${target.userId}/remove`;
    expect((await world.api.request('POST', path, options)).status).toBe(200);
    const replay = await world.api.request('POST', path, options);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ membershipStatus: 'revoked' });

    const other = await seedTenantWithMember(testDb().db, 'remove-other');
    const foreign = await world.api.request('POST', `${BASE}/users/${other.user.id}/remove`, {
      ...world.asAdmin,
      ifMatch: 1,
    });
    expect(foreign.status).toBe(404);
  });

  it('只有持「用户管理」能力的管理员可以移出（06 §7.1）：审计管理员 403', async () => {
    const target = await internalUser('无权移出');
    const audit = await memberWithAdminRole(world, 'audit_admin');
    const response = await world.api.request('POST', `${BASE}/users/${target.userId}/remove`, {
      ...audit.as,
      ifMatch: target.membershipRevision,
    });
    expect(response.status).toBe(403);
  });
});

describe('停用用户：调用平台全局停用流程', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  it('账号同属其他租户 → 409，账号保持启用；只属本租户 → 停用，在职状态不受影响', async () => {
    const { db } = testDb();
    const email = syntheticEmail('shared');
    const shared = await createUser(db, { email, displayName: '共享账号' }, cmd());
    const other = await seedTenantWithMember(db, 'disable-other');
    await grantMembership(db, { tenantId: other.tenant.id, userId: shared.id, expectedRevision: 0 }, cmd());
    const sharedEmployee = await hr.employee('共享账号', email);
    const sharedUser = await getTenantUser(world, shared.id);
    expect(sharedUser.employeeId).toBe(sharedEmployee.id);
    const blocked = await world.api.request('POST', `${BASE}/users/${shared.id}/status`, {
      ...world.asAdmin,
      ifMatch: sharedUser.accountRevision,
      body: { status: 'disabled' },
    });
    expect(await reasonOf(blocked)).toMatchObject({ status: 409, reason: 'ACCOUNT_SHARED_ACROSS_TENANTS' });
    expect((await getUser(db, shared.id))!.status).toBe('active');

    const departmentId = await hr.org('停用部门');
    const employee = await hr.employee('专属账号', syntheticEmail('exclusive'));
    expect((await hr.hire(employee, departmentId)).status).toBe(201);
    const user = (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
    const disabled = await world.api.request('POST', `${BASE}/users/${user.userId}/status`, {
      ...world.asAdmin,
      ifMatch: user.accountRevision,
      body: { status: 'disabled' },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect(await disabled.json()).toMatchObject({ accountStatus: 'disabled', membershipStatus: 'active' });
    expect((await hr.getEmployee(employee.id)).status).toBe('employed');

    const reenabled = await world.api.request('POST', `${BASE}/users/${user.userId}/status`, {
      ...world.asAdmin,
      ifMatch: user.accountRevision + 1,
      body: { status: 'active' },
    });
    expect(reenabled.status).toBe(200);
    expect(await reenabled.json()).toMatchObject({ accountStatus: 'active' });
  });

  it('不能停用自己；旧账号 revision → 409', async () => {
    const self = await getTenantUser(world, world.admin.id);
    const own = await world.api.request('POST', `${BASE}/users/${world.admin.id}/status`, {
      ...world.asAdmin,
      ifMatch: self.accountRevision,
      body: { status: 'disabled' },
    });
    expect(await reasonOf(own)).toMatchObject({ status: 409, reason: 'CANNOT_DISABLE_SELF' });

    const employee = await hr.employee('旧版本', syntheticEmail('stale'));
    const user = (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
    const stale = await world.api.request('POST', `${BASE}/users/${user.userId}/status`, {
      ...world.asAdmin,
      ifMatch: user.accountRevision + 3,
      body: { status: 'disabled' },
    });
    expect(stale.status).toBe(409);
  });
});

describe('DEC-098 / DEC-123：异常管理员须先指定替代人', () => {
  it('仍是可用流程的异常管理员 → 移出租户与停用都 409；在审批中心交接后可以移出', async () => {
    const w = await approvalWorld(testDb().db, 'prm-dec098');
    await w.publishedProcess({ nodes: [TRANSFER_NODES[0]!] });
    const world = await permissionAdmin(w);
    const target = await getTenantUser(world, w.exceptionAdmin);

    const remove = () =>
      world.api.request('POST', `${BASE}/users/${w.exceptionAdmin}/remove`, {
        ...world.asAdmin,
        ifMatch: target.membershipRevision,
      });
    expect(await reasonOf(await remove())).toMatchObject({
      status: 409,
      reason: 'APPROVAL_EXCEPTION_ADMIN_HANDOVER_REQUIRED',
    });
    const disable = await world.api.request('POST', `${BASE}/users/${w.exceptionAdmin}/status`, {
      ...world.asAdmin,
      ifMatch: target.accountRevision,
      body: { status: 'disabled' },
    });
    expect(await reasonOf(disable)).toMatchObject({
      status: 409,
      reason: 'APPROVAL_EXCEPTION_ADMIN_HANDOVER_REQUIRED',
    });
    expect((await getTenantUser(world, w.exceptionAdmin)).membershipStatus).toBe('active');

    const successor = await w.member('接任异常管理员');
    await w.json(
      await w.request(w.hr.id, 'POST', '/api/tenant/approval/exception-admins/handover', {
        ifMatch: 0,
        body: { fromUserId: w.exceptionAdmin, toUserId: successor },
      }),
    );
    const removed = await remove();
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toMatchObject({ membershipStatus: 'revoked' });
  });
});
