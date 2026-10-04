import { randomUUID } from 'node:crypto';
import { pgErrorCode, sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { EMP_TODAY, employmentSession, type EmploymentBusiness } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function hired(db: Db, label: string) {
  const session = await employmentSession(db, label);
  // R1-T07：提交申请须匹配已发布流程（DEC-017）；本文件只验证平台约定，安装兜底流程。
  await installApprovalFallbacks(db, session.tenant.id, session.user.id);
  const department = await session.org('平台验收部门');
  const employee = await session.employee();
  const hire = await session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: EMP_TODAY, fields: { departmentId: department.id } },
    employee.revision,
  );
  return { session, employee, hire };
}

describe('AC-EMP 平台并发、幂等、隔离与数据库时间轴约束', () => {
  it('创建业务必须携带revision和命令ID，员工与业务的过期revision均返回409', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-platform-revision');
    const body = { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-02' };
    const missingRevision = await session.request('POST', `/employees/${employee.id}/businesses`, { body });
    expect(missingRevision.status).toBe(400);
    expect(await errorCode(missingRevision)).toBe('REVISION_REQUIRED');
    const missingCommand = await session.request('POST', `/employees/${employee.id}/businesses`, {
      body,
      ifMatch: hire.employeeRevision,
      idempotencyKey: null,
    });
    expect(missingCommand.status).toBe(400);
    expect(await errorCode(missingCommand)).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const staleEmployee = await session.request('POST', `/employees/${employee.id}/businesses`, {
      body,
      ifMatch: employee.revision,
    });
    expect(staleEmployee.status).toBe(409);
    expect(await errorCode(staleEmployee)).toBe('REVISION_CONFLICT');
    const draft = await session.business(employee.id, body, hire.employeeRevision);
    const submitted = await session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(submitted.status).toBe(200);
    const staleBusiness = await session.request('POST', `/businesses/${draft.id}/withdraw`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(staleBusiness.status).toBe(409);
    expect(await errorCode(staleBusiness)).toBe('REVISION_CONFLICT');
    expect(await session.records(employee.id)).toHaveLength(1);
  });

  it('同命令同内容重放相同结果且无重复任职或审计，异内容复用返回409', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-platform-idempotency');
    const commandId = randomUUID();
    const body = { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-02', fields: { place: '幂等地点' } };
    const options = { body, ifMatch: hire.employeeRevision, idempotencyKey: commandId };
    const first = await session.request('POST', `/employees/${employee.id}/businesses`, options);
    expect(first.status).toBe(201);
    const saved = (await first.json()) as EmploymentBusiness;
    const audits = () =>
      withTenant(db, session.tenant.id, async (tx) =>
        resultRows(await tx.execute(sql`SELECT id FROM audit_events WHERE command_id=${commandId} ORDER BY id`)),
      );
    const events = () =>
      withTenant(db, session.tenant.id, async (tx) =>
        resultRows(await tx.execute(sql`SELECT id FROM employment_outbox WHERE command_id=${commandId} ORDER BY id`)),
      );
    const firstAudits = await audits();
    const firstEvents = await events();
    expect(firstAudits.length).toBeGreaterThan(0);
    expect(firstEvents.length).toBe(firstAudits.length);
    const replay = await session.request('POST', `/employees/${employee.id}/businesses`, options);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(saved);
    expect(await session.getEmployee(employee.id)).toMatchObject({ revision: saved.employeeRevision });
    expect(await session.records(employee.id)).toHaveLength(2);
    expect(await audits()).toEqual(firstAudits);
    expect(await events()).toEqual(firstEvents);
    const different = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ...options,
      body: { ...body, fields: { place: '不同地点' } },
    });
    expect(different.status).toBe(409);
    expect(await errorCode(different)).toBe('IDEMPOTENCY_CONFLICT');
    expect(await session.records(employee.id)).toHaveLength(2);
  });

  it('其他租户不能读取或借用员工、业务与任职ID，真实表RLS也隐藏这些行', async () => {
    const { db } = testDb();
    const { session: owner, employee, hire } = await hired(db, 'emp-platform-owner');
    const stranger = await employmentSession(db, 'emp-platform-stranger');
    for (const path of [`/employees/${employee.id}`, `/businesses/${hire.id}`, `/records/${hire.record!.id}`]) {
      const hidden = await stranger.request('GET', path);
      expect(hidden.status).toBe(404);
    }
    const borrowed = await stranger.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hire.employeeRevision,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-02' },
    });
    expect(borrowed.status).toBe(404);
    const raw = await withTenant(db, stranger.tenant.id, async (tx) => {
      const employees = resultRows(await tx.execute(sql`SELECT id FROM employment_employees WHERE id=${employee.id}`));
      const businesses = resultRows(
        await tx.execute(sql`SELECT id FROM employment_business_objects WHERE id=${hire.id}`),
      );
      const records = resultRows(await tx.execute(sql`SELECT id FROM employment_records WHERE id=${hire.record!.id}`));
      return { employees, businesses, records };
    });
    expect(raw).toEqual({ employees: [], businesses: [], records: [] });
    expect(await owner.records(employee.id)).toHaveLength(1);
  });

  it('员工范围撤权后同命令重放仍须重新验权，不能返回缓存业务字段', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-platform-scope-replay');
    const draft = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-10-02', fields: { place: '受限业务字段' } },
      hire.employeeRevision,
    );
    let employeeAllowed = true;
    const api = tenantApi(db, {
      clock: () => new Date(`${EMP_TODAY}T01:00:00.000Z`),
      authorize: ({ action, resource }) =>
        action !== 'tenant.employment.write' || resource !== employee.id || employeeAllowed,
    });
    const path = `/api/tenant/employment/businesses/${draft.id}/submit`;
    const options = {
      user: session.user.id,
      tenant: session.tenant.id,
      ifMatch: draft.revision,
      idempotencyKey: randomUUID(),
      body: {},
    };
    const submitted = await api.request('POST', path, options);
    expect(submitted.status).toBe(200);
    const saved = (await submitted.json()) as EmploymentBusiness;
    expect(saved.status).toBe('in_review');
    employeeAllowed = false;
    const replay = await api.request('POST', path, options);
    expect(replay.status).toBe(403);
    expect(await errorCode(replay)).toBe('FORBIDDEN');
    expect(await session.getEmployee(employee.id)).toMatchObject({ revision: saved.employeeRevision });
    expect(await session.records(employee.id)).toHaveLength(1);
  });

  it('数据库拒绝两个任职投影区间重叠，拒绝后当前记录与两条业务快照不变', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-platform-overlap');
    const future = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-02', fields: { place: '下条地点' } },
      hire.employeeRevision,
    );
    const before = await session.records(employee.id);
    const error = await withTenant(db, session.tenant.id, async (tx) => {
      await tx.execute(sql`UPDATE employment_timeline
        SET valid_during=daterange(start_date,NULL,'[)')
        WHERE tenant_id=${session.tenant.id} AND record_id=${hire.record!.id}`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    }).catch((cause: unknown) => cause);
    expect(['23P01', '23514']).toContain(pgErrorCode(error));
    expect(await session.records(employee.id)).toEqual(before);
    expect(before.filter((record) => record.isCurrent)).toEqual([expect.objectContaining({ id: hire.record!.id })]);
    expect(before).toContainEqual(
      expect.objectContaining({ id: future.record!.id, fields: expect.objectContaining({ place: '下条地点' }) }),
    );
  });

  it('数据库拒绝删除未撤销任职的唯一投影，不能留下有任职却无当前记录的缺口', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-platform-coverage');
    const error = await withTenant(db, session.tenant.id, async (tx) => {
      await tx.execute(sql`DELETE FROM employment_timeline
        WHERE tenant_id=${session.tenant.id} AND record_id=${hire.record!.id}`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
    }).catch((cause: unknown) => cause);
    expect(pgErrorCode(error)).toBe('23514');
    expect(await session.records(employee.id)).toEqual([
      expect.objectContaining({ id: hire.record!.id, isCurrent: true }),
    ]);
  });

  it('数据库拒绝修改或物理删除生效任职，业务字段只能保留不可变快照', async () => {
    const { db } = testDb();
    const { session, employee, hire } = await hired(db, 'emp-platform-immutable');
    const tenantUpdate = await withTenant(db, session.tenant.id, (tx) =>
      tx.execute(sql`UPDATE employment_records SET place='禁止覆盖' WHERE id=${hire.record!.id}`),
    ).catch((cause: unknown) => cause);
    expect(pgErrorCode(tenantUpdate)).toBe('42501');
    const update = await db
      .execute(sql`UPDATE employment_records SET place='禁止覆盖' WHERE id=${hire.record!.id}`)
      .catch((cause: unknown) => cause);
    expect(pgErrorCode(update)).toBe('55000');
    const deletion = await db
      .execute(sql`DELETE FROM employment_records WHERE id=${hire.record!.id}`)
      .catch((cause: unknown) => cause);
    expect(pgErrorCode(deletion)).toBe('55000');
    expect(await session.records(employee.id)).toHaveLength(1);
  });
});
