import { randomUUID } from 'node:crypto';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

export const JOB_TODAY = '2026-10-01';

export interface JobRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly startDate: string;
  readonly stopDate: string;
  readonly [field: string]: unknown;
}

export async function jobSession(db: Db, label: string) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock: () => new Date(`${JOB_TODAY}T01:00:00.000Z`) });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/job${path}`, {
      ...options,
      user: member.user.id,
      tenant: member.tenant.id,
    });

  async function create(kind: string, name: string, extra: Record<string, unknown> = {}): Promise<JobRecord> {
    const response = await request('POST', `/${kind}`, {
      ifMatch: 0,
      body: { name, code: `J${randomUUID().replaceAll('-', '')}`, startDate: JOB_TODAY, ...extra },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as JobRecord;
  }

  async function detail(kind: string, id: string, asOf = JOB_TODAY): Promise<JobRecord> {
    const response = await request('GET', `/${kind}/${id}?asOf=${asOf}`);
    expect(response.status).toBe(200);
    return (await response.json()) as JobRecord;
  }

  async function list(kind: string, query: Record<string, string> = {}): Promise<JobRecord[]> {
    const params = new URLSearchParams({ asOf: JOB_TODAY, ...query });
    const response = await request('GET', `/${kind}?${params.toString()}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: JobRecord[] }).items;
  }

  async function org(name: string): Promise<{ id: string; name: string; revision: number }> {
    const response = await api.request('POST', '/api/tenant/org/organizations', {
      user: member.user.id,
      tenant: member.tenant.id,
      ifMatch: 0,
      body: { name, parents: { admin: { parentId: member.tenant.id } } },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; name: string; revision: number };
  }

  return { ...member, request, create, detail, list, org };
}

export type JobSession = Awaited<ReturnType<typeof jobSession>>;
