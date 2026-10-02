import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

export const EMP_TODAY = '2026-10-01';

export interface Employee {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'pending' | 'employed' | 'left' | 'retired';
  readonly revision: number;
}

export interface EmploymentRecord {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly entryDate: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly stopDate: string;
  readonly previousRecordId: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly customFields: Readonly<Record<string, unknown>>;
  readonly isCurrent: boolean;
  readonly isLatest: boolean;
  readonly status: 'effective';
  readonly isInserted: boolean;
  readonly before?: unknown;
}

export interface EmploymentBusiness {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly employeeRevision: number;
  readonly status: 'draft' | 'in_review' | 'approved' | 'rejected' | 'effective' | 'deleted';
  readonly kind: string;
  readonly effectiveDate: string;
  readonly record: EmploymentRecord | null;
}

export async function employmentSession(db: Db, label: string, options: { timezone?: string } = {}) {
  const member = await seedTenantWithMember(db, label, options.timezone);
  let now = new Date(`${EMP_TODAY}T01:00:00.000Z`);
  const api = tenantApi(db, { clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/employment${path}`, {
      ...options,
      user: member.user.id,
      tenant: member.tenant.id,
    });

  async function employee(name = '合成员工', code = `EMP_${randomUUID().replaceAll('-', '')}`): Promise<Employee> {
    const response = await request('POST', '/employees', { ifMatch: 0, body: { name, code } });
    expect(response.status).toBe(201);
    const created = (await response.json()) as Employee;
    expect(created.id).not.toBe(member.user.id);
    return created;
  }

  async function getEmployee(id: string): Promise<Employee> {
    const response = await request('GET', `/employees/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Employee;
  }

  async function business(
    employeeId: string,
    body: Record<string, unknown>,
    revision: number,
  ): Promise<EmploymentBusiness> {
    const response = await request('POST', `/employees/${employeeId}/businesses`, { ifMatch: revision, body });
    expect(response.status).toBe(201);
    return (await response.json()) as EmploymentBusiness;
  }

  async function records(employeeId: string, asOf = EMP_TODAY): Promise<EmploymentRecord[]> {
    const response = await request('GET', `/employees/${employeeId}/records?asOf=${asOf}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: EmploymentRecord[] }).items;
  }

  async function record(recordId: string, asOf = EMP_TODAY): Promise<EmploymentRecord> {
    const response = await request('GET', `/records/${recordId}?asOf=${asOf}`);
    expect(response.status).toBe(200);
    return (await response.json()) as EmploymentRecord;
  }

  async function org(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; name: string; revision: number }> {
    const response = await api.request('POST', '/api/tenant/org/organizations', {
      user: member.user.id,
      tenant: member.tenant.id,
      ifMatch: 0,
      body: { name, parents: { admin: { parentId: member.tenant.id } }, ...extra },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; name: string; revision: number };
  }

  return {
    ...member,
    request,
    employee,
    getEmployee,
    business,
    records,
    record,
    org,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

export type EmploymentSession = Awaited<ReturnType<typeof employmentSession>>;
