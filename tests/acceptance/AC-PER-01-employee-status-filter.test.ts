/**
 * F-022 / AC-PER-01：员工“当前”人员状态 = 当前生效主职版本上的值；员工列表与人员信息列表（高级筛选）
 * 可按人员状态、入职状态筛选；旧的 status（pending / employed / left / retired）由人员状态派生。
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { createEmploymentBusiness } from '../../apps/api/src/modules/employment/write-service.js';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function hired(session: EmploymentSession, entry: { pendingEntry?: boolean; probation?: boolean }) {
  const org = await session.org(`筛选部门${randomUUID().slice(0, 6)}`, { establishedOn: '2026-01-01' });
  const employee = await session.employee();
  await withTenant(testDb().db, session.tenant.id, (tx) =>
    createEmploymentBusiness(
      tx,
      {
        tenantId: session.tenant.id,
        userId: session.user.id,
        timezone: session.tenant.timezone,
        now: new Date('2026-10-01T01:00:00Z'),
        commandId: randomUUID(),
        expectedRevision: employee.revision,
      } satisfies EmploymentContext,
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId: org.id } },
      { entry },
    ),
  );
  return employee.id;
}

describe('AC-PER-01 员工当前人员状态与列表筛选', () => {
  it('员工列表、人员信息列表按人员状态 / 入职状态筛选，旧 status 由人员状态派生', async () => {
    const session = await employmentSession(testDb().db, 'perstatus');
    const probation = await hired(session, { probation: true });
    const regular = await hired(session, {});
    const pending = await hired(session, { pendingEntry: true });
    const ids = async (path: string) => {
      const response = await session.request('GET', path);
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { id: string }[] }).items.map((row) => row.id);
    };
    expect(await ids('/employees?employeeStatus=2&asOf=2026-10-01&pageSize=200')).toEqual([probation]);
    expect((await ids('/employees?employeeStatus=3&asOf=2026-10-01&pageSize=200')).sort()).toEqual([regular]);
    expect(await ids('/employees?employeeStatus=1&entryStatus=0&asOf=2026-10-01&pageSize=200')).toEqual([pending]);
    expect(await ids('/employees?status=pending&asOf=2026-10-01&pageSize=200')).toContain(pending);
    const invalid = await session.request('GET', '/employees?employeeStatus=7');
    expect(invalid.status).toBe(400);
    const api = tenantApi(testDb().db, { clock: () => new Date('2026-10-01T01:00:00Z') });
    const personnel = async (query: string) => {
      const response = await api.request('GET', `/api/tenant/personnel/employees?${query}&pageSize=200`, {
        user: session.user.id,
        tenant: session.tenant.id,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ((await response.json()) as { items: { id: string; employeeStatus: number | null }[] }).items;
    };
    expect((await personnel('employeeStatus=2')).map((row) => row.id)).toEqual([probation]);
    expect((await personnel('entryStatus=0')).map((row) => row.id)).toEqual([pending]);
    expect((await personnel('sortBy=employeeStatus')).find((row) => row.id === regular)?.employeeStatus).toBe(3);
  });
});
