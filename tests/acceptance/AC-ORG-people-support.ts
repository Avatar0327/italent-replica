/**
 * F-005 / F-006 共用的 HTTP 装配：同一租户、同一成员下的组织、职务体系与真实任职数据。
 * 日期一律不早于 TODAY，组织不传设立日期时首个版本就从 TODAY 起，入职与任职都落在组织生效期内。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession, type EmploymentRecord } from './AC-EMP-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export const TODAY = '2026-10-01';

export interface Organization {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly startDate: string;
  readonly stopDate: string;
  readonly establishedOn: string | null;
  readonly [field: string]: unknown;
}

export interface JobObject {
  readonly id: string;
  readonly revision: number;
  readonly [field: string]: unknown;
}

export interface HiredEmployee {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly revision: number;
  readonly recordId: string;
}

export interface SyncedRecord extends EmploymentRecord {
  readonly changeType?: string | null;
}

export async function orgPeopleWorld(db: Db, label: string) {
  const session = await employmentSession(db, label);
  const api = tenantApi(db, { clock: () => new Date(`${TODAY}T01:00:00.000Z`) });
  const as = { user: session.user.id, tenant: session.tenant.id };
  const call = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/${path}`, { ...options, ...as });

  async function org(name: string, parentId = session.tenant.id, extra: Record<string, unknown> = {}) {
    const response = await call('POST', 'org/organizations', {
      ifMatch: 0,
      body: { name, parents: { admin: { parentId } }, ...extra },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as Organization;
  }

  function patchOrg(target: { id: string; revision: number }, body: Record<string, unknown>) {
    return call('PATCH', `org/organizations/${target.id}`, { ifMatch: target.revision, body });
  }

  /** 含停用组织的时点快照，按 ID 取。 */
  async function orgsAt(asOf: string): Promise<Map<string, Organization>> {
    const response = await call('GET', `org/organizations?asOf=${asOf}&includeDisabled=true&pageSize=200`);
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: Organization[] }).items;
    return new Map(items.map((item) => [item.id, item]));
  }

  async function job(kind: string, name: string, extra: Record<string, unknown> = {}): Promise<JobObject> {
    const response = await call('POST', `job/${kind}`, {
      ifMatch: 0,
      body: { name, code: `J${randomUUID().replaceAll('-', '')}`, startDate: TODAY, ...extra },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as JobObject;
  }

  async function hire(name: string, fields: Record<string, unknown>, effectiveDate = TODAY): Promise<HiredEmployee> {
    const employee = await session.employee(name);
    const hired = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate, fields: { employType: 'internal', ...fields } },
      employee.revision,
    );
    return { id: employee.id, code: employee.code, name, revision: hired.employeeRevision, recordId: hired.id };
  }

  async function employmentRecords(employeeId: string, asOf = TODAY): Promise<SyncedRecord[]> {
    return (await session.records(employeeId, asOf)) as SyncedRecord[];
  }

  return { ...session, call, org, patchOrg, orgsAt, job, hire, employmentRecords };
}

export type OrgPeopleWorld = Awaited<ReturnType<typeof orgPeopleWorld>>;

export function resultRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}

/** 读审计（只读，按租户 RLS）：动作与对象 ID。 */
export async function auditActions(db: Db, tenantId: string, objectId: string): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ action: string }>(
      await tx.execute(sql`SELECT action FROM audit_events WHERE object_id = ${objectId} ORDER BY occurred_at, id`),
    ).map((row) => row.action),
  );
}
