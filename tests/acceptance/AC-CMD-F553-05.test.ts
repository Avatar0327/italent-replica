import { routeManifest, type ManifestRoute } from '@italent/api';
import { and, auditCommandFailures, auditEvents, commandLedger, eq, esignTasks, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterAll, expect, it } from 'vitest';
import { expectHidden, RESULT_ROUTE, SOURCE_OBJECT } from './AC-CMD-F553-support.js';
import { SCENES } from './AC-ESIGN-F505-s2-support.js';
import { json } from './AC-TRF-F481-s3a-support.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import { probeCommandResultBranch } from './support/route-policy/command-result-probe.js';
import { readFrozenProbes } from './support/route-policy/discovery.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  readFrozenRecorded,
  writeFrozenRecorded,
} from './support/route-policy/recorded.js';
import { permClaims } from './support/route-policy/request-perms.js';
import { COMMAND_RESULT } from './support/route-policy/required/command-result.js';

const db = useTestDb();
const recorder = createRecorder();
const endpoints = new Set([RESULT_ROUTE]);
const probes = readFrozenProbes();
let routes: readonly ManifestRoute[];

afterAll(() => {
  const contract = readFrozenContract();
  expect(contract?.routes[RESULT_ROUTE]?.primitives.guard).toContain('command.result.registered');
  expect(routes.filter(({ module }) => module === 'command-result').map(({ key }) => key)).toEqual([RESULT_ROUTE]);
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  expect(
    checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes, contract: contract! }),
  ).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});

it.each(SCENES)('AC-CMD-F553-05 %s 发现回查分支，登记当前事务内权限、拒绝码和最小响应', async (scene) => {
  const { world, observations, accepted, deniedEdit, deniedScope, deniedVariable, deniedButton } =
    await probeCommandResultBranch(db().db, scene);
  routes = routeManifest(world.api.app).declared;
  const edit = `obj:${SOURCE_OBJECT[scene]}:update`;
  const button = 'btn:TenantBase.EmploymentRecord#Employment.Edit@detail';
  const employeeRead = 'obj:TenantBase.Employee:view';
  const expectedTrace = [edit, employeeRead, ...(scene === 'entry' ? [button] : [])].sort();
  expect(observations.accepted.trace).toEqual(expectedTrace);
  expect(observations.accepted.scopeQueries.some((scope) => scope.includes(`/${SOURCE_OBJECT[scene]}/`))).toBe(true);
  expect(
    observations.accepted.scopeQueries.some((scope) =>
      scope.endsWith('/TenantBase.Employee/TenantBase.Employee.detail'),
    ),
  ).toBe(true);
  expect(observations.accepted.fieldQueries).toEqual(['fields:TenantBase.Employee']);
  expect(observations.deniedEdit.trace).toEqual([edit]);
  expect(observations.deniedScope.trace).not.toContain(employeeRead);
  expect(observations.deniedVariable.trace).toEqual(expectedTrace);
  if (deniedButton) expect(deniedButton.observed.trace).toEqual([button, edit].sort());
  for (const seen of Object.values(observations)) {
    expect(seen.inTransaction).toBe(true);
    for (const perm of seen.trace) {
      expect(
        COMMAND_RESULT[RESULT_ROUTE]?.some((obligation) => permClaims(obligation.perm, perm)),
        perm,
      ).toBe(true);
    }
  }

  expect(await json(accepted.response.clone())).toEqual(world.receipt);
  const outcome = await observe(accepted.response);
  recorder.recordFact(RESULT_ROUTE, 'outcome', outcome);
  recorder.recordFact(RESULT_ROUTE, 'fixedKeys', outcome);
  const denied = [
    { probe: deniedEdit, status: 403, code: 'FORBIDDEN' },
    { probe: deniedScope, status: 404, code: 'NOT_FOUND' },
    { probe: deniedVariable, status: 403, code: 'FIELD_FORBIDDEN' },
    ...(deniedButton ? [{ probe: deniedButton, status: 403, code: 'FORBIDDEN' }] : []),
  ];
  for (const { probe, status, code } of denied) {
    await expectHidden(probe.response.clone(), [status]);
    expect(await probe.response.clone().json()).toMatchObject({ error: { code } });
    recorder.recordFact(RESULT_ROUTE, 'outcome', await observe(probe.response));
  }
  if (process.env.ROUTE_POLICY_UPDATE_BASELINE !== '1') {
    expect(probes[RESULT_ROUTE]?.registeredCommands?.[scene]).toEqual(observations);
  }
});

it('AC-CMD-F553-05 成功与拒绝回查都不写命令台账、审计或任务', async () => {
  const { world } = await probeCommandResultBranch(db().db, 'offer');
  const snapshot = () =>
    withTenant(world.db, world.tenantId, async (tx) => ({
      ledger: (await tx.select({ status: commandLedger.responseStatus }).from(commandLedger))
        .map((r) => r.status)
        .sort(),
      audit: (await tx.select({ action: auditEvents.action }).from(auditEvents)).map((r) => r.action).sort(),
      failures: await tx.select().from(auditCommandFailures),
      task: await tx
        .select()
        .from(esignTasks)
        .where(and(eq(esignTasks.tenantId, world.tenantId), eq(esignTasks.id, world.receipt.taskId))),
    }));
  const before = await snapshot();
  const accepted = await world.call();
  expect(await json(accepted.clone())).toEqual(world.receipt);
  const after = await snapshot();
  expect(after).toEqual(before);
  recorder.recordFact(
    RESULT_ROUTE,
    'ledger',
    await observe(accepted, { ledger: { before: before.ledger, after: after.ledger } }),
  );

  const denied = await world.call({ deny: ({ resource }) => resource === SOURCE_OBJECT.offer });
  await expectHidden(denied.clone(), [403]);
  const afterDenial = await snapshot();
  expect(afterDenial).toEqual(before);
  recorder.recordFact(
    RESULT_ROUTE,
    'ledger',
    await observe(denied, { ledger: { before: before.ledger, after: afterDenial.ledger } }),
  );
});
