import { routeManifest } from '@italent/api';
import { and, eq, auditEvents, commandLedger, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, expect, it } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { controlledApi } from './AC-LNK-support.js';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import { ESIGN, SCENES, START, sharedWorld } from './AC-ESIGN-F505-s2-support.js';
import { tenantApi, seedTenantWithMember } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  readFrozenRecorded,
  writeFrozenRecorded,
} from './support/route-policy/recorded.js';
import { ESIGN_SOURCE_SETTINGS } from './support/route-policy/required/declared/esign.js';

const db = useTestDb();
const recorder = createRecorder();
const SETTINGS = 'TenantBase.ESignSettings';
const endpoints = new Set(
  ESIGN_SOURCE_SETTINGS.flatMap((scene) => ['GET', 'PUT'].map((method) => `${method} ${ESIGN}/scenes/${scene}`)),
);

afterAll(() => {
  const contract = readFrozenContract();
  expect(contract).toBeDefined();
  const routes = routeManifest(tenantApi(db().db).app).declared;
  const keys = routes
    .filter((r) => /^\/api\/tenant\/esign\/scenes\/(offer|entry)$/.test(r.path))
    .map((r) => `${r.method} ${r.path}`);
  expect(new Set(keys)).toEqual(endpoints);
  for (const key of endpoints) expect(contract!.routes[key], key).toBeDefined();
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  const findings = checkRecorded({
    collected: recorder.facts,
    frozen: current,
    scope: endpoints,
    routes,
    contract: contract!,
  });
  expect(findings).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});

it.each(SCENES)('AC-22 %s 四个固定端点的当前权限、字段、命令台账与事务前提证据', async (scene) => {
  const w = await sharedWorld(db().db, `evidence-${scene}`);
  const relative = `/scenes/${scene}`;
  const path = ESIGN + relative;
  const read = `GET ${path}`;
  const write = `PUT ${path}`;
  const input = { validityDays: 30, remindBeforeExpiry: true };
  const defaults = { scene, validityDays: 2, remindBeforeExpiry: false, revision: 0 };
  const snapshot = async (key: string) =>
    withTenant(w.db, w.tenantId, async (tx) => ({
      ledger: (
        await tx
          .select({ status: commandLedger.responseStatus })
          .from(commandLedger)
          .where(and(eq(commandLedger.tenantId, w.tenantId), eq(commandLedger.commandId, key)))
      ).map((r) => r.status),
      audit: (
        await tx
          .select({ action: auditEvents.action })
          .from(auditEvents)
          .where(and(eq(auditEvents.tenantId, w.tenantId), eq(auditEvents.commandId, key)))
      ).map((r) => r.action),
    }));
  const readRes = await w.call('GET', relative);
  expect(await json(readRes.clone())).toEqual(defaults);
  recorder.recordFact(read, 'outcome', await observe(readRes));
  recorder.recordFact(read, 'fixedKeys', await observe(readRes));
  const denied = w.restricted((q) => q.resource !== SETTINGS);
  const deniedRead = await denied('GET', relative);
  const deniedWrite = await denied('PUT', relative, { ifMatch: 0, body: input });
  await reason(deniedRead.clone(), 'FORBIDDEN', 403);
  await reason(deniedWrite.clone(), 'FORBIDDEN', 403);
  recorder.recordFact(read, 'outcome', await observe(deniedRead));
  recorder.recordFact(write, 'outcome', await observe(deniedWrite));

  const cropped = controlledApi(
    w.db,
    w.tenantId,
    w.userId,
    { fields: { [SETTINGS]: ['validityDays'] } },
    START.toISOString(),
  );
  const croppedRead = await cropped('GET', path);
  expect(await json(croppedRead.clone())).toEqual({ scene, revision: 0, validityDays: 2 });
  recorder.recordFact(read, 'fixedKeys', await observe(croppedRead));
  const fieldDenied = controlledApi(
    w.db,
    w.tenantId,
    w.userId,
    {
      deny: (request) => request.resource === SETTINGS && request.fields?.includes('validityDays') === true,
    },
    START.toISOString(),
  );
  await reason(await fieldDenied('PUT', path, { ifMatch: 0, body: input }), 'FORBIDDEN', 403);

  let checkedWrite = 0;
  const allowBeforeTransaction = () => true;
  registerScopeProvider(allowBeforeTransaction, {
    scope: async () => EMPTY_SCOPE,
    fields: async () => new Set(['validityDays', 'remindBeforeExpiry']),
    authorize: async ({ action, fields, resource }) => {
      if (resource === SETTINGS && action === 'object.update' && fields?.includes('validityDays')) {
        checkedWrite++;
        return false;
      }
      return true;
    },
  });
  const txDenied = tenantApi(w.db, { authorize: allowBeforeTransaction });
  const denyInTransaction = (idempotencyKey: string) =>
    txDenied.request('PUT', path, { ...w.as, ifMatch: 0, body: input, idempotencyKey });
  const rejectedKey = uniqueSuffix();
  await reason(await denyInTransaction(rejectedKey), 'FORBIDDEN', 403);
  expect(await snapshot(rejectedKey)).toEqual({ ledger: [], audit: [] });

  const keys = [uniqueSuffix(), uniqueSuffix()];
  const snapshots = await Promise.all(keys.map(snapshot));
  const opts = (idempotencyKey: string) => ({ ifMatch: 0, body: input, idempotencyKey });
  const results = await Promise.all(keys.map((key) => w.call('PUT', relative, opts(key))));
  expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  for (const [index, response] of results.entries()) {
    const key = keys[index]!;
    const before = snapshots[index]!;
    const after = await snapshot(key);
    if (response.status === 200) {
      const body = { scene, revision: 1, ...input };
      expect(await json(response.clone())).toEqual(body);
      expect(await json(await w.call('PUT', relative, opts(key)))).toEqual(body);
      await reason(await denied('PUT', relative, opts(key)), 'FORBIDDEN', 403);
      await reason(await denyInTransaction(key), 'FORBIDDEN', 403);
      expect(checkedWrite).toBeGreaterThanOrEqual(2);
      expect(after).toEqual({ ledger: [200], audit: ['esign.scene.update'] });
      expect(await snapshot(key)).toEqual(after);
      recorder.recordFact(write, 'fixedKeys', await observe(response));
    } else {
      await reason(response.clone(), 'REVISION_CONFLICT');
      expect(after).toEqual(before);
      const conflict = await observe(response);
      recorder.recordFact(write, 'precondition:esign.lock', conflict);
      recorder.recordFact(write, 'precondition:esign.revision', conflict);
    }
    const fact = await observe(response, {
      ledger: { before: before.ledger, after: after.ledger },
      audit: { before: before.audit, after: after.audit },
    });
    recorder.recordFact(write, 'ledger', fact);
    recorder.recordFact(write, 'outcome', fact);
  }

  const other = await seedTenantWithMember(w.db, 'ZZ_F505_SETTINGS_OTHER');
  const asOther = { user: other.user.id, tenant: other.tenant.id };
  expect(await json(await w.call('GET', relative, asOther))).toEqual(defaults);
  await reason(await w.call('GET', relative, { tenant: other.tenant.id }), 'TENANT_NOT_MEMBER', 403);
  await reason(await w.call('GET', relative, { user: undefined }), 'UNAUTHENTICATED', 401);
  await reason(await w.call('GET', '/scenes/not-a-scene'), 'NOT_FOUND', 404);
  await reason(await w.call('PUT', '/scenes/not-a-scene', { ifMatch: 0, body: input }), 'NOT_FOUND', 404);
});
