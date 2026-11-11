/**
 * AC-DM-30-F493-17/22：已导入人员的撤销离职与重聘（S3b，设计 §4.5、§6.3，自查第 5 条）。
 * 导入建的是停用账号 + 虚拟登录名；撤销离职后账号恢复启用但登录名不变（email 仍为 NULL 的 created_with_error 行同样）；
 * 重聘把登录名改为档案电子邮件，启用的是同一个账号，不新建第二个；邮箱被他租户账号占用时重聘 409 EMAIL_TAKEN，
 * 改档案邮箱后可重聘。读写租户 / 平台数据一律走 withTenant / withPlatform（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { createUser, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { drainExitAccounts } from '../../apps/api/src/modules/employment/exit-account-worker.js';
import { TODAY, importWorld, type BatchRow, type ImportWorld } from './AC-DM-30-support.js';
import { readUsers, rowsOf } from './AC-F493-s2-support.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const VIRTUAL = /^va-[0-9a-f]{32}@virtualaccount\.invalid$/;
const NOW = new Date(`${TODAY}T02:00:00Z`);

const accountsOf = (tenantId: string) =>
  withTenant(database().db, tenantId, async (tx) =>
    rowsOf<{ user_id: string; employee_id: string }>(
      await tx.execute(sql`SELECT user_id::text, employee_id::text FROM permission_user_person_links
        WHERE tenant_id=${tenantId}`),
    ),
  );

async function cancelExit(x: ImportWorld, row: BatchRow) {
  const detail = await x.session.request('GET', `/exits/${row.exit_business_id}`);
  const { revision } = (await detail.json()) as { revision: number };
  const done = await x.session.request('POST', `/exits/${row.exit_business_id}/cancel`, {
    ifMatch: revision,
    body: { reason: '合成撤销', confirmed: true },
  });
  expect(done.status, await done.clone().text()).toBe(200);
  await drainExitAccounts(database().db, x.tenantId, NOW);
}

const accountOf = async (x: ImportWorld, employeeId: string) => {
  const link = (await accountsOf(x.tenantId)).find((l) => l.employee_id === employeeId)!;
  return (await readUsers(database().db, [link.user_id]))[0]!;
};

async function rehire(x: ImportWorld, employeeId: string, departmentId: string, effectiveDate = TODAY) {
  const employee = await x.session.getEmployee(employeeId);
  return x.session.request('POST', `/employees/${employeeId}/businesses`, {
    ifMatch: employee.revision,
    body: { kind: 'rehire', mode: 'direct', effectiveDate, fields: { departmentId } },
  });
}

describe('AC-DM-30-F493-17 撤销已导入的离职', () => {
  it('succeeded 行：账号恢复 active、登录名仍是虚拟登录名；created_with_error 行：账号 active、email 仍为 NULL', async () => {
    const db = database().db;
    const x = await importWorld(db, '17');
    const d = await x.dept('撤销部门');
    const taken = `syn.c.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const batchId = await x.imported([x.row(1, d.code), x.row(2, d.code, { email: taken })]);
    const [ok, withError] = await x.rowsOfBatch(batchId);
    expect(ok!.status).toBe('succeeded');
    expect(withError!.status).toBe('created_with_error');

    await cancelExit(x, ok!);
    const okAccount = await accountOf(x, ok!.employee_id!);
    expect(okAccount.status).toBe('active');
    expect(okAccount.email).toMatch(VIRTUAL);

    await cancelExit(x, withError!);
    const errorAccount = await accountOf(x, withError!.employee_id!);
    expect(errorAccount).toMatchObject({ status: 'active', email: null });
  });
});

describe('AC-DM-30-F493-22 重聘已导入的人员', () => {
  it('① succeeded 行：登录名改为档案电子邮件，启用同一账号，没有第二个账号', async () => {
    const db = database().db;
    const x = await importWorld(db, '22-1');
    const d = await x.dept('重聘部门');
    const email = `syn.rehire.${uniqueSuffix()}@example.com`;
    const batchId = await x.imported([x.row(1, d.code, { email })]);
    const [row] = await x.rowsOfBatch(batchId);
    expect(row!.status).toBe('succeeded');
    const before = await accountOf(x, row!.employee_id!);
    expect(before).toMatchObject({ status: 'disabled' });
    expect(before.email).toMatch(VIRTUAL);

    const response = await rehire(x, row!.employee_id!, d.id);
    expect(response.status, await response.clone().text()).toBe(201);
    await drainExitAccounts(db, x.tenantId, NOW);

    const links = await accountsOf(x.tenantId);
    expect(links).toHaveLength(1);
    const after = await accountOf(x, row!.employee_id!);
    expect(after).toMatchObject({ id: before.id, status: 'active', email });
  });

  it('② created_with_error 行：邮箱被他租户账号占用 → 重聘 409 EMAIL_TAKEN；改档案邮箱后重聘成功，登录名 = 新邮箱', async () => {
    const db = database().db;
    const x = await importWorld(db, '22-2');
    const d = await x.dept('重聘冲突部门');
    const taken = `syn.c.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const batchId = await x.imported([x.row(1, d.code, { email: taken })]);
    const [row] = await x.rowsOfBatch(batchId);
    expect(row!.status).toBe('created_with_error');

    const blocked = await rehire(x, row!.employee_id!, d.id);
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect((await x.errorOf(blocked)).details?.reason).toBe('EMAIL_TAKEN');

    const fresh = `syn.fresh.${uniqueSuffix()}@example.com`;
    await x.q(sql`INSERT INTO personnel_employee_versions(tenant_id, employee_id, revision, command_id,
        created_by, name, email)
      SELECT e.tenant_id, e.id, COALESCE(max(v.revision), 0) + 1, 'f493-s3b-fixture', ${x.session.user.id}::uuid,
        e.name, ${fresh}
      FROM employment_employees e
      LEFT JOIN personnel_employee_versions v ON v.tenant_id = e.tenant_id AND v.employee_id = e.id
      WHERE e.tenant_id = ${x.tenantId} AND e.id = ${row!.employee_id}::uuid
      GROUP BY e.tenant_id, e.id, e.name`);
    const done = await rehire(x, row!.employee_id!, d.id);
    expect(done.status, await done.clone().text()).toBe(201);
    await drainExitAccounts(db, x.tenantId, NOW);
    expect(await accountOf(x, row!.employee_id!)).toMatchObject({ status: 'active', email: fresh });
    expect(await accountsOf(x.tenantId)).toHaveLength(1);
  });
});
