/** BE-2a 待入职验收夹具：经路由添加待入职、读取状态（docs/02_业务建模/34 §3、EN-R8 / R9 / R14）。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { employmentSession, withLoginEmail, type EmploymentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

export interface EntryRecord {
  readonly id: string;
  readonly revision: number;
  readonly effectiveDate: string;
  readonly employeeStatus: number;
  readonly entryStatus: number | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

export async function entryWorld(db: Db, label: string) {
  const session = await employmentSession(db, label);
  const org = await session.org(`入职部门-${label}`, { establishedOn: '2026-01-01' });
  return { db, session, org };
}
export type EntryWorld = Awaited<ReturnType<typeof entryWorld>>;

export function hireBody(orgId: string, effectiveDate: string, extra: Record<string, unknown> = {}) {
  return {
    kind: 'hire',
    mode: 'direct',
    effectiveDate,
    fields: { employType: 'internal', departmentId: orgId },
    ...extra,
  };
}

/** 原始请求：失败用例要读响应码与消息。 */
export function addHire(s: EmploymentSession, employee: { id: string; revision: number }, body: object) {
  return s.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: employee.revision,
    body: withLoginEmail(employee.id, body as Record<string, unknown>),
  });
}

/** 添加待入职：路由必须 201，返回新员工与待入职记录。 */
export async function addPending(w: EntryWorld, effectiveDate = '2026-10-10', name = '待入职合成员工') {
  const employee = await w.session.employee(name);
  const response = await addHire(w.session, employee, hireBody(w.org.id, effectiveDate, { pendingEntry: true }));
  expect(response.status, await response.clone().text()).toBe(201);
  const business = (await response.json()) as {
    id: string;
    revision: number;
    employeeRevision: number;
    record: EntryRecord;
  };
  return { employee, business, recordId: business.record.id };
}

export async function entryRecords(w: EntryWorld, employeeId: string): Promise<EntryRecord[]> {
  return (await w.session.records(employeeId, '2026-12-31')) as unknown as EntryRecord[];
}

/** 当前业务头 revision（动作路由的 If-Match）。 */
export async function businessRevision(w: EntryWorld, businessId: string): Promise<number> {
  const response = await w.session.request('GET', `/businesses/${businessId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { revision: number }).revision;
}

export async function entryAction(
  w: EntryWorld,
  recordId: string,
  action: 'complete' | 'cancel' | 'postpone',
  body: object,
  revision?: number,
) {
  return w.session.request('POST', `/pending-entries/${recordId}/${action}`, {
    ifMatch: revision ?? (await businessRevision(w, recordId)),
    body,
  });
}

export async function disableOrg(w: EntryWorld, orgId: string, revision: number, effectiveDate: string) {
  const response = await tenantApi(w.db).request('PATCH', `/api/tenant/org/organizations/${orgId}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: revision,
    body: { enabled: false, effectiveDate },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

export function portContext(w: EntryWorld, expectedRevision: number): EmploymentContext {
  return {
    tenantId: w.session.tenant.id,
    userId: w.session.user.id,
    timezone: w.session.tenant.timezone,
    now: new Date('2026-10-01T01:00:00Z'),
    commandId: randomUUID(),
    expectedRevision,
  };
}

export async function entryActionRows(w: EntryWorld) {
  return withTenant(w.db, w.session.tenant.id, async (tx) => {
    const result = await tx.execute(sql`SELECT action, reason_code AS "reasonCode", remark,
      from_date::text AS "fromDate", to_date::text AS "toDate", business_id AS "businessId",
      previous_business_id AS "previousBusinessId" FROM employment_entry_actions
      WHERE tenant_id=${w.session.tenant.id} ORDER BY created_at, id`);
    return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Record<string, unknown>[];
  });
}
