import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

export const ORG_TODAY = '2026-10-01';
const clock = () => new Date('2026-10-01T01:00:00.000Z');

export interface OrgParent {
  readonly parentId: string;
  readonly sequence?: number | null;
}

export interface OrgParents {
  readonly admin: OrgParent;
  readonly business?: OrgParent;
  readonly product?: OrgParent;
  readonly reserve4?: OrgParent;
  readonly reserve5?: OrgParent;
}

export interface Organization {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly fullName: string;
  readonly broadType: string;
  readonly startDate: string;
  readonly stopDate: string;
  readonly enabled: boolean;
  readonly revision: number;
  readonly parents: OrgParents;
}

export interface Reservation {
  readonly id: string;
  readonly code: string;
  readonly revision: number;
}

export async function orgSession(db: Db, label: string) {
  const member = await seedTenantWithMember(db, label);
  const api = tenantApi(db, { clock });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/org${path}`, {
      ...options,
      user: member.user.id,
      tenant: member.tenant.id,
    });

  async function reserve(): Promise<Reservation> {
    const response = await request('POST', '/code-reservations', { ifMatch: 0, body: {} });
    expect(response.status).toBe(201);
    return (await response.json()) as Reservation;
  }

  async function create(name: string, extra: Record<string, unknown> = {}): Promise<Organization> {
    const response = await request('POST', '/organizations', {
      ifMatch: 0,
      body: { name, parents: { admin: { parentId: member.tenant.id } }, ...extra },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Organization;
  }

  async function list(name?: string, asOf = ORG_TODAY): Promise<Organization[]> {
    const query = new URLSearchParams({ asOf });
    if (name !== undefined) query.set('name', name);
    const response = await request('GET', `/organizations?${query.toString()}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: Organization[] }).items;
  }

  return { ...member, request, reserve, create, list };
}

export type OrgSession = Awaited<ReturnType<typeof orgSession>>;

export function resultRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
}
