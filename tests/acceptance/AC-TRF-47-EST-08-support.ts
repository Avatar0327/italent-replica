import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';
import { readCapacity } from '../../apps/api/src/modules/establishment/capacity-read.js';
import { rowsOf } from '../../apps/api/src/modules/establishment/store.js';

export async function carriedWorld(db: Db, label: string, options: { matched?: boolean; reserve?: number } = {}) {
  const w = await activationWorld(db, label);
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const write = (path: string, body: object) =>
    api.request('POST', `/api/tenant/${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body,
    });
  const postResponse = await write('job/posts', { name: '合成职务', code: randomUUID(), startDate: '2026-01-01' });
  expect(postResponse.status).toBe(201);
  const post = (await postResponse.json()) as { id: string };
  async function position(orgId: string) {
    const response = await write('job/positions', {
      name: '合成职位',
      code: randomUUID(),
      postId: post.id,
      orgId,
      startDate: '2026-01-01',
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const sourcePosition = await position(w.from.id);
  const targetPosition = await position(w.to.id);
  const schemeResponse = await write('establishment/schemes', {
    name: '带编验收方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    subdivision: 'position',
    startDate: '2026-01-01',
  });
  expect(schemeResponse.status).toBe(201);
  const scheme = (await schemeResponse.json()) as { id: string };
  async function capacity(orgId: string, positionId: string, count: number, reserve: number) {
    const response = await write('establishment/capacities', {
      orgId,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      strictControl: true,
      reservedLocal: reserve,
      subdivisions: [{ positionId, localCapacity: count, inclusiveCapacity: null }],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  const sourceCapacity = await capacity(w.from.id, sourcePosition, 2, options.reserve ?? 1);
  const targetCapacity = await capacity(w.to.id, targetPosition, 0, 0);
  async function hired(name = '带编员工') {
    const employee = await w.session.employee(name);
    const hire = await w.session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: w.from.id, positionId: options.matched === false ? null : sourcePosition },
      },
      employee.revision,
    );
    return { employee, hire };
  }
  async function save(person: Awaited<ReturnType<typeof hired>>, extra: Record<string, unknown> = {}) {
    return w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
      ifMatch: (await w.session.getEmployee(person.employee.id)).revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        fields: { departmentId: w.to.id, positionId: targetPosition },
        withEstablishment: true,
        ...extra,
      },
    });
  }
  const capacities = () =>
    withTenant(db, w.session.tenant.id, async (tx) =>
      Promise.all(
        [sourceCapacity, targetCapacity].map((id) => readCapacity(tx, w.session.tenant.id, id, '2026-10-01')),
      ),
    );
  const history = () =>
    withTenant(db, w.session.tenant.id, async (tx) =>
      rowsOf<{ action: string; after: unknown }>(
        await tx.execute(sql`SELECT action,after FROM audit_events WHERE tenant_id=${w.session.tenant.id}
      AND action LIKE 'establishment.transfer.%' ORDER BY occurred_at,id`),
      ),
    );
  return {
    ...w,
    hired,
    save,
    capacities,
    history,
    sourcePosition,
    targetPosition,
    sourceCapacity,
    targetCapacity,
    write,
    scheme,
  };
}
