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
import { rowsOf } from './AC-DM-R2-blacklist-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
/** 联系邮箱按用例区分：同一测试库里前一用例改名后已占用的邮箱会让后一用例撞唯一约束。 */
const contactOf = (label: string) => `Rehire.${label}@Example.com`;
const world = async (label: string, contact: string | null = contactOf(label)) => {
  const x = await downstreamWorld(database().db, `f328-${label}`);
  const userId = await x.applicantAccount(x.employee.id);
  if (contact !== null) await setContactEmail(x, contact);
  return { x, userId, contact: contact?.toLowerCase() };
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
/** 真实离职入口：10-04 保存最后工作日 10-04 的直接离职，10-05 调度生效并停用账号（F-261），时钟回到 10-06。 */
async function leave(x: World) {
  const created = await x.directLeave('2026-10-04', { exitTypeCode: 'voluntary' });
  await x.runScheduler('2026-10-05T01:00:00Z');
  x.setNow('2026-10-06T01:00:00.000Z');
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
const accountTasks = (x: World) =>
  x.sqlRows<{ status: string; restore: boolean; auto: number | null }>(sql`
    SELECT status, restore_requested AS restore, auto_revision AS auto FROM exit_account_tasks
    WHERE tenant_id=${x.session.tenant.id} ORDER BY business_id`);
const links = (x: World) =>
  x.sqlRows<{ userId: string }>(sql`SELECT user_id::text AS "userId" FROM permission_user_person_links
    WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`);

describe('F-328 / DEC-707 重聘（合并人员）沿用原账号', () => {
  it('当天重聘：同一账号自动启用、登录名改为联系邮箱，人员绑定不变，任职三段连续，审计留痕', async () => {
    const { x, userId, contact } = await world('same-day');
    const before = (await getUser(x.db, userId))!;
    await leave(x);
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
    const response = await rehire(x);
    expect(response.status, await response.clone().text()).toBe(201);

    const after = (await getUser(x.db, userId))!;
    expect(after).toMatchObject({ id: before.id, status: 'active', email: contact });
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
        after: expect.objectContaining({ email: contact }),
      }),
    );
    expect(events.filter((e) => e.action === 'user.set_status').at(-1)).toMatchObject({
      after: { status: 'active' },
    });
    expect(await tenantAudit(x, 'tenant_user.login_email')).toEqual([
      {
        before: expect.objectContaining({ email: before.email }),
        after: expect.objectContaining({ email: contact }),
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

  it('联系邮箱格式不合法（档案为自由文本，导入可能带入）：登录名不变，重聘照常保存并启用账号', async () => {
    const { x, userId } = await world('malformed', 'not an email');
    const before = (await getUser(x.db, userId))!;
    await leave(x);
    const response = await rehire(x);
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'active', email: before.email });
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
    const { x, userId, contact } = await world('legacy-login');
    const before = (await getUser(x.db, userId))!;
    await leave(x);
    const response = await rehire(x, '2026-10-06', { loginEmail: before.email });
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'active', email: contact });
  });

  it('未来日期重聘：保存即改登录名，到入职日才启用账号（调度补偿）', async () => {
    const { x, userId, contact } = await world('future');
    await leave(x);
    expect((await rehire(x, '2026-10-20')).status).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'disabled', email: contact });
    await x.runScheduler('2026-10-19T15:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
    await x.runScheduler('2026-10-20T01:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('active');
  });

  it('离职后人工再次停用（DEC-685③）：重聘不擅自启用，登录名照常改', async () => {
    const { x, userId, contact } = await world('manual');
    await leave(x);
    const disabled = (await getUser(x.db, userId))!;
    await setUserStatus(database().db, { userId, status: 'disabled', expectedRevision: disabled.revision }, cmd());
    expect((await rehire(x)).status).toBe(201);
    expect((await getUser(x.db, userId))!).toMatchObject({ status: 'disabled', email: contact });
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

  it('当天重聘时账号启用写入失败：整单失败，账号、员工 revision、任职链、审计与账号任务都保持提交前状态', async () => {
    const { x, userId } = await world('enable-failure');
    await leave(x);
    const account = (await getUser(x.db, userId))!;
    const employee = (await x.session.getEmployee(x.employee.id)).revision;
    const timeline = await x.timeline();
    const audits = await platformAudit(userId);
    const tasks = await accountTasks(x);
    // 合成存储故障：只拦“停用 → 启用”这一次写入（离职停用已在上面完成）
    await x.db.execute(sql`CREATE FUNCTION f328_fail_enable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'active' AND OLD.status = 'disabled' THEN
        RAISE EXCEPTION 'synthetic enable storage failure' USING ERRCODE = '53100';
      END IF; RETURN NEW; END $$`);
    await x.db.execute(sql`CREATE TRIGGER f328_fail_enable BEFORE UPDATE OF status ON users
      FOR EACH ROW EXECUTE FUNCTION f328_fail_enable()`);
    try {
      const response = await rehire(x);
      expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(500);
    } finally {
      await x.db.execute(sql`DROP TRIGGER f328_fail_enable ON users`);
      await x.db.execute(sql`DROP FUNCTION f328_fail_enable()`);
    }
    expect(await getUser(x.db, userId)).toEqual(account);
    expect((await x.session.getEmployee(x.employee.id)).revision).toBe(employee);
    expect(await x.timeline()).toEqual(timeline);
    expect(await platformAudit(userId)).toEqual(audits);
    expect(await tenantAudit(x, 'tenant_user.login_email')).toEqual([]);
    expect(await accountTasks(x)).toEqual(tasks);
  });

  it('当天重聘在同一事务里启用账号：响应返回时已启用，账号任务已恢复并记下启用后的 revision', async () => {
    const { x, userId } = await world('same-tx');
    await leave(x);
    const response = await rehire(x);
    expect(response.status, await response.clone().text()).toBe(201);
    const after = (await getUser(x.db, userId))!;
    expect(after.status).toBe('active');
    expect(await accountTasks(x)).toEqual([
      expect.objectContaining({ status: 'restored', restore: false, auto: after.revision }),
    ]);
  });

  it('未来待重聘保存后取消（DEC-711 b）：原入职日及之后调度都不启用账号，恢复请求撤销', async () => {
    const { x, userId } = await world('cancelled');
    await leave(x);
    const created = await rehire(x, '2026-10-20', { pendingEntry: true });
    expect(created.status, await created.clone().text()).toBe(201);
    const body = (await created.json()) as { id: string; revision: number };
    expect(await accountTasks(x)).toEqual([expect.objectContaining({ restore: true })]);
    const cancelled = await x.session.request('POST', `/pending-entries/${body.id}/cancel`, {
      ifMatch: body.revision,
      body: { reason: 'other' },
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    expect(await accountTasks(x)).toEqual([expect.objectContaining({ status: 'disabled', restore: false })]);
    await x.runScheduler('2026-10-20T01:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
    await x.runScheduler('2026-10-21T01:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
  });

  it('删除已自动启用的重聘（DEC-711 d）：调度后账号恢复离职停用并留审计，登录名保持联系邮箱', async () => {
    const { x, userId, contact } = await world('deleted');
    await leave(x);
    const response = await rehire(x);
    expect(response.status, await response.clone().text()).toBe(201);
    const body = (await response.json()) as { id: string; revision: number };
    expect((await getUser(x.db, userId))!.status).toBe('active');
    const deleted = await x.session.request('DELETE', `/businesses/${body.id}`, { ifMatch: body.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    await x.runScheduler('2026-10-06T02:00:00Z');
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'leave']);
    const account = (await getUser(x.db, userId))!;
    expect(account).toMatchObject({ status: 'disabled', email: contact });
    expect((await platformAudit(userId)).filter((e) => e.action === 'user.set_status').at(-1)).toMatchObject({
      before: { status: 'active' },
      after: { status: 'disabled' },
    });
    expect(await accountTasks(x)).toEqual([expect.objectContaining({ status: 'disabled', auto: account.revision })]);
    const changes = await tenantAudit(x, 'employment.exit_account.task');
    expect(changes.at(-1)).toMatchObject({ after: expect.objectContaining({ status: 'disabled' }) });
  });

  it('自动启用后账号被人工改动过：删除重聘不再自动停用（保留人工修改）', async () => {
    const { x, userId } = await world('deleted-manual');
    await leave(x);
    const response = await rehire(x);
    const body = (await response.json()) as { id: string; revision: number };
    const enabled = (await getUser(x.db, userId))!;
    const disabled = await setUserStatus(
      database().db,
      { userId, status: 'disabled', expectedRevision: enabled.revision },
      cmd(),
    );
    await setUserStatus(database().db, { userId, status: 'active', expectedRevision: disabled.revision }, cmd());
    const deleted = await x.session.request('DELETE', `/businesses/${body.id}`, { ifMatch: body.revision });
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    await x.runScheduler('2026-10-06T02:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('active');
  });

  it('当天待重聘已启用后改期到未来：改期即重新停用，到新入职日再启用', async () => {
    const { x, userId } = await world('postponed');
    await leave(x);
    const created = await rehire(x, '2026-10-06', { pendingEntry: true });
    expect(created.status, await created.clone().text()).toBe(201);
    const body = (await created.json()) as { id: string; revision: number };
    expect((await getUser(x.db, userId))!.status).toBe('active');
    const postponed = await x.session.request('POST', `/pending-entries/${body.id}/postpone`, {
      ifMatch: body.revision,
      body: { effectiveDate: '2026-10-20' },
    });
    expect(postponed.status, await postponed.clone().text()).toBe(200);
    await x.runScheduler('2026-10-06T02:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('disabled');
    await x.runScheduler('2026-10-20T01:00:00Z');
    expect((await getUser(x.db, userId))!.status).toBe('active');
  });
});
