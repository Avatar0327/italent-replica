/** C1 #9：手动统计只登记 B3a run，不在 HTTP 请求中直接计算。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { SC_TODAY, successionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';

const db = useTestDb();

it('AC-SC-org-stats compute-stats 返回 202 runId；同命令重放复用冻结任务', async () => {
  const w = await successionWorld(db().db, 'sc-c1-stats');
  await w.org('手动统计组织');
  const commandId = randomUUID();
  const options = { ifMatch: 0, idempotencyKey: commandId, body: {} };
  const first = await w.request('POST', '/maps/org/compute-stats', options);
  expect(first.status, await first.clone().text()).toBe(202);
  const result = (await first.json()) as { runId: string };
  expect(Object.keys(result)).toEqual(['runId']);
  expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
  const replay = await w.request('POST', '/maps/org/compute-stats', options);
  expect(replay.status, await replay.clone().text()).toBe(202);
  expect(await replay.json()).toEqual(result);
  const rows = rowsOf(
    await w.asTenant((tx) =>
      tx.execute(sql`SELECT kind, trigger, business_date::text, status, idempotency_key
        FROM succession_calc_runs WHERE id = ${result.runId}::uuid`),
    ),
  );
  expect(rows).toEqual([
    {
      kind: 'org_stats',
      trigger: 'manual',
      business_date: SC_TODAY,
      status: 'pending',
      idempotency_key: `org_stats:manual:${commandId}`,
    },
  ]);
});

it('AC-SC-org-stats 撤权后直接重放 403；新请求和重放均不新增统计任务', async () => {
  const w = await successionWorld(db().db, 'sc-stats-revoked');
  await w.org('撤权统计');
  let allowed = true;
  const api = tenantApi(w.db, { authorize: () => allowed });
  const options = { user: w.user.id, tenant: w.tenant.id, ifMatch: 0, body: {}, idempotencyKey: randomUUID() };
  const path = '/api/tenant/succession/maps/org/compute-stats';
  expect((await api.request('POST', path, options)).status).toBe(202);
  const read = () => w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`)));
  const before = await read();
  allowed = false;
  expect((await api.request('POST', path, options)).status).toBe(403);
  expect((await api.request('POST', path, { ...options, idempotencyKey: randomUUID() })).status).toBe(403);
  expect(await read()).toEqual(before);
});
