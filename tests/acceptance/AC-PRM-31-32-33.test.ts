/**
 * AC-PRM-31~33（DEC-128，`06` §9）：租户内用户与人员一一对应、由建档产生。
 * - 31：建立人员档案 / 办理入职时，在同一事务里自动创建并绑定租户用户，按登录邮箱复用已有全局账号；
 *       用户类型 = 内部员工；账号启用状态与在职状态分别记录。
 * - 32：内部员工不提供手工绑定或改绑入口，接口一律拒绝，绑定关系不变。
 * - 33：没有人员档案的账号必须登记为外部用户并带业务身份；外部用户不出现在人员档案与任职列表中。
 */
import { auditEvents, createUser, eq, grantMembership, sql, users, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import {
  getTenantUser,
  hrApi,
  listUsers,
  memberWithAdminRole,
  reasonOf,
  syntheticEmail,
} from './AC-PRM-users-support.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';

const testDb = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('AC-PRM-31 建档 / 入职自动创建并绑定租户用户', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  it('建档带登录邮箱：复用另一租户已有的全局账号（不新建第二个），用户类型 = 内部员工', async () => {
    const { db } = testDb();
    const other = await seedTenantWithMember(db, 'prm31-other');
    const email = syntheticEmail('wangwu');
    const wang = await createUser(db, { email, displayName: '王五' }, cmd());
    await grantMembership(db, { tenantId: other.tenant.id, userId: wang.id, expectedRevision: 0 }, cmd());

    // 登录邮箱大小写不敏感，按规范化后的邮箱复用
    const employee = await hr.employee('王五', email.toUpperCase());

    const bound = (await listUsers(world, 'internal')).find((u) => u.employeeId === employee.id);
    expect(bound).toMatchObject({
      userId: wang.id,
      email,
      userType: 'internal',
      businessIdentity: null,
      membershipStatus: 'active',
      accountStatus: 'active',
    });
    const accounts = await withPlatform(db, (tx) => tx.select().from(users).where(eq(users.email, email)));
    expect(accounts).toHaveLength(1);

    // 同一事务写审计与 outbox
    const events = await withTenant(db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, wang.id)),
    );
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['tenant_user.provision']));
    const outbox = await withTenant(db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT event_type FROM permission_outbox WHERE object_id=${wang.id}`),
    );
    expect(rowsOf<{ event_type: string }>(outbox).map((r) => r.event_type)).toContain('tenant_user.provision');
  });

  it('DEC-140：建档可暂无邮箱；入职无邮箱被拒且不生效；补登录邮箱后入职成功并建用户', async () => {
    const departmentId = await hr.org('入职部门');
    const employee = await hr.employee('赵六');
    expect((await listUsers(world)).some((u) => u.employeeId === employee.id)).toBe(false);

    const rejected = await hr.hire(employee, departmentId);
    expect(await reasonOf(rejected)).toMatchObject({ status: 400, reason: 'LOGIN_EMAIL_REQUIRED' });
    expect((await hr.getEmployee(employee.id)).status).toBe('pending');
    expect((await listUsers(world)).some((u) => u.employeeId === employee.id)).toBe(false);

    const email = syntheticEmail('zhaoliu');
    const hired = await hr.hire(employee, departmentId, { loginEmail: email });
    expect(hired.status, await hired.clone().text()).toBe(201);
    expect((await hr.getEmployee(employee.id)).status).toBe('employed');

    const bound = (await listUsers(world, 'internal')).find((u) => u.employeeId === employee.id);
    expect(bound).toMatchObject({ email, displayName: '赵六', userType: 'internal', accountStatus: 'active' });
  });

  it('DEC-140：入职申请（审批制）同样必须有登录邮箱；建档时已给邮箱的人员入职可不再填写', async () => {
    const departmentId = await hr.org('申请部门');
    const unbound = await hr.employee('申请入职');
    const application = await hr.hire(unbound, departmentId, { mode: 'application' });
    expect(await reasonOf(application)).toMatchObject({ status: 400, reason: 'LOGIN_EMAIL_REQUIRED' });

    const email = syntheticEmail('prebound');
    const bound = await hr.employee('已有账号', email);
    const hired = await hr.hire(bound, departmentId);
    expect(hired.status, await hired.clone().text()).toBe(201);
    expect((await listUsers(world)).find((u) => u.employeeId === bound.id)).toMatchObject({ email });
  });

  it('账号启用状态与在职状态分别记录：待入职员工的账号已启用；建档命令重放不建第二个用户', async () => {
    const email = syntheticEmail('pending');
    const options = {
      ...world.asAdmin,
      ifMatch: 0,
      idempotencyKey: `prm31-${randomUUID()}`,
      body: { code: `P_${randomUUID().slice(0, 8)}`, name: '待入职', loginEmail: email },
    };
    const first = await hr.api.request('POST', '/api/tenant/employment/employees', options);
    const replay = await hr.api.request('POST', '/api/tenant/employment/employees', options);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const employee = (await first.json()) as { id: string };
    expect((await hr.getEmployee(employee.id)).status).toBe('pending');
    const bound = (await listUsers(world)).filter((u) => u.email === email);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ employeeId: employee.id, accountStatus: 'active', membershipStatus: 'active' });
  });
});

describe('AC-PRM-32 不提供内部员工的手工绑定 / 改绑入口', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;
  let wangEmail: string;
  let wang: { id: string; revision: number };
  let wangUserId: string;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
    wangEmail = syntheticEmail('wang32');
    wang = await hr.employee('王五', wangEmail);
    wangUserId = (await listUsers(world)).find((u) => u.employeeId === wang.id)!.userId;
  });

  it('用户人员绑定接口一律拒绝（PUT / DELETE → 403），绑定关系不变；GET 仍可只读', async () => {
    const other = await hr.employee('另一人');
    const path = `${BASE}/person-links/${wangUserId}`;
    const rebind = await world.api.request('PUT', path, {
      ...world.asAdmin,
      ifMatch: 1,
      body: { employeeId: other.id },
    });
    expect(await reasonOf(rebind)).toMatchObject({ status: 403, code: 'FORBIDDEN', reason: 'USER_BINDING_BY_PROFILE' });
    const unbind = await world.api.request('DELETE', path, { ...world.asAdmin, ifMatch: 1, body: {} });
    expect(await reasonOf(unbind)).toMatchObject({ status: 403, reason: 'USER_BINDING_BY_PROFILE' });

    // 给一个尚无档案的成员手工新建绑定，同样拒绝
    const stray = await addMember(world, 'stray');
    const create = await world.api.request('PUT', `${BASE}/person-links/${stray.id}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { employeeId: other.id },
    });
    expect(create.status).toBe(403);

    const read = await world.api.request('GET', path, world.asAdmin);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ userId: wangUserId, employeeId: wang.id });
  });

  it('用户管理不能新建内部员工：提示前往新增员工', async () => {
    const response = await world.api.request('POST', `${BASE}/users`, {
      ...world.asAdmin,
      body: { email: syntheticEmail('internal'), displayName: '手工内部员工', userType: 'internal' },
    });
    expect(await reasonOf(response)).toMatchObject({ status: 403, reason: 'INTERNAL_USER_BY_PROFILE' });
  });

  it('同一登录邮箱再建一份档案、入职改用另一邮箱 → 409，档案不建、绑定不变', async () => {
    const code = `DUP_${randomUUID().slice(0, 8)}`;
    const duplicate = await hr.createEmployee({ name: '王五重复', code, loginEmail: wangEmail });
    expect(await reasonOf(duplicate)).toMatchObject({ status: 409, reason: 'ACCOUNT_BOUND_TO_OTHER_PERSON' });
    const listed = await hr.api.request('GET', `/api/tenant/employment/employees?code=${code}`, world.asAdmin);
    expect(((await listed.json()) as { items: unknown[] }).items).toEqual([]);

    const departmentId = await hr.org('改绑部门');
    const current = await hr.getEmployee(wang.id);
    const hired = await hr.hire(current, departmentId, { loginEmail: syntheticEmail('another') });
    expect(await reasonOf(hired)).toMatchObject({ status: 409, reason: 'USER_REBIND_FORBIDDEN' });
    expect(await getTenantUser(world, wangUserId)).toMatchObject({ employeeId: wang.id, email: wangEmail });
  });

  it('数据库层同样不允许改绑：应用角色不能 UPDATE 用户人员绑定', async () => {
    const other = await hr.employee('改绑目标');
    await expect(
      withTenant(testDb().db, world.tenant.id, (tx) =>
        tx.execute(sql`UPDATE permission_user_person_links SET employee_id=${other.id}::uuid
          WHERE user_id=${wangUserId}::uuid`),
      ),
    ).rejects.toThrow();
  });
});

describe('AC-PRM-33 没有人员档案的账号登记为外部用户', () => {
  let world: PermissionWorld;
  let hr: ReturnType<typeof hrApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    hr = hrApi(world);
  });

  const createUserCall = (body: Record<string, unknown>) =>
    world.api.request('POST', `${BASE}/users`, { ...world.asAdmin, body });

  it('必须选择用户类型 = 外部用户并指定业务身份，否则拒绝保存', async () => {
    const email = syntheticEmail('hunter');
    expect((await createUserCall({ email, displayName: '猎头' })).status).toBe(400);
    expect((await createUserCall({ email, displayName: '猎头', userType: 'external' })).status).toBe(400);
    const blank = await createUserCall({ email, displayName: '猎头', userType: 'external', businessIdentity: '  ' });
    expect(blank.status).toBe(400);
    expect((await listUsers(world)).some((u) => u.email === email)).toBe(false);

    const saved = await createUserCall({ email, displayName: '猎头', userType: 'external', businessIdentity: '猎头' });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await saved.json()).toMatchObject({
      email,
      userType: 'external',
      businessIdentity: '猎头',
      employeeId: null,
      membershipStatus: 'active',
    });
    expect((await listUsers(world, 'external')).map((u) => u.email)).toContain(email);
    expect((await listUsers(world, 'internal')).map((u) => u.email)).not.toContain(email);
    // 同一账号重复登记 → 409
    const again = await createUserCall({ email, displayName: '猎头', userType: 'external', businessIdentity: '猎头' });
    expect(again.status).toBe(409);
  });

  it('外部用户不出现在人员档案与任职列表中；也不能再为其建档', async () => {
    const email = syntheticEmail('vendor');
    const saved = await createUserCall({
      email,
      displayName: '外部供应商',
      userType: 'external',
      businessIdentity: '外部供应商',
    });
    const external = (await saved.json()) as { userId: string };

    const personnel = await hr.api.request('GET', '/api/tenant/personnel/employees?pageSize=200', world.asAdmin);
    expect(personnel.status).toBe(200);
    const people = ((await personnel.json()) as { items: { userId?: string; name?: string }[] }).items;
    expect(people.some((p) => p.userId === external.userId || p.name === '外部供应商')).toBe(false);
    const employees = await hr.api.request('GET', '/api/tenant/employment/employees?name=外部供应商', world.asAdmin);
    expect(((await employees.json()) as { items: unknown[] }).items).toEqual([]);

    const profile = await hr.createEmployee({ name: '外部供应商', loginEmail: email });
    expect(await reasonOf(profile)).toMatchObject({ status: 409, reason: 'EXTERNAL_USER_HAS_NO_PROFILE' });
  });

  it('修改外部用户的业务身份须带 revision；内部员工的用户类型不能改', async () => {
    const saved = await createUserCall({
      email: syntheticEmail('consultant'),
      displayName: '实施顾问',
      userType: 'external',
      businessIdentity: '实施人员',
    });
    const external = (await saved.json()) as { userId: string; membershipRevision: number };
    const path = `${BASE}/users/${external.userId}`;
    const body = { userType: 'external', businessIdentity: '实施顾问' };
    const updated = await world.api.request('PUT', path, {
      ...world.asAdmin,
      ifMatch: external.membershipRevision,
      body,
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({
      businessIdentity: '实施顾问',
      membershipRevision: external.membershipRevision + 1,
    });
    const stale = await world.api.request('PUT', path, {
      ...world.asAdmin,
      ifMatch: external.membershipRevision,
      body,
    });
    expect(stale.status).toBe(409);

    const employee = await hr.employee('内部员工', syntheticEmail('staff'));
    const internal = (await listUsers(world)).find((u) => u.employeeId === employee.id)!;
    const locked = await world.api.request('PUT', `${BASE}/users/${internal.userId}`, {
      ...world.asAdmin,
      ifMatch: internal.membershipRevision,
      body: { userType: 'external', businessIdentity: '猎头' },
    });
    expect(await reasonOf(locked)).toMatchObject({ status: 409, reason: 'USER_TYPE_LOCKED' });
  });

  it('数据库层：外部用户的业务身份不能为空（含 SQL NULL，astra P3）', async () => {
    const member = await addMember(world, 'null-identity');
    const setType = (identity: string | null) =>
      withTenant(testDb().db, world.tenant.id, (tx) =>
        tx.execute(sql`UPDATE tenant_memberships SET user_type='external', business_identity=${identity}
          WHERE user_id=${member.id}::uuid`),
      );
    await expect(setType(null)).rejects.toThrow();
    await expect(setType('  ')).rejects.toThrow();
    await expect(setType('猎头')).resolves.toBeDefined();
  });

  it('只有持「用户管理」能力的管理员可用（06 §7.1）：员工管理员可以，权限管理员 403', async () => {
    const employeeAdmin = await memberWithAdminRole(world, 'employee_admin');
    expect((await listUsers(world, 'all', employeeAdmin.as)).length).toBeGreaterThan(0);
    const permissionAdmin = await memberWithAdminRole(world, 'permission_admin');
    const denied = await world.api.request('GET', `${BASE}/users`, permissionAdmin.as);
    expect(denied.status).toBe(403);
    const plain = await addMember(world, 'plain');
    const create = await world.api.request('POST', `${BASE}/users`, {
      user: plain.id,
      tenant: world.tenant.id,
      body: { email: syntheticEmail('x'), displayName: 'x', userType: 'external', businessIdentity: '猎头' },
    });
    expect(create.status).toBe(403);
  });
});
