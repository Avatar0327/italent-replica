import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { customField } from './AC-EMP-inheritance-support.js';
import { employmentSession, type Employee } from './AC-EMP-support.js';
import { resultRows } from './AC-ORG-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-EMP 配置权限、直接调动开关及列表边界', () => {
  it('DEC-051 默认允许直接调动，关闭后无业务副作用，申请不受影响且设置使用revision', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empconfiguration-switch');
    const defaults = await session.request('GET', '/settings');
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toEqual({ revision: 0, allowDirectTransfer: true });
    const employee = await session.employee();
    const org = await session.org('合成在职部门', { startDate: '2026-01-01' });
    const hired = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01', fields: { departmentId: org.id } },
      employee.revision,
    );
    const closed = await session.request('PUT', '/settings', { ifMatch: 0, body: { allowDirectTransfer: false } });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ revision: 1, allowDirectTransfer: false });
    const commandId = randomUUID();
    const blocked = await session.request('POST', `/employees/${employee.id}/businesses`, {
      ifMatch: hired.employeeRevision,
      idempotencyKey: commandId,
      body: { kind: 'transfer', mode: 'direct', effectiveDate: '2026-02-01' },
    });
    expect(blocked.status).toBe(409);
    expect(await errorCode(blocked)).toBe('CONFLICT');
    expect(await session.getEmployee(employee.id)).toMatchObject({ revision: hired.employeeRevision });
    const unchanged = await withTenant(db, session.tenant.id, async (tx) => ({
      businesses: resultRows<{ count: number }>(
        await tx.execute(sql`
        SELECT count(*)::int AS count FROM employment_business_objects WHERE employee_id=${employee.id}
      `),
      )[0]!.count,
      audits: resultRows(await tx.execute(sql`SELECT id FROM audit_events WHERE command_id=${commandId}`)),
      outbox: resultRows(await tx.execute(sql`SELECT id FROM employment_outbox WHERE command_id=${commandId}`)),
    }));
    expect(unchanged).toEqual({ businesses: 1, audits: [], outbox: [] });
    const application = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'application', effectiveDate: '2026-03-01' },
      hired.employeeRevision,
    );
    expect(application).toMatchObject({ status: 'draft', record: null });
    const reopened = await session.request('PUT', '/settings', { ifMatch: 1, body: { allowDirectTransfer: true } });
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual({ revision: 2, allowDirectTransfer: true });
    const stale = await session.request('PUT', '/settings', { ifMatch: 1, body: { allowDirectTransfer: false } });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');
    const direct = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-02-01' },
      application.employeeRevision,
    );
    expect(direct).toMatchObject({ status: 'effective', record: { kind: 'transfer' } });
    expect(await session.records(employee.id)).toHaveLength(2);
  });

  it('DEC-001 配置权限独立于普通写权限，预置字段与其他租户字段不可改继承设置', async () => {
    const { db } = testDb();
    const session = await employmentSession(db, 'empconfiguration-permission');
    const field = await customField(session);
    const api = tenantApi(db, {
      clock: () => new Date('2026-10-01T01:00:00Z'),
      authorize: ({ action }) => action !== 'tenant.employment.configuration.write',
    });
    const options = { user: session.user.id, tenant: session.tenant.id };
    const ordinary = await api.request('POST', '/api/tenant/employment/employees', {
      ...options,
      ifMatch: 0,
      body: { code: 'CONFIG_PERMISSION_EMP', name: '配置权限合成员工' },
    });
    expect(ordinary.status).toBe(201);
    for (const [path, body, revision] of [
      ['/settings', { allowDirectTransfer: false }, 0],
      [`/custom-fields/${field.id}/inheritance`, { inherit: false }, field.revision],
    ] as const) {
      const denied = await api.request('PUT', `/api/tenant/employment${path}`, {
        ...options,
        ifMatch: revision,
        body,
      });
      expect(denied.status).toBe(403);
      expect(await errorCode(denied)).toBe('FORBIDDEN');
    }
    const createDenied = await api.request('POST', '/api/tenant/employment/custom-fields', {
      ...options,
      ifMatch: 0,
      body: { name: '禁止新增', objectType: 'employment', valueType: 'text' },
    });
    expect(createDenied.status).toBe(403);
    const preset = await session.request('PUT', '/custom-fields/place/inheritance', {
      ifMatch: 0,
      body: { inherit: false },
    });
    expect(preset.status).toBe(400);
    const stranger = await employmentSession(db, 'empconfiguration-stranger');
    const borrowed = await stranger.request('PUT', `/custom-fields/${field.id}/inheritance`, {
      ifMatch: field.revision,
      body: { inherit: false },
    });
    expect(borrowed.status).toBe(404);
    const fields = await session.request('GET', '/custom-fields');
    expect(fields.status).toBe(200);
    expect((await fields.json()) as { items: unknown[] }).toMatchObject({
      items: [{ id: field.id, revision: field.revision, inherit: true }],
    });
  });

  it('员工列表默认50、最大200，在SQL分页之前按状态和工号过滤', async () => {
    const session = await employmentSession(testDb().db, 'empconfiguration-pagination');
    const employed = await session.employee('在职合成员工', 'CONFIG_EMPLOYED');
    await session.business(
      employed.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01' },
      employed.revision,
    );
    const left = await session.employee('离职合成员工', 'CONFIG_LEFT');
    const hired = await session.business(
      left.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-01-01' },
      left.revision,
    );
    await session.business(
      left.id,
      { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' },
      hired.employeeRevision,
    );
    for (let index = 0; index < 50; index++)
      await session.employee(`待入职合成员工${index}`, `CONFIG_PENDING_${index}`);
    const defaultResponse = await session.request('GET', '/employees');
    expect(defaultResponse.status).toBe(200);
    const first = (await defaultResponse.json()) as { items: Employee[]; page: number; pageSize: number };
    expect(first).toMatchObject({ page: 1, pageSize: 50 });
    expect(first.items).toHaveLength(50);
    const second = await session.request('GET', '/employees?page=2');
    expect(second.status).toBe(200);
    const next = (await second.json()) as { items: Employee[]; page: number; pageSize: number };
    expect(next).toMatchObject({ page: 2, pageSize: 50 });
    expect(next.items).toHaveLength(2);
    expect(new Set([...first.items, ...next.items].map((item) => item.id)).size).toBe(52);
    const maximum = await session.request('GET', '/employees?pageSize=200');
    expect(maximum.status).toBe(200);
    const maximumPage = (await maximum.json()) as { items: Employee[]; pageSize: number };
    expect(maximumPage.pageSize).toBe(200);
    expect(maximumPage.items).toHaveLength(52);
    const overBudget = await session.request('GET', '/employees?pageSize=201');
    expect(overBudget.status).toBe(400);
    expect(await errorCode(overBudget)).toBe('VALIDATION_FAILED');
    for (const [status, expected] of [
      ['employed', employed],
      ['left', left],
    ] as const) {
      const filtered = await session.request('GET', `/employees?status=${status}&pageSize=1`);
      expect(filtered.status).toBe(200);
      expect(((await filtered.json()) as { items: Employee[] }).items).toEqual([
        expect.objectContaining({ id: expected.id, status }),
      ]);
    }
    const target = first.items[1]!;
    const codeFiltered = await session.request('GET', `/employees?code=${target.code.toLowerCase()}&pageSize=1`);
    expect(codeFiltered.status).toBe(200);
    expect(((await codeFiltered.json()) as { items: Employee[] }).items).toEqual([
      expect.objectContaining({ id: target.id, code: target.code }),
    ]);
  });
});
