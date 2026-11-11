/**
 * AC-DM-30-F493-10①/11/16③：历史离职导入的恢复、重试上限与执行期权限复核（S3b，设计 §6.2、§6.3、§8.3、§16 A9）。
 * 租约过期的批次由下一次领取接管，只续跑 pending 行；系统故障连续 5 次后批次 failed，剩余 pending 行各记一条
 * SYSTEM_ERROR；提交者在提交后、执行前被撤销成员资格，则剩余 pending 行全部 SUBMITTER_FORBIDDEN、零写入。
 * 读写租户数据一律走 withTenant（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { createUser } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drainExitImports,
  installExitImportTestHooks,
} from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { cmd } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));

const expireLease = (x: ImportWorld) =>
  x.q(x.sql`UPDATE exit_import_batches SET lease_until = now() - interval '1 second'
    WHERE tenant_id=${x.tenantId} AND status='running'`);

const leaseOf = (x: ImportWorld, batchId: string) =>
  x
    .q<{ lease_until: string | null; seconds: number | null; finished_at: string | null; expires_at: string | null }>(
      x.sql`SELECT lease_until, extract(epoch FROM (lease_until - now()))::float AS seconds, finished_at, expires_at
      FROM exit_import_batches WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`,
    )
    .then((rows) => rows[0]!);

/** 提交后由执行器处理：failRow 让指定行抛非业务错误，使批次停在 running。 */
async function submitFailingAt(x: ImportWorld, rows: readonly unknown[], failAt: number) {
  const db = database().db;
  installExitImportTestHooks(db, {
    failRow: (rowNo) => (rowNo === failAt ? new Error('合成系统故障') : undefined),
  });
  const response = await x.submit(rows);
  expect(response.status, await response.clone().text()).toBe(202);
  const { batchId } = (await response.json()) as { batchId: string };
  await x.settle();
  return batchId;
}

describe('AC-DM-30-F493-10① 租约过期的接管只续跑 pending 行', () => {
  it('第 1、2 行已处理（succeeded / created_with_error），第 3 行 pending：接管后人员只 +1，attempts+1，批次 completed', async () => {
    const db = database().db;
    const x = await importWorld(db, '10-1');
    const d = await x.dept('接管部门');
    const taken = `syn.c.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const batchId = await submitFailingAt(
      x,
      [x.row(1, d.code), x.row(2, d.code, { email: taken }), x.row(3, d.code)],
      3,
    );
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'running', attempts: 1, last_error: expect.any(String) });
    const before = await x.rowsOfBatch(batchId);
    expect(before.map((r) => r.status)).toEqual(['succeeded', 'created_with_error', 'pending']);
    const headcount = await x.employeeCount();
    expect(headcount).toBe(2);

    installExitImportTestHooks(db, {});
    await expireLease(x);
    expect(await drainExitImports(db, x.tenantId)).toEqual({ batches: 1 });

    expect(await x.employeeCount()).toBe(headcount + 1);
    expect(await x.batchOf(batchId)).toMatchObject({
      status: 'completed',
      attempts: 2,
      created_count: 3,
      error_row_count: 1,
      error_count: 1,
      last_error: null,
    });
    const after = await x.rowsOfBatch(batchId);
    expect(after.map((r) => r.status)).toEqual(['succeeded', 'created_with_error', 'succeeded']);
    // 已处理行的人员与业务不被重写
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
  });
});

describe('AC-DM-30-F493-11 系统故障：重试与连续 5 次后的终态', () => {
  it('故障行留 pending 并记 last_error、租约缩到约 1 分钟；连续 5 次后批次 failed，剩余行各一条 SYSTEM_ERROR', async () => {
    const db = database().db;
    const x = await importWorld(db, '11');
    const d = await x.dept('重试部门');
    const batchId = await submitFailingAt(
      x,
      [1, 2, 3].map((n) => x.row(n, d.code)),
      2,
    );

    expect(await x.batchOf(batchId)).toMatchObject({ status: 'running', attempts: 1 });
    const first = await x.batchOf(batchId);
    expect(first.last_error).toBeTruthy();
    const lease = await leaseOf(x, batchId);
    expect(lease.seconds).toBeGreaterThan(30);
    expect(lease.seconds).toBeLessThanOrEqual(60);
    expect((await x.rowsOfBatch(batchId)).map((r) => r.status)).toEqual(['succeeded', 'pending', 'pending']);

    for (const attempt of [2, 3, 4]) {
      await expireLease(x);
      await expect(drainExitImports(db, x.tenantId)).rejects.toThrow();
      expect(await x.batchOf(batchId)).toMatchObject({ status: 'running', attempts: attempt });
      expect((await x.rowsOfBatch(batchId))[1]).toMatchObject({ status: 'pending', errors: [] });
    }

    await expireLease(x);
    await drainExitImports(db, x.tenantId).catch(() => undefined); // 第 5 次：终态
    expect(await x.batchOf(batchId)).toMatchObject({
      status: 'failed',
      attempts: 5,
      created_count: 1,
      error_row_count: 2,
      error_count: 2,
      last_error: expect.any(String),
    });
    const done = await leaseOf(x, batchId);
    expect(done.finished_at).not.toBeNull();
    expect(done.expires_at).not.toBeNull();
    expect(done.lease_until).toBeNull();
    expect(await x.rowsOfBatch(batchId)).toMatchObject([
      { status: 'succeeded', errors: [] },
      { status: 'failed', errors: [{ column: null, reason: 'SYSTEM_ERROR' }] },
      { status: 'failed', errors: [{ column: null, reason: 'SYSTEM_ERROR' }] },
    ]);
    expect(await x.employeeCount()).toBe(1);
    // failed 是终态：再没有可领的批次
    await expireLease(x);
    expect(await drainExitImports(db, x.tenantId)).toEqual({ batches: 0 });
  });
});

describe('AC-DM-30-F493-11 第 5 次最后一行已提交、收尾前崩溃', () => {
  it('第 6 次认领时已无 pending 行：直接收尾为 completed（last_error 为 NULL、计数正确），不记 ATTEMPTS_EXCEEDED', async () => {
    const db = database().db;
    const x = await importWorld(db, '11-last');
    const d = await x.dept('收尾崩溃部门');
    const taken = `syn.c.${uniqueSuffix()}@example.com`;
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const response = await x.submit([x.row(1, d.code), x.row(2, d.code, { email: taken }), x.row(3, d.code)]);
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await x.settle();
    const rows = await x.rowsOfBatch(batchId);
    expect(rows.map((r) => r.status)).toEqual(['succeeded', 'created_with_error', 'succeeded']);
    // 还原成“第 5 次执行已提交最后一行、收尾事务没提交就退出”的状态：running、无 pending 行、尝试次数 5、租约已过期
    await x.q(x.sql`UPDATE exit_import_batches SET status='running', attempts=5, last_error=NULL, finished_at=NULL,
      expires_at=NULL, created_count=0, error_row_count=0, error_count=0, lease_until=now() - interval '1 second'
      WHERE tenant_id=${x.tenantId} AND id=${batchId}::uuid`);
    const headcount = await x.employeeCount();

    expect(await drainExitImports(db, x.tenantId)).toEqual({ batches: 1 }); // 第 6 次认领

    expect(await x.batchOf(batchId)).toMatchObject({
      status: 'completed',
      attempts: 6,
      created_count: 3,
      error_row_count: 1,
      error_count: 1,
      last_error: null,
    });
    expect(await x.rowsOfBatch(batchId)).toEqual(rows); // 行不被改写
    expect(await x.employeeCount()).toBe(headcount);
  });
});

describe('AC-DM-30-F493-16③ 提交后、执行前撤销提交者的成员资格', () => {
  it('剩余 pending 行全部 SUBMITTER_FORBIDDEN，批次 completed，不写任何人员', async () => {
    const db = database().db;
    const x = await importWorld(db, '16-3');
    const d = await x.dept('撤成员部门');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    installExitImportTestHooks(db, { beforeBatch: () => gate });
    const response = await x.submit([1, 2, 3].map((n) => x.row(n, d.code)));
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };

    await x.q(x.sql`UPDATE tenant_memberships SET status='revoked'
      WHERE tenant_id=${x.tenantId} AND user_id=${x.session.user.id}::uuid`);
    release();
    await x.settle();

    expect(await x.rowsOfBatch(batchId)).toMatchObject(
      [1, 2, 3].map(() => ({
        status: 'failed',
        errors: [{ column: null, reason: 'SUBMITTER_FORBIDDEN' }],
        employee_id: null,
        exit_business_id: null,
      })),
    );
    expect(await x.batchOf(batchId)).toMatchObject({
      status: 'completed',
      created_count: 0,
      error_row_count: 3,
      error_count: 3,
    });
    expect(await x.employeeCount()).toBe(0);
  });
});
