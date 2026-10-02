import { randomUUID } from 'node:crypto';
import { type Db, withTenant } from '@italent/db';
import { expect, vi } from 'vitest';
import type { EstablishmentPersonnelPort } from '../../apps/api/src/modules/establishment/personnel.js';
import { orgSession } from './AC-ORG-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export const EST_NOW = new Date('2026-10-01T01:00:00.000Z');

export interface EstablishmentScheme {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly periodType: 'annual' | 'quarterly' | 'monthly';
  readonly maintenanceMode: 'local' | 'inclusive' | 'both';
}

export interface Capacity {
  readonly id: string;
  readonly revision: number;
  readonly orgId: string;
  readonly schemeId: string;
  readonly periodStart: string;
  readonly localCapacity: number | null;
  readonly inclusiveCapacity: number | null;
  readonly strictControl: boolean;
}

export interface CopyJob {
  readonly id: string;
  readonly revision: number;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly attempts: number;
  readonly failureReason: string | null;
}

export async function establishmentSession(db: Db, label: string) {
  const organization = await orgSession(db, label);
  const api = tenantApi(db, { clock: () => EST_NOW });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/establishment${path}`, {
      ...options,
      user: organization.user.id,
      tenant: organization.tenant.id,
    });
  const create = (name: string, extra: Record<string, unknown> = {}) =>
    organization.create(name, { startDate: '2026-01-01', ...extra });

  async function scheme(extra: Record<string, unknown> = {}): Promise<EstablishmentScheme> {
    const response = await request('POST', '/schemes', {
      ifMatch: 0,
      body: {
        name: '验收编制方案',
        periodType: 'annual',
        startMonth: 1,
        maintenanceMode: 'local',
        subdivision: 'none',
        startDate: '2026-01-01',
        ...extra,
      },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as EstablishmentScheme;
  }

  async function capacity(orgId: string, schemeId: string, extra: Record<string, unknown> = {}): Promise<Capacity> {
    const response = await request('POST', '/capacities', {
      ifMatch: 0,
      body: { orgId, schemeId, periodStart: '2026-01-01', localCapacity: 10, strictControl: false, ...extra },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as Capacity;
  }

  async function capacities(query: Record<string, string> = {}): Promise<Capacity[]> {
    const response = await request('GET', `/capacities?${new URLSearchParams(query).toString()}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: Capacity[] }).items;
  }

  return { ...organization, create, request, scheme, capacity, capacities };
}

export type EstablishmentSession = Awaited<ReturnType<typeof establishmentSession>>;

/** R1-T05/T09 尚未接入；以服务端可信人员接口替身测试真实编制服务与数据库。 */
export async function transferFixture(
  db: Db,
  label: string,
  options: {
    strictControl?: boolean;
    targetCount?: number;
    targetCapacity?: number;
    transferIn?: 'submitted' | 'approved';
    transferOut?: 'submitted' | 'approved';
  } = {},
) {
  const session = await establishmentSession(db, label);
  const source = await session.create('调出部门');
  const target = await session.create('调入部门');
  const scheme = await session.scheme();
  await session.capacity(source.id, scheme.id, { localCapacity: 20 });
  await session.capacity(target.id, scheme.id, {
    localCapacity: options.targetCapacity ?? 10,
    strictControl: options.strictControl ?? false,
  });
  const settings = await session.request('PUT', '/settings', {
    ifMatch: 0,
    body: { transferIn: options.transferIn ?? 'submitted', transferOut: options.transferOut ?? 'submitted' },
  });
  expect(settings.status).toBe(200);

  const businessId = randomUUID();
  const employeeId = randomUUID();
  const counts = new Map([
    [source.id, 10],
    [target.id, options.targetCount ?? 10],
  ]);
  const transfers = new Map([
    [
      businessId,
      { businessId, employeeId, sourceOrgId: source.id, targetOrgId: target.id, effectiveDate: '2026-10-02' },
    ],
  ]);
  const port: EstablishmentPersonnelPort = {
    readTransfer: vi.fn(async (_tx, query) => {
      expect(query.tenantId).toBe(session.tenant.id);
      const transfer = transfers.get(query.businessId);
      if (!transfer) throw new Error('可信人员接口找不到业务单');
      return transfer;
    }),
    headcount: vi.fn(async (_tx, query) => {
      expect(query.tenantId).toBe(session.tenant.id);
      return counts.get(query.orgId) ?? 0;
    }),
    applyTransfer: vi.fn(async () => undefined),
  };

  let now = EST_NOW;
  const advanceTo = (value: Date) => {
    now = value;
  };
  const context = (expectedRevision = 0) => ({
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now,
    commandId: randomUUID(),
    expectedRevision,
  });

  async function apply(
    stage: 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'effective',
    expectedRevision = 0,
    confirmed = false,
    id = businessId,
  ) {
    const service = await import('../../apps/api/src/modules/establishment/transfer-service.js');
    return withTenant(db, session.tenant.id, (tx) =>
      service.applyTransferStage(tx, context(expectedRevision), { businessId: id, stage, confirmed }, port),
    );
  }

  async function stats(orgId = target.id) {
    const service = await import('../../apps/api/src/modules/establishment/transfer-service.js');
    return withTenant(db, session.tenant.id, (tx) =>
      service.readEstablishmentStats(tx, context(), { orgId, schemeId: scheme.id, periodStart: '2026-01-01' }, port),
    );
  }

  function addTransfer() {
    const id = randomUUID();
    transfers.set(id, { ...transfers.get(businessId)!, businessId: id, employeeId: randomUUID() });
    return id;
  }

  return {
    ...session,
    source,
    target,
    scheme,
    port,
    counts,
    businessId,
    context,
    apply,
    stats,
    addTransfer,
    advanceTo,
  };
}
