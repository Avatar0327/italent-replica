import { randomUUID } from 'node:crypto';
import { routeManifest } from '@italent/api';
import { and, commandLedger, eq } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { json, reason } from './AC-TRF-F481-s3a-support.js';
import {
  contextPath,
  EMPLOYEE,
  offerSigningWorld,
  OFFERS,
  OFFER_OBJECT,
  RECORD,
  recordsPath,
  type Receipt,
  resultPath,
} from './AC-ESIGN-F505-S4-support.js';
import { tenantApi } from './support/tenant-api.js';
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

const db = useTestDb();
const CONTEXT = `GET ${OFFERS}/:id/esign-context`;
const WRITE = `POST ${OFFERS}/:id/esign-tasks`;
const RECORDS = `GET ${OFFERS}/:id/esign-records`;
const endpoints = new Set([CONTEXT, WRITE, RECORDS]);
const recorder = createRecorder();

afterAll(() => {
  const contract = readFrozenContract()!;
  const routes = routeManifest(tenantApi(db().db).app).declared;
  const keys = routes
    .map(({ method, path }) => `${method} ${path}`)
    .filter(
      (key) => key.startsWith('GET ' + OFFERS + '/:id/esign-') || key.startsWith('POST ' + OFFERS + '/:id/esign-'),
    );
  expect(new Set(keys)).toEqual(endpoints);
  for (const key of endpoints) expect(contract.routes[key], key).toBeDefined();
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  expect(checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes, contract })).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});

it('AC-22 三路由的固定键、双范围、台账和发起前置条件均有实际 HTTP 证据', async () => {
  const w = await offerSigningWorld(db().db, 'S4_EVIDENCE');
  const source = await w.offer();
  const template = await w.template('{员工姓名}');
  const key = uniqueSuffix();
  const call = w.access();
  const context = await call('GET', contextPath(source));
  expect(await json(context.clone())).toEqual({
    sourceId: source,
    revision: 1,
    canInitiate: true,
    items: [{ id: template.id, name: template.name }],
  });
  recorder.recordFact(CONTEXT, 'outcome', await observe(context));
  recorder.recordFact(CONTEXT, 'fixedKeys', await observe(context));
  const unavailable = await w.offer({ linkedEmployeeId: null });
  const blocked = await call('GET', contextPath(unavailable));
  expect(await json(blocked.clone())).toMatchObject({ canInitiate: false, reason: 'ESIGN_OWNER_UNAVAILABLE' });
  recorder.recordFact(CONTEXT, 'fixedKeys', await observe(blocked));

  const snapshot = (commandId: string) =>
    w.inTenant(async (tx) =>
      (
        await tx
          .select({ status: commandLedger.responseStatus })
          .from(commandLedger)
          .where(and(eq(commandLedger.tenantId, w.tenantId), eq(commandLedger.commandId, commandId)))
      ).map((row) => row.status),
    );
  const before = await snapshot(key);
  expect(before).toEqual([]);
  const started = await w.post(source, [template.id], key);
  const receipt = await json<Receipt>(started.clone(), 201);
  expect(receipt).toEqual({ sourceId: source, taskId: expect.any(String) });
  const after = await snapshot(key);
  expect(after).toEqual([201]);
  const saved = await observe(started, { ledger: { before, after } });
  recorder.recordFact(WRITE, 'outcome', saved);
  recorder.recordFact(WRITE, 'fixedKeys', saved);
  recorder.recordFact(WRITE, 'ledger', saved);

  const history = await w.access({ fields: { [RECORD]: ['scene'] } })('GET', recordsPath(source));
  expect(await json(history.clone())).toEqual({
    items: [{ id: receipt.taskId, revision: 1, scene: 'offer' }],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  recorder.recordFact(RECORDS, 'outcome', await observe(history));
  recorder.recordFact(RECORDS, 'fixedKeys', await observe(history));

  const reject = async (endpoint: string, r: Response, code: string, status: number) => {
    await reason(r.clone(), code, status);
    recorder.recordFact(endpoint, 'outcome', await observe(r));
  };
  const outside = w.access({ scopes: { [OFFER_OBJECT]: EMPTY_SCOPE } });
  await reject(CONTEXT, await outside('GET', contextPath(source)), 'NOT_FOUND', 404);
  await reject(RECORDS, await outside('GET', recordsPath(source)), 'NOT_FOUND', 404);
  await reject(WRITE, await w.post(source, [template.id], key, 1, outside), 'NOT_FOUND', 404);
  await reason(await outside('GET', resultPath(key)), 'NOT_FOUND', 404);
  const withoutEdit = w.access({ deny: (q) => q.action === 'object.update' && q.resource === OFFER_OBJECT });
  await reject(CONTEXT, await withoutEdit('GET', contextPath(source)), 'FORBIDDEN', 403);
  await reject(WRITE, await w.post(source, [template.id], key, 1, withoutEdit), 'FORBIDDEN', 403);
  const withoutRecord = w.access({ deny: (q) => q.action === 'object.view' && q.resource === RECORD });
  await reject(RECORDS, await withoutRecord('GET', recordsPath(source)), 'FORBIDDEN', 403);
  const withoutPerson = w.access({ fields: { [EMPLOYEE]: [] } });
  await reject(WRITE, await w.post(source, [template.id], key, 1, withoutPerson), 'FIELD_FORBIDDEN', 403);

  const rejectWrite = async (
    precondition: 'revision' | 'esign.offer.sourceReady' | 'esign.offer.noSigning' | 'esign.offer.templates',
    offer: string,
    ids: string[],
    code: string,
    status: number,
    ifMatch = 1,
  ) => {
    const commandId = uniqueSuffix();
    const before = await snapshot(commandId);
    const r = await w.post(offer, ids, commandId, ifMatch);
    await reason(r.clone(), code, status);
    const after = await snapshot(commandId);
    expect(after).toEqual(before);
    const observed = await observe(r, { ledger: { before, after } });
    recorder.recordFact(WRITE, `precondition:${precondition}`, observed);
    recorder.recordFact(WRITE, 'ledger', observed);
  };
  await rejectWrite('revision', source, [template.id], 'REVISION_CONFLICT', 409, 2);
  await rejectWrite('esign.offer.sourceReady', unavailable, [template.id], 'ESIGN_OWNER_UNAVAILABLE', 409);
  await rejectWrite('esign.offer.noSigning', source, [template.id], 'ESIGN_TASK_IN_PROGRESS', 409);
  await rejectWrite('esign.offer.templates', await w.offer(), [randomUUID()], 'ESIGN_TEMPLATE_UNAVAILABLE', 400);
  const noAccount = await w.session.employee('ZZ_F505_未绑定账号');
  const failed = await w.post(await w.offer({ linkedEmployeeId: noAccount.id }), [template.id]);
  const failedReceipt = await json<Receipt>(failed.clone(), 201);
  expect(await w.taskRow(failedReceipt.taskId)).toMatchObject({
    status: 'failed',
    failureReason: 'EMPLOYEE_NO_ACCOUNT',
  });
  recorder.recordFact(WRITE, 'precondition:esign.offer.account', await observe(failed));
});
