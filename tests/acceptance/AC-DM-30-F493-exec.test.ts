/**
 * AC-DM-30-F493-04/07/18/20/27②/29/30/31：历史离职导入的执行侧（S3a，设计 §3.3、§4.2～§4.5、§6.3）。
 * 提交 → 执行器逐行写入（人员 + 档案 + 入职 + 离职 + 停用账号 + 绑定 + 账号任务）→ 批次汇总。
 * 真 DB + HTTP；读写租户数据一律走 withTenant（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { createUser, sql, withPlatform, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { drainExitImports } from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { E, H, L, TODAY as TODAY_ISO, importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { readUsers, rowsOf } from './AC-F493-s2-support.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const VIRTUAL = /^va-[0-9a-f]{32}@virtualaccount\.invalid$/;

const accountsOf = (tenantId: string, db = database().db) =>
  withTenant(db, tenantId, async (tx) =>
    rowsOf<{ user_id: string; employee_id: string }>(
      await tx.execute(sql`SELECT user_id::text, employee_id::text FROM permission_user_person_links
        WHERE tenant_id=${tenantId}`),
    ),
  );

describe('AC-DM-30-F493-07 部分成功', () => {
  it('合法行入职 + 离职两条且人员状态码 8；D 列编码不存在的行 REFERENCE_NOT_FOUND，无任何写入', async () => {
    const x = await importWorld(database().db, '07');
    const d = await x.dept('部分成功部门');
    const batchId = await x.imported([x.row(1, d.code), x.row(2, 'NOPE-CODE')]);
    const [ok, bad] = await x.rowsOfBatch(batchId);
    expect(ok).toMatchObject({ status: 'succeeded', errors: [] });
    expect(bad).toMatchObject({
      status: 'failed',
      errors: [{ column: 'D', reason: 'REFERENCE_NOT_FOUND' }],
      employee_id: null,
    });
    const businesses = await x.businessesOf(ok!.employee_id!);
    expect(businesses.map((b) => [b.kind, b.effectiveDate, b.state])).toEqual([
      ['hire', H, 'effective'],
      ['leave', E, 'effective'],
    ]);
    const [status] = await x.q<{ status: number }>(x.sql`SELECT employee_status AS status FROM employment_records
      WHERE tenant_id=${x.tenantId} AND employee_id=${ok!.employee_id}::uuid ORDER BY start_date DESC LIMIT 1`);
    expect(status?.status).toBe(8);
    expect(await x.statesOf(ok!.exit_business_id!)).toEqual(['approved', 'effective']);
    expect(await x.exitRowOf(ok!.exit_business_id!)).toMatchObject({
      mode: 'import',
      initiator: 'hr',
      preReleaseDate: E,
    });
    expect(await x.employeeCount()).toBe(1);
    expect(await accountsOf(x.tenantId)).toHaveLength(1);
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 1, error_row_count: 1, error_count: 1 });
  });
});

describe('AC-DM-30-F493-04 停用账号与虚拟登录名', () => {
  it('账号 disabled、登录名为虚拟格式、成员 active/internal、绑定与停用任务齐全、无授权、不能登录', async () => {
    const db = database().db;
    const x = await importWorld(db, '04');
    const d = await x.dept('账号部门');
    const batchId = await x.imported([x.row(1, d.code)]);
    const [row] = await x.rowsOfBatch(batchId);
    expect(row!.status).toBe('succeeded');
    const [link] = await accountsOf(x.tenantId);
    expect(link!.employee_id).toBe(row!.employee_id);
    const [account] = await readUsers(db, [link!.user_id]);
    expect(account).toMatchObject({ status: 'disabled' });
    expect(account!.email).toMatch(VIRTUAL);
    expect(account!.email).toBe(`va-${account!.id.replaceAll('-', '')}@virtualaccount.invalid`);
    const [member] = await x.q<{ status: string; user_type: string }>(
      x.sql`SELECT status, user_type FROM tenant_memberships WHERE tenant_id=${x.tenantId}
        AND user_id=${link!.user_id}::uuid`,
    );
    expect(member).toMatchObject({ status: 'active', user_type: 'internal' });
    const [task] = await x.q<{ status: string; auto_revision: number; user_id: string }>(
      x.sql`SELECT status, auto_revision, user_id::text FROM exit_account_tasks WHERE tenant_id=${x.tenantId}
        AND business_id=${row!.exit_business_id}::uuid`,
    );
    expect(task).toMatchObject({ status: 'disabled', auto_revision: account!.revision, user_id: link!.user_id });
    const grants = await x.q(x.sql`SELECT 1 FROM permission_grants WHERE tenant_id=${x.tenantId}
      AND user_id=${link!.user_id}::uuid`);
    expect(grants).toHaveLength(0);
    const login = await tenantApi(db, { authorize: undefined }).request('GET', '/api/tenant/employment/exits', {
      user: link!.user_id,
      tenant: x.tenantId,
    });
    expect(login.status).toBe(401);
    expect(((await login.json()) as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    const audits = await withPlatform(db, async (tx) =>
      rowsOf<{ after: Record<string, unknown> }>(
        await tx.execute(sql`SELECT after FROM platform_audit_events WHERE action='user.create'
          AND object_id=${link!.user_id}`),
      ),
    );
    expect(audits[0]!.after).toMatchObject({ status: 'disabled', loginAssigned: true });
  });
});

describe('AC-DM-30-F493-29 虚拟登录名唯一 + 27② 工号为空', () => {
  it('同批 50 行全部成功：登录名互不相同且各自等于账号 ID 推出的值；人员 code 与任职 jobNumber 都为 NULL', async () => {
    const db = database().db;
    const x = await importWorld(db, '29');
    const d = await x.dept('唯一部门');
    const batchId = await x.imported(Array.from({ length: 50 }, (_, i) => x.row(i + 1, d.code)));
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', created_count: 50, error_count: 0 });
    const accounts = await readUsers(
      db,
      (await accountsOf(x.tenantId)).map((l) => l.user_id),
    );
    expect(new Set(accounts.map((a) => a.email)).size).toBe(50);
    for (const a of accounts) expect(a.email).toBe(`va-${a.id.replaceAll('-', '')}@virtualaccount.invalid`);
    const [nulls] = await x.q<{ codes: string; jobs: string }>(x.sql`SELECT
      (SELECT count(*) FROM employment_employees WHERE tenant_id=${x.tenantId} AND code IS NULL) AS codes,
      (SELECT count(*) FROM employment_records WHERE tenant_id=${x.tenantId} AND job_number IS NULL) AS jobs`);
    expect(Number(nulls!.codes)).toBe(50);
    expect(Number(nulls!.jobs)).toBeGreaterThanOrEqual(100);
  }, 120_000);
});

describe('AC-DM-30-F493-30 a 类拦截覆盖全部未删除人员', () => {
  it('在职 / 离职 / 待入职档案邮箱都拦（大小写与空白归一）；个人邮箱 backupMail 不参与', async () => {
    const db = database().db;
    const x = await importWorld(db, '30');
    const d = await x.dept('a类部门');
    const seeded = await x.imported([
      x.row(1, d.code, { email: 'syn.a1@example.com' }),
      x.row(2, d.code, { email: 'syn.a2@example.com' }),
      x.row(3, d.code, { email: 'syn.a3@example.com' }),
      x.row(4, d.code, { email: 'syn.keep@example.com', personalEmail: 'syn.b@example.com' }),
    ]);
    expect((await x.rowsOfBatch(seeded)).map((r) => r.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    const before = await x.employeeCount();
    const second = await x.imported([
      x.row(1, d.code, { email: ' Syn.A1@Example.com ' }),
      x.row(2, d.code, { email: 'syn.a2@example.com' }),
      x.row(3, d.code, { email: 'syn.a3@example.com' }),
      x.row(4, d.code, { email: 'syn.b@example.com' }),
    ]);
    const rows = await x.rowsOfBatch(second);
    expect(rows.slice(0, 3).map((r) => [r.status, r.errors])).toEqual(
      Array(3).fill(['failed', [{ column: 'C', reason: 'EMAIL_IN_EMPLOYEE' }]]),
    );
    expect(rows[3]!.status).toBe('succeeded');
    expect(await x.employeeCount()).toBe(before + 1);
  });
});

describe('AC-DM-30-F493-31 b 类报错但照建', () => {
  it('他租户账号占用登录名：行 created_with_error / LOGIN_TAKEN，其余照建；对方账号不变；再导一次 → EMAIL_IN_EMPLOYEE', async () => {
    const db = database().db;
    const x = await importWorld(db, '31');
    const d = await x.dept('b类部门');
    const taken = `syn.c.${uniqueSuffix()}@example.com`;
    const other = await seedTenantWithMember(db, 'b-other');
    const owner = await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const [snapshot] = await readUsers(db, [owner.id]);
    const batchId = await x.imported([x.row(1, d.code, { email: taken })]);
    const [row] = await x.rowsOfBatch(batchId);
    expect(row).toMatchObject({ status: 'created_with_error', errors: [{ column: 'C', reason: 'LOGIN_TAKEN' }] });
    expect(row!.employee_id && row!.exit_business_id).toBeTruthy();
    expect(await x.statesOf(row!.exit_business_id!)).toEqual(['approved', 'effective']);
    expect(await x.profileOf(row!.employee_id!)).toMatchObject({ email: taken });
    const [link] = await accountsOf(x.tenantId);
    const [account] = await readUsers(db, [link!.user_id]);
    expect(account).toMatchObject({ status: 'disabled', email: null });
    expect((await readUsers(db, [owner.id]))[0]).toEqual(snapshot);
    const [task] = await x.q<{ status: string }>(
      x.sql`SELECT status FROM exit_account_tasks WHERE tenant_id=${x.tenantId}
        AND business_id=${row!.exit_business_id}::uuid`,
    );
    expect(task!.status).toBe('disabled');
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 1, error_row_count: 1, error_count: 1 });
    const hits = await withPlatform(db, async (tx) =>
      rowsOf<{ id: string }>(await tx.execute(sql`SELECT id::text FROM users WHERE lower(email)=${taken}`)),
    );
    expect(hits.map((h) => h.id)).toEqual([owner.id]);
    const again = await x.imported([x.row(1, d.code, { email: taken })]);
    expect((await x.rowsOfBatch(again))[0]).toMatchObject({
      status: 'failed',
      errors: [{ column: 'C', reason: 'EMAIL_IN_EMPLOYEE' }],
    });
    expect(await x.employeeCount()).toBe(1);
    expect(other.tenant.id).not.toBe(x.tenantId);
  });
});

describe('AC-DM-30-F493-20 租户隔离', () => {
  it('drainExitImports(B) 不处理 A 的批次；B 有同邮箱人员时 A 照常成功；账号与成员只在 A', async () => {
    const db = database().db;
    const a = await importWorld(db, '20a');
    const b = await importWorld(db, '20b');
    const da = await a.dept('A部门');
    const db2 = await b.dept('B部门');
    const mail = `syn.shared.${uniqueSuffix()}@example.com`;
    await b.imported([b.row(1, db2.code, { email: mail })]);
    const response = await a.submit([a.row(1, da.code, { email: mail })]);
    expect(response.status).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await a.settle();
    expect((await a.rowsOfBatch(batchId))[0]!.status).toBe('succeeded');
    expect(await drainExitImports(db, b.tenantId)).toBeDefined();
    expect(await a.batchOf(batchId)).toMatchObject({ status: 'completed', attempts: 1 });
    const bLinks = await accountsOf(b.tenantId);
    const aLinks = await accountsOf(a.tenantId);
    expect(bLinks).toHaveLength(1);
    expect(aLinks).toHaveLength(1);
    expect(aLinks[0]!.user_id).not.toBe(bLinks[0]!.user_id);
  });
});

/** 在 [from, ∞) 加一个启用版本（停用版本之后的重新启用）。 */
async function enableFrom(x: ImportWorld, orgId: string, from: string) {
  await withTenant(x.db, x.tenantId, async (tx) => {
    const id = randomUUID();
    await tx.execute(sql`INSERT INTO org_versions (id, tenant_id, org_id, version_no, previous_version_id, start_date,
        stop_date, enabled, code, name, short_name, broad_type, established_on, full_name, level)
      SELECT ${id}::uuid, tenant_id, org_id, version_no + 1, id, ${from}::date, stop_date, true,
        code, name, short_name, broad_type, established_on, full_name, level
      FROM org_versions WHERE tenant_id=${x.tenantId} AND org_id=${orgId}::uuid
      ORDER BY start_date DESC, version_no DESC LIMIT 1`);
    await tx.execute(sql`INSERT INTO org_hierarchy_links (tenant_id, version_id, dimension, parent_org_id, sequence)
      SELECT l.tenant_id, ${id}::uuid, l.dimension, l.parent_org_id, l.sequence FROM org_hierarchy_links l
      WHERE l.tenant_id=${x.tenantId}
        AND l.version_id=(SELECT previous_version_id FROM org_versions WHERE id=${id}::uuid)`);
    await tx.execute(sql`UPDATE org_objects SET revision = revision + 1 WHERE tenant_id=${x.tenantId}
      AND id=${orgId}::uuid`);
  });
}

describe('AC-DM-30-F493-18 已停用部门放行与撤销被拦（U3，DEC-839③）', () => {
  const importOne = async (x: ImportWorld, deptCode: string) => {
    const [row] = await x.rowsOfBatch(await x.imported([x.row(1, deptCode)]));
    return row!;
  };

  it.each([
    ['① 停用在 [H, L] 内且此后一直停用', '2024-06-01', 1],
    ['② H 之前就已停用', '2022-06-01', 2],
    ['③ L+1 之后才停用', '2025-08-01', 3],
  ])('%s：本行 succeeded，入职 + 离职两条', async (name, disabledOn, no) => {
    const x = await importWorld(database().db, `18-${no}`);
    const d = await x.dept(`停用部门${name}`);
    await x.disable(d.id, disabledOn);
    const row = await importOne(x, d.code);
    expect(row.status, JSON.stringify(row.errors)).toBe('succeeded');
    expect(await x.businessesOf(row.employee_id!)).toHaveLength(2);
  });

  it('④ H 早于部门设立日：failed，DEPARTMENT_NOT_FOUNDED（column E）', async () => {
    const x = await importWorld(database().db, '18-4');
    const d = await x.dept('晚设立部门', { establishedOn: '2024-01-01' });
    const row = await importOne(x, d.code);
    expect(row).toMatchObject({ status: 'failed', errors: [{ column: 'E', reason: 'DEPARTMENT_NOT_FOUNDED' }] });
  });

  it('⑤ 撤销 409 EMPLOYMENT_DEPARTMENT_DISABLED，状态不变；今天才生效的启用版本仍 409；L+1 起连续启用后撤销成功', async () => {
    const x = await importWorld(database().db, '18-5');
    const d = await x.dept('撤销拦截部门');
    await x.disable(d.id, '2024-06-01');
    const row = await importOne(x, d.code);
    const cancel = async () => {
      const detail = await x.session.request('GET', `/exits/${row.exit_business_id}`);
      const { revision } = (await detail.json()) as { revision: number };
      return x.session.request('POST', `/exits/${row.exit_business_id}/cancel`, {
        ifMatch: revision,
        body: { reason: '合成撤销', confirmed: true },
      });
    };
    const audits = await x.auditCount('employment.exit.cancelled');
    const blocked = await cancel();
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    expect((await x.errorOf(blocked)).details?.reason).toBe('EMPLOYMENT_DEPARTMENT_DISABLED');
    expect(await x.statesOf(row.exit_business_id!)).toEqual(['approved', 'effective']);
    expect(await x.businessesOf(row.employee_id!)).toHaveLength(2);
    expect(await x.auditCount('employment.exit.cancelled')).toBe(audits);
    await enableFrom(x, d.id, '2026-11-05');
    expect((await cancel()).status).toBe(409);
    await enableFrom(x, d.id, E);
    const done = await cancel();
    expect(done.status, await done.clone().text()).toBe(200);
  });

  it('⑥ 停用后在 L+1 之前已重新启用：导入成功，撤销直接成功', async () => {
    const x = await importWorld(database().db, '18-6');
    const d = await x.dept('重新启用部门');
    await x.disable(d.id, '2024-06-01');
    await enableFrom(x, d.id, '2024-09-01');
    const row = await importOne(x, d.code);
    expect(row.status).toBe('succeeded');
    const detail = await x.session.request('GET', `/exits/${row.exit_business_id}`);
    const { revision } = (await detail.json()) as { revision: number };
    const done = await x.session.request('POST', `/exits/${row.exit_business_id}/cancel`, {
      ifMatch: revision,
      body: { reason: '合成撤销', confirmed: true },
    });
    expect(done.status, await done.clone().text()).toBe(200);
  });

  it('⑦ 同一部门下非导入入口（通用入职）在停用期内仍被拒', async () => {
    const x = await importWorld(database().db, '18-7');
    const d = await x.dept('回归部门');
    await x.disable(d.id, '2024-06-01');
    const employee = await x.session.employee('通用入职对照');
    const generic = await x.session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: employee.revision,
      body: { kind: 'hire', mode: 'direct', effectiveDate: H, fields: { departmentId: d.id } },
    });
    expect(generic.status).toBe(400);
    expect((await x.errorOf(generic)).details?.reason).toBe('EMPLOYMENT_DEPARTMENT_DISABLED');
    expect(L < E).toBe(true);
  });
});

describe('AC-DM-30-F493-07 不触发生效副作用', () => {
  it('onEffective 探针 0 次；无 exit_effects / 激活尝试；账号任务只有 disabled 一行', async () => {
    const x = await importWorld(database().db, '07-fx');
    const calls: string[] = [];
    exitPostEffectHooks.onEffective(async (_tx, _ctx, event) => void calls.push(event.businessId));
    const d = await x.dept('副作用部门');
    const batchId = await x.imported([x.row(1, d.code), x.row(2, d.code)]);
    expect(calls).toEqual([]);
    for (const item of await x.rowsOfBatch(batchId)) {
      const [counts] = await x.q<{ n: string; tasks: string }>(x.sql`SELECT
        (SELECT count(*) FROM exit_effects WHERE tenant_id=${x.tenantId} AND business_id=${item.exit_business_id}::uuid)
        + (SELECT count(*) FROM employment_activation_attempts WHERE tenant_id=${x.tenantId}
            AND business_id=${item.exit_business_id}::uuid) AS n,
        (SELECT count(*) FROM exit_account_tasks WHERE tenant_id=${x.tenantId}
          AND business_id=${item.exit_business_id}::uuid AND status<>'disabled') AS tasks`);
      expect([Number(counts!.n), Number(counts!.tasks)]).toEqual([0, 0]);
    }
  });
});

describe('AC-DM-30-F493-07 行内容错误收齐（设计 §3.3）', () => {
  it('必填缺失、格式、日期区间、非历史日期各行独立判定：每行带列字母与原因码，失败行零写入', async () => {
    const x = await importWorld(database().db, '07-rows');
    const d = await x.dept('行校验部门');
    const batchId = await x.imported([
      x.row(1, d.code, { name: '  ', email: null }),
      x.row(2, d.code, { email: 'not-an-email', entryDate: '2023-13-45' }),
      x.row(3, d.code, { lastWorkDate: '2022-12-31' }),
      x.row(4, d.code, { lastWorkDate: TODAY_ISO }),
      x.row(5, d.code, { departmentCode: null }),
      x.row(6, d.code),
    ]);
    const rows = await x.rowsOfBatch(batchId);
    const view = rows.map((r) => [r.status, r.errors.map((e) => `${e.column}:${e.reason}`)]);
    expect(view).toEqual([
      ['failed', ['B:REQUIRED', 'C:REQUIRED']],
      ['failed', ['C:INVALID_EMAIL', 'E:INVALID_DATE']],
      ['failed', ['V:RANGE_INVERTED']],
      ['failed', ['V:NOT_HISTORICAL']],
      ['failed', ['D:REQUIRED']],
      ['succeeded', []],
    ]);
    expect(await x.employeeCount()).toBe(1);
    expect(await x.batchOf(batchId)).toMatchObject({ created_count: 1, error_row_count: 5, error_count: 7 });
  });
});
