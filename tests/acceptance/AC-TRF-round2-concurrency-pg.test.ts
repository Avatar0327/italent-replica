/** PR #63 二审 P3-1：真实调动入口的 CAS / DEC-154 与员工 → 业务 → 实例取锁顺序（F-008）。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import type { EmploymentBusiness } from './AC-EMP-support.js';

const testDb = useTestDb();
const FORM = 'TenantBase.JobLevelTransferMultiFormView';
const DATE = '2026-10-01';
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

interface Waiter {
  readonly pid: number;
  readonly blockers: number[];
}

/** 以 pg_stat_activity 的实际员工锁等待为屏障，不按延时猜请求是否已进入事务。 */
async function employeeWaiters(db: Db, expected: number): Promise<Waiter[]> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const waiters = rowsOf<Waiter>(
      await db.execute(sql`
        SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
          AND query ILIKE '%employment_employees%' AND query ILIKE '%FOR UPDATE%'
        ORDER BY pid
      `),
    );
    if (waiters.length === expected) return waiters;
  }
  throw new Error(`等待 ${expected} 个调动请求阻塞于员工锁超时`);
}

async function queuedRequests(
  w: ActivationWorld,
  employeeId: string,
  first: () => Promise<Response>,
  second: () => Promise<Response>,
) {
  const requests: Promise<Response>[] = [];
  try {
    await withTenant(w.db, w.session.tenant.id, async (barrier) => {
      const [owner] = rowsOf<{ pid: number }>(await barrier.execute(sql`SELECT pg_backend_pid() AS pid`));
      const locked = await barrier.execute(sql`
        SELECT id FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${employeeId}::uuid FOR UPDATE
      `);
      expect(rowsOf(locked)).toHaveLength(1);
      requests.push(first());
      const [firstWaiter] = await employeeWaiters(w.db, 1);
      expect(firstWaiter!.blockers).toContain(owner!.pid);
      requests.push(second());
      const both = await employeeWaiters(w.db, 2);
      expect(both.map((waiter) => waiter.pid)).toContain(firstWaiter!.pid);
      // PostgreSQL 的第二位等待者可等待持锁事务，也可等待排在它前面的 tuple-lock 请求。
      const later = both.find((waiter) => waiter.pid !== firstWaiter!.pid)!;
      expect(later.blockers.some((pid) => pid === owner!.pid || pid === firstWaiter!.pid)).toBe(true);
    });
    return await Promise.all(requests);
  } finally {
    // 屏障断言失败也先释放事务，再收完请求，避免未结束的写入污染下一场景。
    await Promise.allSettled(requests);
  }
}

async function fixture(label: string) {
  const w = await activationWorld(testDb().db, label);
  // 这里只测并发，使用真实标准表单；本场景排除字段配置只读/隐藏，无须伪造职级职等引用。
  const configured = await w.session.request('PUT', `/transfers/forms/${FORM}`, {
    ifMatch: 0,
    body: {
      name: '并发验收职级调整表单',
      group: 'transfer',
      fieldModes: { 'preset:levelId': 'readonly', 'preset:gradeId': 'hidden' },
    },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);
  const hired = await w.hired('新调动入口并发验收员工');
  function request(
    mode: 'direct' | 'application',
    revision: number,
    commandId: string,
    fields: Record<string, unknown> = {},
  ) {
    return w.session.request('POST', `/transfers/employees/${hired.employee.id}`, {
      ifMatch: revision,
      idempotencyKey: commandId,
      body: {
        initiator: 'hr',
        transferTypeCode: 'job_level',
        formId: FORM,
        mode,
        effectiveDate: DATE,
        fields,
        submit: mode === 'application',
      },
    });
  }
  return { ...w, ...hired, request };
}

type World = Awaited<ReturnType<typeof fixture>>;

async function persisted(w: World) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const [counts] = rowsOf<{
      businesses: number;
      payloads: number;
      records: number;
      transfers: number;
      instances: number;
    }>(
      await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM employment_business_objects
            WHERE tenant_id=${w.session.tenant.id} AND employee_id=${w.employee.id}::uuid) AS businesses,
          (SELECT count(*)::int FROM employment_payload_versions
            WHERE tenant_id=${w.session.tenant.id} AND employee_id=${w.employee.id}::uuid) AS payloads,
          (SELECT count(*)::int FROM employment_records
            WHERE tenant_id=${w.session.tenant.id} AND employee_id=${w.employee.id}::uuid) AS records,
          (SELECT count(*)::int FROM transfer_requests
            WHERE tenant_id=${w.session.tenant.id} AND employee_id=${w.employee.id}::uuid) AS transfers,
          (SELECT count(*)::int FROM approval_instances
            WHERE tenant_id=${w.session.tenant.id} AND subject_employee_id=${w.employee.id}::uuid) AS instances
      `),
    );
    const [employee] = rowsOf<{ revision: number }>(
      await tx.execute(sql`SELECT revision FROM employment_employees
        WHERE tenant_id=${w.session.tenant.id} AND id=${w.employee.id}::uuid`),
    );
    return { ...counts!, revision: employee!.revision };
  });
}

async function expectNoCommandWrites(w: World, commandId: string) {
  const [writes] = await withTenant(w.db, w.session.tenant.id, async (tx) =>
    rowsOf<{ audits: number; outbox: number }>(
      await tx.execute(sql`
        SELECT
          (SELECT count(*)::int FROM audit_events WHERE tenant_id=${w.session.tenant.id}
            AND command_id=${commandId}
            AND object_type IN ('employment-business','employment-record','transfer-request')) AS audits,
          (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${w.session.tenant.id}
            AND command_id=${commandId}) AS outbox
      `),
    ),
  );
  expect(writes).toEqual({ audits: 0, outbox: 0 });
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TRF 二审：新入口真 PG 强制交错', () => {
  it('同员工两笔新入口直接调动排队，同revision仅首笔写入任职、调动元数据和审计', async () => {
    const w = await fixture('trf-r2-pg-cas');
    const firstCommand = randomUUID();
    const secondCommand = randomUUID();
    const [first, second] = await queuedRequests(
      w,
      w.employee.id,
      () => w.request('direct', w.hire.employeeRevision, firstCommand, { place: '第一笔调动' }),
      () => w.request('direct', w.hire.employeeRevision, secondCommand, { place: '第二笔不得写入' }),
    );
    expect(first!.status, await first!.clone().text()).toBe(201);
    expect(second!.status).toBe(409);
    expect(await second!.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const saved = (await first!.json()) as EmploymentBusiness;
    expect(saved.status).toBe('effective');
    expect(await persisted(w)).toEqual({
      businesses: 2,
      payloads: 2,
      records: 2,
      transfers: 1,
      instances: 0,
      revision: saved.employeeRevision,
    });
    expect((await w.session.records(w.employee.id)).map((record) => record.id)).toEqual([w.hire.id, saved.id]);
    expect((await w.auditEvents(saved.id)).filter((event) => event.action === 'employment.record.create')).toHaveLength(
      1,
    );
    await expectNoCommandWrites(w, secondCommand);
  });

  it('新入口提交申请先获锁：直接调动先CAS冲突，刷新后被DEC-154拒绝，两次拒绝均无残留', async () => {
    const w = await fixture('trf-r2-pg-submit-first');
    const submittedCommand = randomUUID();
    const directCommand = randomUUID();
    const [application, direct] = await queuedRequests(
      w,
      w.employee.id,
      () => w.request('application', w.hire.employeeRevision, submittedCommand),
      () => w.request('direct', w.hire.employeeRevision, directCommand, { place: '不得抢过申请' }),
    );
    expect(application!.status, await application!.clone().text()).toBe(201);
    expect(direct!.status).toBe(409);
    expect(await direct!.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const saved = (await application!.json()) as EmploymentBusiness;
    expect(saved.status).toBe('in_review');
    const beforeRetry = await persisted(w);
    expect(beforeRetry).toEqual({
      businesses: 2,
      payloads: 2,
      records: 1,
      transfers: 1,
      instances: 1,
      revision: saved.employeeRevision,
    });
    await expectNoCommandWrites(w, directCommand);
    const current = await w.session.getEmployee(w.employee.id);
    const retriedCommand = randomUUID();
    const retry = await w.request('direct', current.revision, retriedCommand, { place: '刷新后仍不得直接调动' });
    expect(retry.status, await retry.clone().text()).toBe(409);
    expect(await retry.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        message: '当前存在审批中的调动记录，无法进行此操作',
        details: { reason: 'TRANSFER_IN_REVIEW' },
      },
    });
    expect(await persisted(w)).toEqual(beforeRetry);
    await expectNoCommandWrites(w, retriedCommand);
    expect((await w.session.records(w.employee.id)).map((record) => record.id)).toEqual([w.hire.id]);
  });

  it('新入口直接调动先获锁：后到提交必须刷新revision，重提交继承已提交的新任职并仅起一个流程', async () => {
    const w = await fixture('trf-r2-pg-direct-first');
    const directCommand = randomUUID();
    const submittedCommand = randomUUID();
    const [direct, application] = await queuedRequests(
      w,
      w.employee.id,
      () => w.request('direct', w.hire.employeeRevision, directCommand, { place: '直接调动已保存的新地点' }),
      () => w.request('application', w.hire.employeeRevision, submittedCommand),
    );
    expect(direct!.status, await direct!.clone().text()).toBe(201);
    expect(application!.status).toBe(409);
    expect(await application!.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const savedDirect = (await direct!.json()) as EmploymentBusiness;
    expect(await persisted(w)).toEqual({
      businesses: 2,
      payloads: 2,
      records: 2,
      transfers: 1,
      instances: 0,
      revision: savedDirect.employeeRevision,
    });
    await expectNoCommandWrites(w, submittedCommand);
    const current = await w.session.getEmployee(w.employee.id);
    const retry = await w.request('application', current.revision, randomUUID());
    expect(retry.status, await retry.clone().text()).toBe(201);
    const savedApplication = (await retry.json()) as EmploymentBusiness & { fields: { place: string } };
    expect(savedApplication).toMatchObject({ status: 'in_review', fields: { place: '直接调动已保存的新地点' } });
    expect(await persisted(w)).toEqual({
      businesses: 3,
      payloads: 3,
      records: 2,
      transfers: 2,
      instances: 1,
      revision: savedApplication.employeeRevision,
    });
    expect((await w.session.records(w.employee.id)).map((record) => record.id)).toEqual([w.hire.id, savedDirect.id]);
  });
});
