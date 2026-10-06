import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { carriedWorld } from './AC-TRF-37-EST-08-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const OBJECT = MODULE_OBJECTS.establishment.code;
type World = Awaited<ReturnType<typeof carriedWorld>>;
interface Grant {
  orgIds?: readonly string[];
  editable?: boolean;
  revokeAfterWrites?: number;
}
function restricted(w: World, grant: Grant) {
  let writes = 0;
  const authorize: Authorizer = (request) => {
    if (request.resource !== OBJECT || request.action !== 'object.update') return true;
    writes++;
    return (
      !(grant.editable === false && request.fields?.includes('localCapacity')) &&
      writes <= (grant.revokeAfterWrites ?? Infinity)
    );
  };
  registerScopeProvider(authorize, {
    scope: async (query) => {
      const orgIds = query.objectCode === OBJECT ? (grant.orgIds ?? [w.from.id, w.to.id]) : [w.from.id, w.to.id];
      return {
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        orgIds,
        terms: [{ dimension: 'organization', orgIds, personIds: [] }],
      };
    },
    authorize: async (request, tx) => {
      if (request.resource === OBJECT && request.action === 'object.update') expect(tx).toBeDefined();
      return authorize(request);
    },
    fields: async () => new Set(['id', 'employeeId', 'revision', 'status', 'fields', 'record']),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00Z') });
  return (method: string, path: string, revision: number, body: object, key = randomUUID()) =>
    api.request(method, `/api/tenant/employment${path}`, {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: revision,
      idempotencyKey: key,
      body,
    });
}
function input(w: World) {
  return {
    initiator: 'hr',
    transferTypeCode: 'cross_department',
    mode: 'direct',
    effectiveDate: '2026-10-05',
    withEstablishment: true,
    fields: { departmentId: w.to.id, positionId: w.targetPosition },
  };
}

it.each(['scope', 'fields'] as const)('AC-EST-14 调入选择例外不授予编制 %s 写权限', async (kind) => {
  const w = await carriedWorld(database().db, `carried-deny-${kind}`);
  const person = await w.hired();
  const before = await w.capacities();
  const request = restricted(w, kind === 'scope' ? { orgIds: [w.from.id] } : { editable: false });
  const result = await request(
    'POST',
    `/transfers/employees/${person.employee.id}`,
    person.hire.employeeRevision,
    input(w),
  );
  expect(result.status, await result.clone().text()).toBe(kind === 'scope' ? 404 : 403);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual([]);
});

it.each(['delete', 'revoke'] as const)('AC-EST-14 %s 回退前检查编制范围，拒绝时整体保持原状', async (action) => {
  const w = await carriedWorld(database().db, `carried-rollback-scope-${action}`);
  const saved = await w.save(await w.hired(), action === 'revoke' ? { mode: 'application', submit: true } : {});
  expect(saved.status).toBe(201);
  const business = (await saved.json()) as { id: string; revision: number };
  const before = await w.capacities();
  const history = await w.history();
  const request = restricted(w, { orgIds: [w.from.id] });
  const result = await request(
    action === 'delete' ? 'DELETE' : 'POST',
    `/businesses/${business.id}${action === 'delete' ? '' : '/revoke'}`,
    business.revision,
    {},
  );
  expect(result.status, await result.clone().text()).toBe(404);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual(history);
});

it.each(['scope', 'fields'] as const)('AC-EST-14 编制 %s 撤权后原命令重放被拒', async (kind) => {
  const w = await carriedWorld(database().db, `carried-replay-${kind}`);
  const person = await w.hired();
  const grant: Grant = {};
  const request = restricted(w, grant);
  const key = randomUUID();
  const save = () =>
    request('POST', `/transfers/employees/${person.employee.id}`, person.hire.employeeRevision, input(w), key);
  const first = await save();
  expect(first.status, await first.clone().text()).toBe(201);
  const before = await w.capacities();
  const history = await w.history();
  if (kind === 'scope') grant.orgIds = [w.from.id];
  else grant.editable = false;
  const replay = await save();
  expect(replay.status, await replay.clone().text()).toBe(kind === 'scope' ? 404 : 403);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual(history);
});

it('AC-EST-14 两侧写入后命令尾部复查编制权限，撤权整单回滚', async () => {
  const w = await carriedWorld(database().db, 'carried-final-authorization');
  const person = await w.hired();
  const before = await w.capacities();
  const result = await restricted(w, { revokeAfterWrites: 2 })(
    'POST',
    `/transfers/employees/${person.employee.id}`,
    person.hire.employeeRevision,
    input(w),
  );
  expect(result.status, await result.clone().text()).toBe(403);
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual([]);
});
