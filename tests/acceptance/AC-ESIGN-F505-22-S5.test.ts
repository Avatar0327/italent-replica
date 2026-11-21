import { randomUUID } from 'node:crypto';
import { routeManifest } from '@italent/api';
import { and, auditEvents, commandLedger, eq, grantMembership, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, expect, it } from 'vitest';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { readFrozenProbes } from './support/route-policy/discovery.js';
import { ENTRY_SIGN_PROBE_KEYS, probeEntrySignBranches } from './support/route-policy/entry-sign-probe.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  readFrozenRecorded,
  writeFrozenRecorded,
  type RecordedCategory,
} from './support/route-policy/recorded.js';
import { permClaims } from './support/route-policy/request-perms.js';
import { EMPLOYMENT_ESIGN } from './support/route-policy/required/employment-esign.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { EMPLOYMENT_OBJECT, resultPath, s5World, source, type Receipt } from './AC-ESIGN-F505-s5-support.js';

const database = useTestDb();
const keys = ENTRY_SIGN_PROBE_KEYS;
const endpoints = new Set<string>(Object.values(keys));
const recorder = createRecorder();
const updating = process.env.ROUTE_POLICY_UPDATE_BASELINE === '1';
const routes = () => routeManifest(tenantApi(database().db).app).declared;
const record = async (key: string, category: RecordedCategory, response: Response) =>
  recorder.recordFact(key, category, await observe(response));

afterAll(() => {
  const contract = readFrozenContract()!;
  for (const key of endpoints) expect(contract.routes[key], key).toBeDefined();
  const frozen = readFrozenRecorded();
  const current = updating ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  expect(
    checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes: routes(), contract }),
  ).toEqual([]);
  if (updating) writeFrozenRecorded(current);
});

it('AC-22 三条入职签署路由都在运行时策略清单', () => {
  expect(
    routes()
      .map(({ method, path }) => `${method} ${path}`)
      .filter((key) => endpoints.has(key))
      .sort(),
  ).toEqual([...endpoints].sort());
});

it('AC-22 发现探测验证成员、对象、按钮、范围、变量字段、历史文件裁剪', async () => {
  const { context, tasks, records } = await probeEntrySignBranches(database().db);
  expect(await json(context.accepted.response.clone())).toEqual({
    sourceId: expect.any(String),
    revision: expect.any(Number),
    canInitiate: true,
    items: [{ id: expect.any(String), name: 'ZZ_F505_模板' }],
  });
  expect(await json(tasks.accepted.response.clone(), 201)).toEqual({
    sourceId: expect.any(String),
    taskId: expect.any(String),
  });
  const signFiles = (response: Response) => json<{ items: { files?: unknown[] }[]; total: number }>(response.clone());
  expect((await signFiles(records.accepted.response)).items[0]?.files).toHaveLength(1);
  const masked = await signFiles(records.noFiles.response);
  expect(masked.total).toBe(1);
  expect(masked.items[0]).not.toHaveProperty('files');

  const statuses = {
    context: { accepted: 200, noObject: 403, noButton: 403, noScope: 404, foreign: 404, inactive: 403 },
    tasks: { accepted: 201, noButton: 403, noScope: 404, noVariable: 403 },
    records: { accepted: 200, noSourceRead: 403, noRecordRead: 403, noScope: 404, noFiles: 200 },
  };
  const probeFreeze = updating ? undefined : readFrozenProbes();
  for (const [view, probes] of Object.entries({ context, tasks, records })) {
    const scope = view as keyof typeof keys;
    const key = keys[scope];
    const status = statuses[scope] as Record<string, number>;
    for (const [branch, probe] of Object.entries(probes)) {
      expect(probe.response.status, `${view}/${branch}`).toBe(status[branch]);
      for (const perm of probe.observed.trace)
        expect(
          EMPLOYMENT_ESIGN[key]?.some((item) => permClaims(item.perm, perm)),
          perm,
        ).toBe(true);
      await record(key, 'outcome', probe.response);
      if (probe.response.ok) await record(key, 'fixedKeys', probe.response);
    }
    if (probeFreeze)
      expect(probeFreeze[key]?.entrySignBranches).toEqual(
        Object.fromEntries(Object.entries(probes).map(([branch, probe]) => [branch, probe.observed])),
      );
  }
});

it('AC-22 前置条件、命令台账足迹与来源任务绑定均有 HTTP 执行证据', async () => {
  const w = await s5World(database().db);
  const entry = await w.pending();
  const template = await w.template();
  const key = uniqueSuffix();
  const snapshot = () =>
    withTenant(w.db, w.as.tenant, async (tx) => ({
      ledger: await tx.select().from(commandLedger).where(eq(commandLedger.tenantId, w.as.tenant)),
      audit: await tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, w.as.tenant), eq(auditEvents.commandId, key))),
    }));
  const before = await snapshot();
  const started = await w.submit(entry, [template.id], key);
  const receipt = await json<Receipt>(started.clone(), 201);
  const after = await snapshot();
  const statuses = (s: typeof before) => s.ledger.map(({ responseStatus }) => responseStatus);
  const actions = (s: typeof before) => s.audit.map(({ action }) => action);
  const observation = await observe(started, {
    ledger: { before: statuses(before), after: statuses(after) },
    audit: { before: actions(before), after: actions(after) },
  });
  expect(observation.ledgerAdded).toEqual([201]);
  expect(observation.auditAdded).toContain('esign.task.initiated');
  recorder.recordFact(keys.tasks, 'ledger', observation);
  recorder.recordFact(keys.tasks, 'outcome', observation);

  const beforeRejections = await snapshot();
  const other = await w.pending();
  await json(
    await w.session.request('POST', `/pending-entries/${other.id}/cancel`, {
      ifMatch: other.revision,
      body: {},
    }),
  );
  const contextResponse = await w.call('GET', source(other.id, 'context'));
  const closed = await json<{ revision: number }>(contextResponse.clone());
  expect(closed).toMatchObject({ canInitiate: false, reason: 'ENTRY_CANCELLED', items: [] });
  await record(keys.context, 'fixedKeys', contextResponse);
  const reject = async (name: string, response: Response, status: number, code: string, reason?: string) => {
    const body = await w.error(response.clone(), status, code);
    if (reason) expect(body).toMatchObject({ error: { details: { reason } } });
    await record(keys.tasks, `precondition:${name}`, response);
  };
  await reject(
    'esign.entryEligibility',
    await w.submit({ ...other, revision: closed.revision }, [template.id]),
    409,
    'CONFLICT',
    'ENTRY_CANCELLED',
  );
  await reject(
    'esign.revision',
    await w.submit({ ...entry, revision: entry.revision + 1 }, [template.id]),
    409,
    'REVISION_CONFLICT',
  );
  await reject(
    'esign.templates',
    await w.submit(await w.pending(), [randomUUID()]),
    400,
    'VALIDATION_FAILED',
    'ESIGN_TEMPLATE_UNAVAILABLE',
  );
  await reject('esign.noSigning', await w.submit(entry, [template.id]), 409, 'CONFLICT', 'ESIGN_TASK_IN_PROGRESS');
  const rejected = await snapshot();
  const unrelated = new Set(beforeRejections.ledger.map((row) => row.commandId));
  expect(
    rejected.ledger.filter((row) => !unrelated.has(row.commandId) && row.commandType?.endsWith('/esign-tasks')),
  ).toEqual([]);

  const original = after.ledger.find((row) => row.commandId === key)!;
  const wrongKey = uniqueSuffix();
  await withTenant(w.db, w.as.tenant, (tx) =>
    tx.insert(commandLedger).values({
      tenantId: w.as.tenant,
      commandId: wrongKey,
      commandType: original.commandType,
      requestHash: original.requestHash,
      actorUserId: w.as.user,
      responseStatus: 201,
      responseBody: { sourceId: other.id, taskId: receipt.taskId },
    }),
  );
  const absent = await w.error(await w.call('GET', resultPath(uniqueSuffix())), 404);
  expect(await w.error(await w.call('GET', resultPath(wrongKey)), 404)).toEqual(absent);
  await w.error(await w.submit(entry, [template.id], wrongKey), 404, 'NOT_FOUND');
  expect(
    await w.error(
      await w.restricted({ scopes: { [EMPLOYMENT_OBJECT]: EMPTY_SCOPE } })('GET', source(entry.id, 'records')),
      404,
    ),
  ).toEqual(await w.error(await w.call('GET', source(randomUUID(), 'records')), 404));
});

it('AC-22 不存在、外租户及范围外在三条路由使用同一 404 信封', async () => {
  const w = await s5World(database().db);
  const entry = await w.pending();
  const template = await w.template();
  const foreign = await seedTenantWithMember(w.db, 'ZZ_F505_外租户来源');
  await grantMembership(w.db, { tenantId: foreign.tenant.id, userId: w.as.user, expectedRevision: 0 }, cmd());
  const limited = w.restricted({ scopes: { [EMPLOYMENT_OBJECT]: EMPTY_SCOPE } });
  for (const view of ['context', 'tasks', 'records'] as const) {
    const method = view === 'tasks' ? 'POST' : 'GET';
    const request = view === 'tasks' ? { ifMatch: entry.revision, body: { templateIds: [template.id] } } : {};
    const path = source(entry.id, view);
    const missing = await w.call(method, source(randomUUID(), view), request);
    const outside = await limited(method, path, request);
    const crossTenant = await w.call(method, path, { ...request, tenant: foreign.tenant.id });
    const expected = await w.error(missing, 404, 'NOT_FOUND');
    expect(await w.error(outside, 404, 'NOT_FOUND')).toEqual(expected);
    expect(await w.error(crossTenant, 404, 'NOT_FOUND')).toEqual(expected);
  }
});
