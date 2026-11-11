/**
 * AC-DM-30-F493 审计与租约（S3a 返工第 1 轮，设计 §6.1、§6.2、§10.3）：
 * 提交审计的精确结构、账号任务审计（成功 / b 类 / 事务失败回滚）、收尾操作日志的逐条错误报告与归属、成功行续租。
 * 真 DB + HTTP；读写租户数据一律走 withTenant（app_owner 普通角色可过，DEC-568）。
 */
import './support/exit-gate-enforced.js';
import { createUser, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  drainExitImports,
  installExitImportTestHooks,
} from '../../apps/api/src/modules/employment/exit-import-worker.js';
import { importWorld, type ImportWorld } from './AC-DM-30-support.js';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
afterEach(() => installExitImportTestHooks(database().db, {}));

const TASK_ACTION = 'employment.exit_account.task';

const auditsOf = (x: ImportWorld, action: string) =>
  x.q<{
    object_id: string;
    operation: string;
    before: unknown;
    after: Record<string, unknown> | null;
    scope_employee_id: string | null;
  }>(sql`SELECT object_id, operation, before, after, scope_employee_id::text FROM audit_events
    WHERE tenant_id=${x.tenantId} AND action=${action} ORDER BY occurred_at, id`);

const logOf = async (x: ImportWorld, batchId: string) => {
  const logs = await x.q<{
    success_count: number;
    failure_count: number;
    total_count: number;
    error_report: { rowIndex: number; errorCode: string; reason: string }[] | null;
    items: {
      rowIndex: number;
      outcome: string;
      objectId: string | null;
      employeeId: string | null;
      orgId: string | null;
    }[];
  }>(sql`SELECT success_count, failure_count, total_count, error_report, items FROM audit_operation_logs
    WHERE tenant_id=${x.tenantId} AND object_type='exit-import' AND object_id::text=${batchId}`);
  expect(logs).toHaveLength(1);
  return logs[0]!;
};

describe('AC-DM-30-F493-09 提交审计快照（设计 §6.1、§10.3）', () => {
  it('after 恰为 { total, prefailed }：prefailed = 提交时就失败的行数（形状错 + c 类），不含文件名', async () => {
    const x = await importWorld(database().db, '09-audit');
    const d = await x.dept('提交审计部门');
    const dup = `syn.dup.${uniqueSuffix()}@example.com`;
    const response = await x.submit([
      x.row(1, d.code),
      x.row(2, d.code, { email: dup }),
      x.row(3, d.code, { email: dup.toUpperCase() }),
      x.row(4, d.code, { name: null }),
    ]);
    expect(response.status, await response.clone().text()).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await x.settle();
    const [event, ...others] = await auditsOf(x, 'employment.exit_import.submitted');
    expect(others).toEqual([]);
    expect(event).toMatchObject({ object_id: batchId, before: null });
    expect(event!.after).toStrictEqual({ total: 4, prefailed: 3 });
  });

  it('没有预失败行时 prefailed 为 0（键仍在）', async () => {
    const x = await importWorld(database().db, '09-audit-0');
    const d = await x.dept('提交审计无预失败部门');
    await x.imported([x.row(1, d.code), x.row(2, d.code)]);
    const [event] = await auditsOf(x, 'employment.exit_import.submitted');
    expect(event!.after).toStrictEqual({ total: 2, prefailed: 0 });
  });
});

describe('AC-DM-30-F493-31 账号任务审计（设计 §10.3）', () => {
  const taskOf = (x: ImportWorld, businessId: string) =>
    x.q<{ user_id: string; employee_id: string; status: string }>(sql`SELECT user_id::text, employee_id::text, status
      FROM exit_account_tasks WHERE tenant_id=${x.tenantId} AND business_id=${businessId}::uuid`);

  it('成功行：同事务写一条 employment.exit_account.task（before 空、after 为任务完整快照、归属该员工）', async () => {
    const x = await importWorld(database().db, '31-task-audit');
    const d = await x.dept('任务审计部门');
    const [row] = await x.rowsOfBatch(await x.imported([x.row(1, d.code)]));
    expect(row!.status).toBe('succeeded');
    const [task] = await taskOf(x, row!.exit_business_id!);
    const events = await auditsOf(x, TASK_ACTION);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      object_id: row!.exit_business_id,
      operation: 'create',
      before: null,
      scope_employee_id: row!.employee_id,
    });
    expect(events[0]!.after).toMatchObject({
      tenantId: x.tenantId,
      businessId: row!.exit_business_id,
      employeeId: row!.employee_id,
      userId: task!.user_id,
      status: 'disabled',
      autoRevision: 1,
    });
  });

  it('b 类行（登录名被占用）同样写任务审计', async () => {
    const db = database().db;
    const x = await importWorld(db, '31-task-audit-b');
    const d = await x.dept('任务审计b类部门');
    const taken = `syn.taken.${uniqueSuffix()}@example.com`;
    await seedTenantWithMember(db, 'task-audit-other');
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const [row] = await x.rowsOfBatch(await x.imported([x.row(1, d.code, { email: taken })]));
    expect(row!.status).toBe('created_with_error');
    const events = await auditsOf(x, TASK_ACTION);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ object_id: row!.exit_business_id, before: null });
    expect(events[0]!.after).toMatchObject({ businessId: row!.exit_business_id, status: 'disabled' });
  });

  it('本行事务在任务写入之后失败：任务与任务审计一起回滚（行保持 pending，批次 running）', async () => {
    const db = database().db;
    const x = await importWorld(db, '31-task-rollback');
    const d = await x.dept('任务审计回滚部门');
    // 任务写入之后的下一条审计（employment.exit.imported）不可写 → 整行回滚
    await db.execute(sql`CREATE FUNCTION f493_reject_imported_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE = '53100'; END $$`);
    await db.execute(sql`CREATE TRIGGER f493_reject_imported_audit BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'employment.exit.imported') EXECUTE FUNCTION f493_reject_imported_audit()`);
    try {
      const response = await x.submit([x.row(1, d.code)]);
      expect(response.status).toBe(202);
      const { batchId } = (await response.json()) as { batchId: string };
      await x.settle();
      expect((await x.rowsOfBatch(batchId))[0]).toMatchObject({ status: 'pending', employee_id: null });
      expect(await x.batchOf(batchId)).toMatchObject({ status: 'running' });
    } finally {
      await db.execute(sql`DROP TRIGGER f493_reject_imported_audit ON audit_events`);
      await db.execute(sql`DROP FUNCTION f493_reject_imported_audit()`);
    }
    expect(await auditsOf(x, TASK_ACTION)).toEqual([]);
    expect(await x.employeeCount()).toBe(0);
    const [tasks] = await x.q<{ n: string }>(sql`SELECT count(*) AS n FROM exit_account_tasks
      WHERE tenant_id=${x.tenantId}`);
    expect(Number(tasks!.n)).toBe(0);
  });
});

describe('AC-DM-30-F493-40 收尾操作日志（设计 §10.3 映射）', () => {
  it('每个 errors 元素一条 errorReport（带 reason）；items 带 orgId，失败行仅在部门解析到时带', async () => {
    const db = database().db;
    const x = await importWorld(db, '40-log');
    const d = await x.dept('收尾日志部门');
    const taken = `syn.taken.${uniqueSuffix()}@example.com`;
    await seedTenantWithMember(db, 'log-other');
    await createUser(db, { email: taken, displayName: '合成他租户账号' }, cmd());
    const batchId = await x.imported([
      x.row(1, d.code),
      x.row(2, 'NOPE-CODE'),
      x.row(3, d.code, { gender: 'abc', nation: 'abc', politicalStatus: 'abc' }),
      x.row(4, d.code, { email: taken }),
    ]);
    const rows = await x.rowsOfBatch(batchId);
    expect(rows.map((r) => r.status)).toEqual(['succeeded', 'failed', 'failed', 'created_with_error']);
    const log = await logOf(x, batchId);
    expect(log).toMatchObject({ success_count: 1, failure_count: 3, total_count: 4 });
    expect(log.error_report).toEqual([
      { rowIndex: 1, errorCode: 'EXIT_IMPORT_ROW_FAILED', reason: 'REFERENCE_NOT_FOUND' },
      { rowIndex: 2, errorCode: 'EXIT_IMPORT_ROW_FAILED', reason: 'OPTION_NOT_FOUND' },
      { rowIndex: 2, errorCode: 'EXIT_IMPORT_ROW_FAILED', reason: 'OPTION_NOT_FOUND' },
      { rowIndex: 2, errorCode: 'EXIT_IMPORT_ROW_FAILED', reason: 'OPTION_NOT_FOUND' },
      { rowIndex: 3, errorCode: 'EXIT_IMPORT_CREATED_WITH_ERROR', reason: 'LOGIN_TAKEN' },
    ]);
    expect(await x.batchOf(batchId)).toMatchObject({ error_row_count: 3, error_count: 5 });
    expect(log.items).toEqual([
      {
        rowIndex: 0,
        outcome: 'succeeded',
        objectId: rows[0]!.exit_business_id,
        employeeId: rows[0]!.employee_id,
        orgId: d.id,
      },
      { rowIndex: 1, outcome: 'failed', objectId: null, employeeId: null, orgId: null },
      { rowIndex: 2, outcome: 'failed', objectId: null, employeeId: null, orgId: d.id },
      {
        rowIndex: 3,
        outcome: 'failed',
        objectId: rows[3]!.exit_business_id,
        employeeId: rows[3]!.employee_id,
        orgId: d.id,
      },
    ]);
  });
});

describe('AC-DM-30-F493-20 成功行续租（设计 §6.2 第 5 步）', () => {
  it('租约剩 1 秒时处理第 1 行，第 2 行前租约本应过期：第二个执行者认领不到，attempts 不变', async () => {
    const db = database().db;
    const x = await importWorld(db, '20-lease');
    const d = await x.dept('续租部门');
    let second: { batches: number } | undefined;
    installExitImportTestHooks(db, {
      beforeRow: async (rowNo) => {
        if (rowNo === 1)
          await x.q(sql`UPDATE exit_import_batches SET lease_until = now() + interval '1 second'
            WHERE tenant_id=${x.tenantId} AND status='running'`);
        if (rowNo === 2 && !second) {
          await new Promise((resolve) => setTimeout(resolve, 1500)); // 第 1 行成功后越过原租约
          second = { batches: -1 }; // 占位：嵌套的 beforeRow(2) 不再重入
          second = await drainExitImports(db, x.tenantId);
        }
      },
    });
    const response = await x.submit([x.row(1, d.code), x.row(2, d.code)]);
    expect(response.status).toBe(202);
    const { batchId } = (await response.json()) as { batchId: string };
    await x.settle();
    expect(second).toEqual({ batches: 0 });
    expect(await x.batchOf(batchId)).toMatchObject({ status: 'completed', attempts: 1, created_count: 2 });
    expect(await x.employeeCount()).toBe(2);
  });
});
