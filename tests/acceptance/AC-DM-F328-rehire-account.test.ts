/**
 * F-328 / DEC-707：离职后重聘（合并人员）沿用原人员与原账号（docs/02_业务建模/30「F-328」节）。
 * 重聘入职落地后账号由离职自动停用恢复为启用（到入职日才启用，DEC-684 同一持久任务）；登录用户名改为员工联系邮箱
 * （无联系邮箱不改；与他人登录名冲突 409 整单回滚；账号同属其他租户不改）；任职三段连续，离职段在重聘入职日前一天封口。
 */
import './support/exit-gate-enforced.js';
import { getUser, grantMembership, setUserStatus, sql, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { rowsOf } from './AC-DM-R2-blacklist-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const CONTACT = 'Rehire.Contact@Example.com';
const world = async (label: string, contact: string | null = CONTACT) => {
  const x = await downstreamWorld(database().db, `f328-${label}`);
  const userId = await x.applicantAccount(x.employee.id);
  if (contact !== null) await setContactEmail(x, contact);
  return { x, userId };
};
type World = Awaited<ReturnType<typeof downstreamWorld>>;

/** 人员档案最新版本写入联系邮箱（合成数据；档案编辑入口不在本单范围）。 */
async function setContactEmail(x: World, email: string) {
  await x.sqlRows(sql`
    INSERT INTO personnel_employee_versions(tenant_id, employee_id, revision, command_id, created_by, name, email)
    SELECT e.tenant_id, e.id, COALESCE(max(v.revision), 0) + 1, 'f328-fixture', ${x.session.user.id}::uuid, e.name,
      ${email}
    FROM employment_employees e
    LEFT JOIN personnel_employee_versions v ON v.tenant_id = e.tenant_id AND v.employee_id = e.id
    WHERE e.tenant_id = ${x.session.tenant.id} AND e.id = ${x.employee.id}::uuid
    GROUP BY e.tenant_id, e.id, e.name`);
}
/** 真实离职入口：最后工作日 10-04，生效日 10-05 已到，保存即生效并停用账号（F-261）。 */
async function leave(x: World) {
  const created = await x.createdLeave(x.employee.id, leaveBody('2026-10-04', 'direct', { exitTypeCode: 'voluntary' }));
  expect((await x.business(created.id)).status).toBe('effective');
  return created;
}
async function rehire(x: World, effectiveDate = '2026-10-06', extra: Record<string, unknown> = {}) {
  const employee = await x.session.getEmployee(x.employee.id);
  return x.session.request('POST', `/employees/${x.employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'rehire', mode: 'direct', effectiveDate, fields: { departmentId: x.from.id }, ...extra },
  });
}
const platformAudit = (userId: string) =>
  withPlatform(database().db, async (tx) =>
    rowsOf<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      await tx.execute(sql`SELECT action, before, after FROM platform_audit_events
        WHERE object_type='user' AND object_id=${userId} ORDER BY occurred_at, id`),
    ),
  );
const tenantAudit = (x: World, action: string) =>
  x.sqlRows<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(sql`
    SELECT before, after FROM audit_events WHERE tenant_id=${x.session.tenant.id} AND action=${action}
    ORDER BY occurred_at, id`);
const links = (x: World) =>
  x.sqlRows<{ userId: string }>(sql`SELECT user_id::text AS "userId" FROM permission_user_person_links
    WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`);

describe('F-328 重聘（合并人员）沿用原账号', () => {
  it('当天重聘：同一账号自动启用、登录名改为联系邮箱，人员绑定不变，任职三段连续，审计留痕', async () => {
    const { x, userId } = await world('same-day');
    const before = (await getUser(x.db, userId))!;
    await leave(x);
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
    const response = await rehire(x);
    expect(response.status, await response.clone().text()).toBe(201);

    const after = (await getUser(x.db, userId))!;
    expect(after).toMatchObject({ id: before.id, status: 'active', email: CONTACT.toLowerCase() });
    expect(await links(x)).toEqual([{ userId }]);
    expect((await x.session.getEmployee(x.employee.id)).code).toBeTruthy();
    const timeline = await x.timeline();
    expect(timeline.map((row) => row.kind)).toEqual(['hire', 'leave', 'rehire']);
    // 离职段在重聘入职日前一天封口（区间上界为开区间 10-06）
    expect(timeline[1]!.valid).toBe('[2026-10-05,2026-10-06)');
    expect(timeline[2]!.start_date).toBe('2026-10-06');

    const events = await platformAudit(userId);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'user.change_email',
        before: expect.objectContaining({ email: before.email }),
        after: expect.objectContaining({ email: CONTACT.toLowerCase() }),
      }),
    );
    expect(events.filter((e) => e.action === 'user.set_status').at(-1)).toMatchObject({
      after: { status: 'active' },
    });
    expect(await tenantAudit(x, 'tenant_user.login_email')).toEqual([
      {
        before: expect.objectContaining({ email: before.email }),
        after: expect.objectContaining({ email: CONTACT.toLowerCase() }),
      },
    ]);
    const [task] = await x.sqlRows<{ status: string; restore: boolean }>(sql`
      SELECT status, restore_requested AS restore FROM exit_account_tasks WHERE tenant_id=${x.session.tenant.id}`);
    expect(task).toEqual({ status: 'restored', restore: false });
  });

  it('员工没有联系邮箱：登录名不变，账号照常启用，不写改名审计', async () => {
    const { x, userId } = await world('no-contact', null);
    const before = (await getUser(x.db, userId))!;
    await leave(x);
    expect((await rehire(x)).status).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'active', email: before.email });
    expect((await platformAudit(userId)).map((e) => e.action)).not.toContain('user.change_email');
    expect(await tenantAudit(x, 'tenant_user.login_email')).toEqual([]);
  });

  it('联系邮箱已是别人的登录名：409 EMAIL_TAKEN，整单回滚，不改别人的账号，原账号仍停用', async () => {
    const { x, userId } = await world('taken');
    const other = await x.otherUser();
    await setContactEmail(x, other.email.toUpperCase());
    await leave(x);
    const disabled = (await getUser(x.db, userId))!;
    const timeline = await x.timeline();
    const response = await rehire(x);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(((await response.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'EMAIL_TAKEN' },
    });
    expect(await getUser(x.db, userId)).toEqual(disabled);
    expect(await getUser(x.db, other.id)).toEqual(other);
    expect(await x.timeline()).toEqual(timeline);
    expect((await platformAudit(userId)).map((e) => e.action)).not.toContain('user.change_email');
  });

  it('请求里带原登录邮箱（入职类业务旧参数）仍按同一账号处理，不报改绑', async () => {
    const { x, userId } = await world('legacy-login');
    const before = (await getUser(x.db, userId))!;
    await leave(x);
    const response = await rehire(x, '2026-10-06', { loginEmail: before.email });
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'active', email: CONTACT.toLowerCase() });
  });

  it('未来日期重聘：保存即改登录名，到入职日才启用账号（调度补偿）', async () => {
    const { x, userId } = await world('future');
    await leave(x);
    expect((await rehire(x, '2026-10-20')).status).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'disabled', email: CONTACT.toLowerCase() });
    await x.runScheduler('2026-10-19T15:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
    await x.runScheduler('2026-10-20T01:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('active');
  });

  it('离职后人工再次停用（DEC-685③）：重聘不擅自启用，登录名照常改', async () => {
    const { x, userId } = await world('manual');
    await leave(x);
    const disabled = (await getUser(x.db, userId))!;
    await setUserStatus(database().db, { userId, status: 'disabled', expectedRevision: disabled.revision }, cmd());
    expect((await rehire(x)).status).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'disabled', email: CONTACT.toLowerCase() });
  });

  it('账号同属其他租户：不改全局登录名（不影响他租户），账号照常启用', async () => {
    const { x, userId } = await world('shared');
    const y = await downstreamWorld(database().db, 'f328-shared-other');
    const before = (await getUser(x.db, userId))!;
    await grantMembership(database().db, { tenantId: y.session.tenant.id, userId, expectedRevision: 0 }, cmd());
    await leave(x);
    expect((await rehire(x)).status).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'active', email: before.email });
    expect(await tenantAudit(x, 'tenant_user.login_email')).toEqual([]);
  });
});
