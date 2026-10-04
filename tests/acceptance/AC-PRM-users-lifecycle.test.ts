/**
 * 企业设置 · 用户管理的停用、启用与移出租户（R1-T15）：一律调用 PR #35 的平台流程（`packages/db/src/platform-ops.ts`），
 * 不另写一套。DEC-142：租户侧的“停用 / 移出”只作用于本租户成员关系（revokeMembership，同事务经挂接点接管待办，
 * DEC-123），“启用”恢复本租户成员关系（grantMembership）；账号的全局停用只由平台运营层执行，租户侧返回不提及其他租户。
 * DEC-098：仍是可用流程异常管理员的成员须先指定替代人，否则拒绝。
 * astra P2-2：命令重放返回首次回执（取自平台命令台账），不回查当前状态（AGENTS.md §10「幂等」）。
 */
import { auditEvents, createUser, eq, getUser, grantMembership, sql, withTenant } from '@italent/db';
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

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

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
    expect(await removed.json()).toEqual({
      userId: target.userId,
      membershipStatus: 'revoked',
      membershipRevision: target.membershipRevision + 1,
    });
    expect(await getTenantUser(world, target.userId)).toMatchObject({
      membershipStatus: 'revoked',
      employeeId: target.employeeId,
    });

    const events = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'tenant_membership.revoke')),
    );
    const revoke = events.find((e) => (e.after as { userId?: string } | null)?.userId === target.userId);
    expect(revoke).toBeDefined();
    const outbox = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT event_type FROM permission_outbox WHERE object_id=${revoke!.objectId}`),
    );
    expect(rowsOf<{ event_type: string }>(outbox).map((r) => r.event_type)).toContain('tenant_membership.revoke');
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

  it('astra P2-2：期间被其他命令改过后重放，仍返回首次结果（命令回执取自平台台账，不回查当前状态）', async () => {
    const email = syntheticEmail('replay-external');
    const register = () =>
      world.api.request('POST', `${BASE}/users`, {
        ...world.asAdmin,
        body: { email, displayName: '外部顾问', userType: 'external', businessIdentity: '实施顾问' },
      });
    const external = (await (await register()).json()) as TenantUserBody;
    const options = { ...world.asAdmin, ifMatch: external.membershipRevision, idempotencyKey: 'remove-replay-2' };
    const path = `${BASE}/users/${external.userId}/remove`;
    const first = await world.api.request('POST', path, options);
    const receipt = {
      userId: external.userId,
      membershipStatus: 'revoked',
      membershipRevision: external.membershipRevision + 1,
    };
    expect(await first.json()).toEqual(receipt);
    // 新键：重新登记为外部用户，成员关系恢复有效
    expect((await register()).status).toBe(201);
    const replay = await world.api.request('POST', path, options);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(await getTenantUser(world, external.userId)).toMatchObject({
      membershipStatus: 'active',
      membershipRevision: external.membershipRevision + 2,
    });
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

describe('停用 / 启用：只作用于本租户成员关系（DEC-142）', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  const setStatus = (user: TenantUserBody, status: 'active' | 'disabled', ifMatch: number, key?: string) =>
    world.api.request('POST', `${BASE}/users/${user.userId}/status`, {
      ...world.asAdmin,
      ifMatch,
      body: { status },
      ...(key ? { idempotencyKey: key } : {}),
    });

  it('同属其他租户的账号：停用只撤销本租户成员关系，全局账号与他租户成员关系不变，返回不提及其他租户', async () => {
    const { db } = testDb();
    const email = syntheticEmail('shared');
    const shared = await createUser(db, { email, displayName: '共享账号' }, cmd());
    const other = await seedTenantWithMember(db, 'disable-other');
    await grantMembership(db, { tenantId: other.tenant.id, userId: shared.id, expectedRevision: 0 }, cmd());
    await hr.employee('共享账号', email);
    const user = await getTenantUser(world, shared.id);

    const disabled = await setStatus(user, 'disabled', user.membershipRevision);
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect(await disabled.json()).toEqual({
      userId: shared.id,
      membershipStatus: 'revoked',
      membershipRevision: user.membershipRevision + 1,
    });
    expect((await getUser(db, shared.id))!.status).toBe('active');
    const otherMembership = await withTenant(db, other.tenant.id, (tx) =>
      tx.execute(sql`SELECT status FROM tenant_memberships WHERE user_id=${shared.id}::uuid`),
    );
    expect(rowsOf<{ status: string }>(otherMembership)).toEqual([{ status: 'active' }]);
    // 本租户已不能访问，其他租户照常访问
    const menus = (tenant: string) => world.api.request('GET', `${BASE}/admin-menus`, { user: shared.id, tenant });
    expect((await menus(world.tenant.id)).status).toBe(403);
    expect((await menus(other.tenant.id)).status).toBe(200);
  });

  it('停用不影响在职状态、写本租户审计；启用恢复本租户成员关系', async () => {
    const { db } = testDb();
    const departmentId = await hr.org('停用部门');
    const employee = await hr.employee('专属账号', syntheticEmail('exclusive'));
    expect((await hr.hire(employee, departmentId)).status).toBe(201);
    const user = (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
    const disabled = await setStatus(user, 'disabled', user.membershipRevision);
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    expect((await hr.getEmployee(employee.id)).status).toBe('employed');
    expect(await getTenantUser(world, user.userId)).toMatchObject({
      membershipStatus: 'revoked',
      accountStatus: 'active',
      employeeId: employee.id,
    });
    const events = await withTenant(db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.action, 'tenant_membership.revoke')),
    );
    expect(events.some((e) => (e.after as { userId?: string } | null)?.userId === user.userId)).toBe(true);

    const enabled = await setStatus(user, 'active', user.membershipRevision + 1);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    expect(await enabled.json()).toEqual({
      userId: user.userId,
      membershipStatus: 'active',
      membershipRevision: user.membershipRevision + 2,
    });
  });

  it('astra P2-2：K 停用 → L 启用 → 原样重放 K，返回首次的停用回执，成员关系保持有效', async () => {
    const employee = await hr.employee('重放停用', syntheticEmail('replay-status'));
    const user = (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
    const receipt = {
      userId: user.userId,
      membershipStatus: 'revoked',
      membershipRevision: user.membershipRevision + 1,
    };
    const first = await setStatus(user, 'disabled', user.membershipRevision, 'status-replay-k');
    expect(await first.json()).toEqual(receipt);
    const enable = await setStatus(user, 'active', user.membershipRevision + 1, 'status-replay-l');
    expect(await enable.json()).toEqual({
      ...receipt,
      membershipStatus: 'active',
      membershipRevision: user.membershipRevision + 2,
    });
    const replay = await setStatus(user, 'disabled', user.membershipRevision, 'status-replay-k');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(await getTenantUser(world, user.userId)).toMatchObject({
      membershipStatus: 'active',
      membershipRevision: user.membershipRevision + 2,
    });
  });

  it('不能停用自己；旧成员关系 revision → 409', async () => {
    const self = await getTenantUser(world, world.admin.id);
    const own = await setStatus(self, 'disabled', self.membershipRevision);
    expect(await reasonOf(own)).toMatchObject({ status: 409, reason: 'CANNOT_DISABLE_SELF' });

    const employee = await hr.employee('旧版本', syntheticEmail('stale'));
    const user = (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
    expect((await setStatus(user, 'disabled', user.membershipRevision + 3)).status).toBe(409);
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
      ifMatch: target.membershipRevision,
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
