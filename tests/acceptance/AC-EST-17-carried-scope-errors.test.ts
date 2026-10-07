import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof carriedWorld>>;
type Person = Awaited<ReturnType<World['hired']>>;
const absent = { error: { code: 'NOT_FOUND', message: '编制在该时点不存在' } };

function restrictedSave(w: World, person: Person, hidden: 'from' | 'to' | 'creator') {
  const authorize: Authorizer = () => true;
  registerScopeProvider(authorize, {
    scope: async (query) => {
      if (query.objectCode === MODULE_OBJECTS.establishment.code && hidden === 'creator')
        return {
          ...EMPTY_SCOPE,
          hasDataPermission: true,
          terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: w.session.user.id }],
        };
      const orgIds =
        query.objectCode === MODULE_OBJECTS.establishment.code
          ? [w[hidden === 'from' ? 'to' : 'from'].id]
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
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
  return (extra: Record<string, unknown> = {}) =>
    api.request('POST', `/api/tenant/employment/transfers/employees/${person.employee.id}`, {
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
        ...extra,
      },
    });
}

async function anotherScheme(w: World, orgId: string, periodType = 'annual') {
  const created = await w.write('establishment/schemes', {
    name: '合成范围外方案',
    periodType,
    maintenanceMode: 'local',
    startDate: '2026-01-01',
  });
  expect(created.status).toBe(201);
  const scheme = (await created.json()) as { id: string };
  const capacity = await w.write('establishment/capacities', {
    orgId,
    schemeId: scheme.id,
    periodStart: periodType === 'annual' ? '2026-01-01' : '2026-10-01',
    localCapacity: 5,
  });
  expect(capacity.status, await capacity.clone().text()).toBe(201);
}

async function exclude(w: World, orgId: string) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const response = await api.request('PATCH', `/api/tenant/establishment/schemes/${w.scheme.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: 1,
    body: { effectiveDate: '2026-10-01', excludedOrgIds: [orgId] },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

it.each(['from', 'to'] as const)('AC-EST-17 %s 范围外新增方案前后，同一调动返回相同 404', async (hidden) => {
  const w = await carriedWorld(database().db, `scope-ambiguous-${hidden}`);
  const person = await w.hired();
  const save = restrictedSave(w, person, hidden);
  const first = await save();
  expect(first.status).toBe(404);
  expect(await first.json()).toEqual(absent);
  await anotherScheme(w, w[hidden].id);
  const before = await w.capacities();
  const control = await w.save(person);
  expect(control.status).toBe(409);
  expect(await control.json()).toMatchObject({ error: { details: { reason: 'ESTABLISHMENT_SCHEME_AMBIGUOUS' } } });
  const second = await save();
  expect(second.status, await second.clone().text()).toBe(404);
  expect(await second.json()).toEqual(absent);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual([]);
});

const paths = ['subdivision', 'missing', 'scheme', 'period', 'no-capacity'] as const;
it.each(['from', 'to'].flatMap((hidden) => paths.map((path) => ({ hidden: hidden as 'from' | 'to', path }))))(
  'AC-EST-17 $hidden 范围外时不暴露 $path 提前校验结果',
  async ({ hidden, path }) => {
    const w = await carriedWorld(database().db, `scope-${hidden}-${path}`);
    const person = await w.hired();
    if (path !== 'subdivision' && path !== 'no-capacity') await exclude(w, w[hidden].id);
    if (path === 'scheme' || path === 'period')
      await anotherScheme(w, w[hidden].id, path === 'period' ? 'monthly' : 'annual');
    const extra =
      path === 'subdivision'
        ? { fields: { departmentId: w.to.id, positionId: null } }
        : path === 'no-capacity'
          ? { effectiveDate: '2027-10-05' }
          : {};
    const before = await w.capacities();
    const control = await w.save(person, extra);
    expect(control.status, await control.clone().text()).toBe(409);
    expect(await control.json()).toMatchObject({
      error: {
        details: {
          reason: path === 'subdivision' ? 'ESTABLISHMENT_TARGET_SUBDIVISION_REQUIRED' : 'ESTABLISHMENT_PAIR_REQUIRED',
        },
      },
    });
    const response = await restrictedSave(w, person, hidden)(extra);
    expect(response.status, await response.clone().text()).toBe(404);
    expect(await response.json()).toEqual(absent);
    expect(await w.capacities()).toEqual(before);
    expect(await w.history()).toEqual([]);
  },
);

it('AC-EST-17 前置编制范围校验保留对象创建人授权', async () => {
  const w = await carriedWorld(database().db, 'scope-carried-creator');
  const response = await restrictedSave(w, await w.hired(), 'creator')();
  expect(response.status, await response.clone().text()).toBe(201);
  expect((await w.capacities()).map((c) => c.localCapacity)).toEqual([2, 1]);
});
