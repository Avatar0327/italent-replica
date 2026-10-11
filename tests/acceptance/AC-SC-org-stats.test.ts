/** C1 #9：手动统计只登记 B3a run，不在 HTTP 请求中直接计算。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { SC_TODAY, successionWorld } from './AC-SC-support.js';

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
