import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, grantMembership } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof carriedWorld>>;
const absent = { error: { code: 'NOT_FOUND', message: '编制在该时点不存在' } };
const clock = () => new Date('2026-10-01T01:00:00Z');

function scopedApi(w: World, scope: 'from' | 'to' | 'creator', creatorId = w.session.user.id) {
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) => {
      if (query.objectCode === MODULE_OBJECTS.establishment.code && scope === 'creator')
        return {
          ...EMPTY_SCOPE,
          hasDataPermission: true,
          terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId }],
        };
      const orgIds =
        query.objectCode === MODULE_OBJECTS.establishment.code && scope !== 'creator'
          ? [w[scope].id]
          : [w.from.id, w.to.id];
      return {
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds,
        terms: [{ dimension: 'organization', orgIds, personIds: [] }],
      };
    },
    authorize: async (request, tx) => {
      expect(tx).toBeDefined();
      return authorize(request);
    },
    fields: async () => new Set(['id', 'employeeId', 'revision', 'status', 'fields', 'record']),
  });
  return tenantApi(w.db, { authorize, clock });
}

it.each([
  { action: 'delete', scope: 'from' },
  { action: 'delete', scope: 'to' },
  { action: 'revoke', scope: 'from' },
  { action: 'revoke', scope: 'to' },
] as const)('AC-EST-18 $action 仅有 $scope 侧范围时，回退额度变化前后返回一致 404', async ({ action, scope }) => {
  const w = await carriedWorld(database().db, `reverse-errors-${action}-${scope}`);
  const saved = await w.save(await w.hired(), action === 'revoke' ? { mode: 'application', submit: true } : {});
  expect(saved.status).toBe(201);
  const business = (await saved.json()) as { id: string; revision: number };
  const api = scopedApi(w, scope as 'from' | 'to');
  const request = () =>
    api.request(
      action === 'delete' ? 'DELETE' : 'POST',
      `/api/tenant/employment/businesses/${business.id}${action === 'delete' ? '' : '/revoke'}`,
      { user: w.session.user.id, tenant: w.session.tenant.id, ifMatch: business.revision, body: {} },
    );
  const first = await request();
  expect(first.status).toBe(404);
  expect(await first.json()).toEqual(absent);
  const [, target] = await w.capacities();
  const changed = await tenantApi(w.db, { clock }).request(
    'PATCH',
    `/api/tenant/establishment/capacities/${target!.id}`,
    {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: target!.revision,
      body: {
        effectiveDate: '2026-10-01',
        strictControl: false,
        subdivisions: [{ positionId: w.targetPosition, localCapacity: 0, inclusiveCapacity: null }],
      },
    },
  );
  expect(changed.status, await changed.clone().text()).toBe(200);
  const before = await w.capacities();
  const history = await w.history();
  const control = await w.session.request(
    action === 'delete' ? 'DELETE' : 'POST',
    `/businesses/${business.id}${action === 'delete' ? '' : '/revoke'}`,
    { ifMatch: business.revision, body: {} },
  );
  expect(control.status).toBe(409);
  expect(await control.json()).toMatchObject({
    error: { details: { reason: 'ESTABLISHMENT_CAPACITY_INSUFFICIENT' } },
  });
  const second = await request();
  expect(second.status, await second.clone().text()).toBe(404);
  expect(await second.json()).toEqual(absent);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual(history);
});

async function otherOwnedCapacity(w: World, variant: 'scheme' | 'capacity' | 'active') {
  const user = await createUser(
    w.db,
    { email: `capacity-${randomUUID()}@example.com`, displayName: '合成其他创建人' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
  const api = tenantApi(w.db, { clock });
  const write = (path: string, body: object) =>
    api.request('POST', `/api/tenant/establishment/${path}`, {
      user: user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body,
    });
  const schemeResponse = await write('schemes', {
    name: '其他创建人的方案',
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: variant === 'scheme' ? '2026-11-01' : '2026-01-01',
  });
  expect(schemeResponse.status).toBe(201);
  const scheme = (await schemeResponse.json()) as { id: string };
  // F-484（DEC-295①）：from / to 已有本方案的 2026 年度编制，别人用另一方案在同组织同期间建编制一律被拒，
  // “他人创建的第二候选”在写入侧不再可能出现。
  for (const orgId of [w.from.id, w.to.id]) {
    const capacity = await write('capacities', {
      schemeId: scheme.id,
      orgId,
      periodStart: '2026-01-01',
      effectiveDate: variant === 'active' ? '2026-10-01' : '2026-11-01',
      localCapacity: 5,
    });
    expect(capacity.status, await capacity.clone().text()).toBe(409);
    expect(await capacity.json()).toMatchObject({
      error: { code: 'CONFLICT', details: { reason: 'CAPACITY_PERIOD_OVERLAP' } },
    });
  }
}

it.each(['scheme', 'capacity', 'active'] as const)(
  'AC-EST-19 创建人范围下，他人用另一方案（%s 变体）无法在同组织同期间建编制，调动按原编制正常落地',
  async (variant) => {
    const w = await carriedWorld(database().db, `creator-time-${variant}`);
    const person = await w.hired();
    await otherOwnedCapacity(w, variant);
    const result = await scopedApi(w, 'creator').request(
      'POST',
      `/api/tenant/employment/transfers/employees/${person.employee.id}`,
      {
        user: w.session.user.id,
        tenant: w.session.tenant.id,
        ifMatch: person.hire.employeeRevision,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'direct',
          effectiveDate: '2026-10-05',
          withEstablishment: true,
          fields: { departmentId: w.to.id, positionId: w.targetPosition },
        },
      },
    );
    expect(result.status, await result.clone().text()).toBe(201);
    expect((await w.capacities()).map((c) => c.localCapacity)).toEqual([2, 1]);
    expect(await w.history()).toHaveLength(2);
  },
);

// F-484 复审 P3-1：重叠校验消除了“他人创建的第二候选”，但“唯一参与的编制由他人创建”仍可合法存在，创建人范围负例须保留
it('AC-EST-19 创建人范围下，唯一参与的编制由他人创建时调动返回 404，编制与历史均无写入', async () => {
  const w = await carriedWorld(database().db, 'creator-only-other');
  const person = await w.hired();
  const member = await createUser(
    w.db,
    { email: `capacity-${randomUUID()}@example.com`, displayName: '合成另一执行成员' },
    cmd(),
  );
  await grantMembership(w.db, { tenantId: w.session.tenant.id, userId: member.id, expectedRevision: 0 }, cmd());
  const before = await w.capacities();
  const result = await scopedApi(w, 'creator', member.id).request(
    'POST',
    `/api/tenant/employment/transfers/employees/${person.employee.id}`,
    {
      user: member.id,
      tenant: w.session.tenant.id,
      ifMatch: person.hire.employeeRevision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'cross_department',
        mode: 'direct',
        effectiveDate: '2026-10-05',
        withEstablishment: true,
        fields: { departmentId: w.to.id, positionId: w.targetPosition },
      },
    },
  );
  expect(result.status, await result.clone().text()).toBe(404);
  expect(await result.json()).toEqual(absent);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual([]);
});
