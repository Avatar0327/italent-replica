/**
 * F-022 第二轮（PR #93 astra 首审）：
 * - P2-1：记录 / 申请移到新的实际位置时，按新位置前驱重新确定继承的人员状态（迟到调动、改期申请）；
 * - P2-3：删除审计的删除前镜像取最新记录快照上的人员状态 / 入职状态（DEC-216）；
 * - DEC-231（AC-EMP-21）：已把“正式”传播到后续版本的转正记录暂禁删除；
 * - P3：人员信息列表的状态筛选校验枚举编码。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { changePendingEntryStatus } from '../../apps/api/src/modules/employment/employee-status.js';
import { transitionEmployment } from '../../apps/api/src/modules/employment/transitions.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const rows = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

function context(session: EmploymentSession, expectedRevision: number, at = '2026-10-01T01:00:00Z') {
  return {
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision,
  } satisfies EmploymentContext;
}

async function probationHire(
  session: EmploymentSession,
  departmentId: string,
  entry: { pendingEntry?: boolean; probation?: boolean } = { probation: true },
) {
  const employee = await session.employee();
  const business = await withTenant(testDb().db, session.tenant.id, (tx) =>
    createEmploymentBusiness(
      tx,
      context(session, employee.revision),
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId } },
      { entry },
    ),
  );
  return { employee, business };
}

interface StatusRow {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly employeeStatus: number;
  readonly entryStatus: number | null;
  readonly revision: number;
}

async function statuses(session: EmploymentSession, employeeId: string, asOf: string) {
  return (await session.records(employeeId, asOf)) as unknown as StatusRow[];
}

async function deleteAudit(session: EmploymentSession, recordId: string) {
  return withTenant(testDb().db, session.tenant.id, async (tx) =>
    rows<{ action: string; before: Record<string, unknown> }>(
      await tx.execute(sql`SELECT action, before FROM audit_events
        WHERE tenant_id=${session.tenant.id} AND object_id=${recordId}
          AND action IN ('employment.record.delete','employment.business.delete') ORDER BY action`),
    ),
  );
}

async function remove(session: EmploymentSession, id: string, at = '2026-10-01T01:00:00Z') {
  const business = await session.request('GET', `/businesses/${id}`);
  const revision = ((await business.json()) as { revision: number }).revision;
  return withTenant(testDb().db, session.tenant.id, (tx) =>
    transitionEmployment(tx, context(session, revision, at), { id, action: 'delete' }),
  );
}

describe('AC-EMP-19（第二轮）改期后按新位置重新继承人员状态', () => {
  it('迟到调动越过转正：定时生效移到当天后取转正后的正式，不倒退为试用', async () => {
    const w = await activationWorld(testDb().db, 'f022-late-cross');
    const { employee } = await probationHire(w.session, w.from.id);
    const transfer = await w.session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
      (await w.session.getEmployee(employee.id)).revision,
    );
    await w.session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-10-06', fields: {} },
      (await w.session.getEmployee(employee.id)).revision,
    );
    expect(await w.runScheduler('2026-10-08T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    const records = await statuses(w.session, employee.id, '2026-10-08');
    expect(records.map((record) => [record.kind, record.effectiveDate, record.employeeStatus])).toEqual([
      ['hire', '2026-09-01', 2],
      ['regularization', '2026-10-06', 3],
      ['transfer', '2026-10-08', 3],
    ]);
    expect(records.find((record) => record.id === transfer.record!.id)?.employeeStatus).toBe(3);
  });

  it('改期申请越过转正：申请改到转正之后，追加的载荷版本为正式', async () => {
    const session = await employmentSession(testDb().db, 'f022-patch-cross');
    const org = await session.org('改期部门', { establishedOn: '2026-01-01' });
    const target = await session.org('改期调入部门', { establishedOn: '2026-01-01' });
    const { employee } = await probationHire(session, org.id);
    const application = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-15', fields: { departmentId: target.id } },
      (await session.getEmployee(employee.id)).revision,
    );
    await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      (await session.getEmployee(employee.id)).revision,
    );
    const current = (await (await session.request('GET', `/businesses/${application.id}`)).json()) as {
      revision: number;
      employeeStatus: number;
    };
    expect(current.employeeStatus).toBe(2);
    const patched = await session.request('PATCH', `/businesses/${application.id}`, {
      ifMatch: current.revision,
      body: { effectiveDate: '2026-12-01' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await patched.json()).toMatchObject({ effectiveDate: '2026-12-01', employeeStatus: 3 });
  });
});

describe('AC-EMP-17（第二轮）删除审计取最新快照上的状态', () => {
  it('转正传播后删除后续调动：删除前镜像为正式', async () => {
    const session = await employmentSession(testDb().db, 'f022-delete-propagated');
    const org = await session.org('删除部门', { establishedOn: '2026-01-01' });
    const target = await session.org('删除调入部门', { establishedOn: '2026-01-01' });
    const { employee } = await probationHire(session, org.id);
    const transfer = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { departmentId: target.id } },
      (await session.getEmployee(employee.id)).revision,
    );
    await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      (await session.getEmployee(employee.id)).revision,
    );
    expect((await session.record(transfer.record!.id)) as unknown as StatusRow).toMatchObject({ employeeStatus: 3 });
    await remove(session, transfer.id);
    const audit = await deleteAudit(session, transfer.id);
    expect(audit.find((row) => row.action === 'employment.record.delete')?.before).toMatchObject({
      employeeStatus: 3,
      entryStatus: null,
    });
  });

  it('延期入职后删除入职记录：删除前镜像的入职状态为延期', async () => {
    const session = await employmentSession(testDb().db, 'f022-delete-postponed');
    const org = await session.org('延期部门', { establishedOn: '2026-01-01' });
    const { business } = await probationHire(session, org.id, { pendingEntry: true });
    const recordId = business.record!.id;
    const current = (await statuses(session, business.employeeId, '2026-10-01'))[0]!;
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      changePendingEntryStatus(tx, context(session, current.revision), recordId, 'postponed'),
    );
    await remove(session, recordId);
    const audit = await deleteAudit(session, recordId);
    expect(audit.find((row) => row.action === 'employment.record.delete')?.before).toMatchObject({
      employeeStatus: 1,
      entryStatus: 2,
    });
  });
});

describe('AC-EMP-21 DEC-231：已把“正式”传播到后续版本的转正记录暂禁删除', () => {
  it('转正已传播到后续调动时拒绝删除并给出原因；未传播的转正可以删除', async () => {
    const session = await employmentSession(testDb().db, 'f022-dec231');
    const org = await session.org('转正删除部门', { establishedOn: '2026-01-01' });
    const target = await session.org('转正删除调入部门', { establishedOn: '2026-01-01' });
    const { employee } = await probationHire(session, org.id);
    await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { departmentId: target.id } },
      (await session.getEmployee(employee.id)).revision,
    );
    const propagated = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      (await session.getEmployee(employee.id)).revision,
    );
    await expect(remove(session, propagated.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'REGULARIZATION_STATUS_PROPAGATED' },
    });
    const other = await probationHire(session, org.id);
    const alone = await session.business(
      other.employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      (await session.getEmployee(other.employee.id)).revision,
    );
    expect(await remove(session, alone.id)).toMatchObject({ status: 'deleted' });
  });

  it('经 HTTP 删除已传播的转正返回 409，拒绝前后该租户所有业务表的数据完全不变', async () => {
    const session = await employmentSession(testDb().db, 'f022-dec231-http');
    const org = await session.org('转正删除部门', { establishedOn: '2026-01-01' });
    const target = await session.org('转正删除调入部门', { establishedOn: '2026-01-01' });
    const { employee } = await probationHire(session, org.id);
    await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-12-01', fields: { departmentId: target.id } },
      (await session.getEmployee(employee.id)).revision,
    );
    const propagated = await session.business(
      employee.id,
      { kind: 'regularization', mode: 'direct', effectiveDate: '2026-11-01', fields: {} },
      (await session.getEmployee(employee.id)).revision,
    );
    const revision = (
      (await (await session.request('GET', `/businesses/${propagated.id}`)).json()) as {
        revision: number;
      }
    ).revision;
    const before = await tenantTables(session);
    const response = await session.request('DELETE', `/businesses/${propagated.id}`, { ifMatch: revision });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain('REGULARIZATION_STATUS_PROPAGATED');
    const after = await tenantTables(session);
    // 业务失败只按 DEC-067 记一条命令失败，其余表逐行不变（含版本链、时间轴、revision、删除标记、审计、outbox）
    const changed = Object.keys(after).filter(
      (table) => JSON.stringify(after[table]) !== JSON.stringify(before[table]),
    );
    expect(changed.filter((table) => table !== 'audit_command_failures')).toEqual([]);
    const failures = (after.audit_command_failures ?? []).filter((r) => !before.audit_command_failures?.includes(r));
    expect(failures.map((r) => JSON.parse(r) as Record<string, unknown>)).toMatchObject([
      { outcome: 'business_failed', error_code: 'CONFLICT', reason: 'REGULARIZATION_STATUS_PROPAGATED' },
    ]);
    expect(before.employment_records?.length).toBeGreaterThan(0);
    expect(before.employment_timeline?.length).toBeGreaterThan(0);
  });
});

/** 该租户所有带 tenant_id 列的表，按行的 JSON 排序后整体返回，用于证明拒绝的命令没有写入任何业务数据。 */
async function tenantTables(session: EmploymentSession) {
  return withTenant(testDb().db, session.tenant.id, async (tx) => {
    const tables = rows<{ table_name: string }>(
      await tx.execute(sql`SELECT c.table_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`),
    ).map((row) => row.table_name);
    const snapshot: Record<string, string[]> = {};
    for (const table of tables) {
      const result = rows<{ body: string }>(
        await tx.execute(sql`SELECT to_jsonb(x)::text AS body FROM ${sql.identifier(table)} x
          WHERE x.tenant_id = ${session.tenant.id} ORDER BY 1`),
      );
      snapshot[table] = result.map((row) => row.body);
    }
    return snapshot;
  });
}

describe('AC-PER-01（第二轮）人员信息列表的状态筛选校验编码', () => {
  it('非法人员状态 / 入职状态编码返回 400，与员工列表一致', async () => {
    const session = await employmentSession(testDb().db, 'f022-personnel-filter');
    const api = tenantApi(testDb().db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const as = { user: session.user.id, tenant: session.tenant.id };
    for (const query of ['employeeStatus=7', 'entryStatus=9', 'employeeStatus=abc']) {
      const response = await api.request('GET', `/api/tenant/personnel/employees?${query}`, as);
      expect(response.status, query).toBe(400);
    }
    expect((await api.request('GET', '/api/tenant/personnel/employees?employeeStatus=2', as)).status).toBe(200);
  });
});

describe('AC-EMP-17（DEC-234）实习转正按入职处理', () => {
  async function intern(session: EmploymentSession, entry: { probation?: boolean } = {}) {
    const org = await session.org(`实习部门${randomUUID().slice(0, 6)}`, { establishedOn: '2026-01-01' });
    const employee = await session.employee();
    await withTenant(testDb().db, session.tenant.id, (tx) =>
      createEmploymentBusiness(
        tx,
        context(session, employee.revision),
        employee.id,
        {
          kind: 'hire',
          mode: 'direct',
          effectiveDate: '2026-09-01',
          fields: { departmentId: org.id, employType: 'intern' },
        },
        { entry },
      ),
    );
    return employee;
  }

  async function regularize(session: EmploymentSession, employeeId: string, entry?: { probation?: boolean }) {
    const revision = (await session.getEmployee(employeeId)).revision;
    return withTenant(testDb().db, session.tenant.id, (tx) =>
      createEmploymentBusiness(
        tx,
        context(session, revision),
        employeeId,
        { kind: 'intern_regularization', mode: 'direct', effectiveDate: '2026-09-20', fields: {} },
        entry ? { entry } : {},
      ),
    );
  }

  it('实习生在职为正式；实习转正默认正式，不继承实习期的状态', async () => {
    const session = await employmentSession(testDb().db, 'f022-intern-default');
    const plain = await intern(session);
    expect((await statuses(session, plain.id, '2026-10-01'))[0]).toMatchObject({ employeeStatus: 3 });
    // 即使实习期版本被可信端口写成试用，实习转正也按入职处理，默认正式
    const odd = await intern(session, { probation: true });
    const regularized = await regularize(session, odd.id);
    expect(regularized.record).toMatchObject({
      employeeStatus: 3,
      entryStatus: null,
      fields: { employType: 'internal' },
    });
  });

  it('实习转正经可信端口传入“有试用期”时为试用（R2 接线，同 DEC-224）', async () => {
    const session = await employmentSession(testDb().db, 'f022-intern-probation');
    const employee = await intern(session);
    const regularized = await regularize(session, employee.id, { probation: true });
    expect(regularized.record).toMatchObject({ employeeStatus: 2 });
    expect((await statuses(session, employee.id, '2026-10-01')).map((row) => row.employeeStatus)).toEqual([3, 2]);
  });
});
