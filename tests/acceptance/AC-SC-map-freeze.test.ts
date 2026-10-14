/** #265 P2-2：当前组织图显示条件与手动冻结共用解析，重放保留原集合。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { SC_TODAY, successionWorld } from './AC-SC-support.js';

const db = useTestDb();
it('AC-SC-map-freeze P2-2：当前根 B/两层冻结 B、C；规范化、原集合重放和不同条件新命令', async () => {
  const w = await successionWorld(db().db, 'sc-current-org-display');
  const a = await w.org('A');
  const b = await w.org('B', a.id);
  const c = await w.org('C', b.id);
  const d = await w.org('D', c.id);
  const body = { rootOrgId: b.id.toUpperCase(), depth: 2, hiddenOrgIds: [] as string[] };
  const opts = { ifMatch: 0, idempotencyKey: randomUUID(), body };
  const send = (options = opts) => w.request('POST', '/maps/org/compute-stats', options);
  const first = await send();
  expect(first.status, await first.clone().text()).toBe(202);
  const receipt = (await first.json()) as { runId: string };
  const frozen = (runId: string) =>
    w.asTenant(async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id FROM succession_calc_run_objects WHERE run_id=${runId}::uuid`),
      )
        .map((r) => r.object_id)
        .sort(),
    );
  expect(await frozen(receipt.runId)).toEqual([b.id, c.id].sort());
  const extra = await w.org('之后新增', b.id);
  const replay = await send({ ...opts, body: { ...body, rootOrgId: b.id } });
  expect(replay.status, await replay.clone().text()).toBe(202);
  expect(await replay.json()).toEqual(receipt);
  expect(await frozen(receipt.runId)).toEqual([b.id, c.id].sort());
  const changed = { ...body, depth: 3, hiddenOrgIds: [extra.id.toUpperCase(), extra.id] };
  expect((await send({ ...opts, body: changed })).status).toBe(409);
  const second = await send({ ...opts, idempotencyKey: randomUUID(), body: changed });
  expect(second.status, await second.clone().text()).toBe(202);
  const next = (await second.json()) as { runId: string };
  const display = await w.asTenant((tx) =>
    readMapDisplayScope(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        asOf: SC_TODAY,
        scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
      },
      'org',
      changed,
    ),
  );
  expect(display.sort()).toEqual([b.id, c.id, d.id].sort());
  expect(await frozen(next.runId)).toEqual(display.sort());
});

it('AC-SC-map-freeze P2-2：非法显示条件拒绝且不冻结；隐藏引用与根均验证租户和范围', async () => {
  const w = await successionWorld(db().db, 'sc-invalid-map-display');
  const root = await w.org('合法根');
  const other = await successionWorld(db().db, 'sc-other-map-display');
  const foreign = await other.org('其他租户根');
  const send = (body: unknown) => w.request('POST', '/maps/org/compute-stats', { ifMatch: 0, body });
  for (const body of [
    null,
    { depth: 1 },
    { depth: 5 },
    { depth: 2.5 },
    { rootOrgId: '非法' },
    { hiddenOrgIds: Array.from({ length: 201 }, () => randomUUID()) },
    { hideVirtual: true },
    { showIncumbents: false },
    { arbitrary: true },
  ])
    expect((await send(body)).status).toBe(400);
  const ctx = {
    tenantId: w.tenant.id,
    userId: w.user.id,
    asOf: SC_TODAY,
    scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
  };
  await expect(w.asTenant((tx) => readMapDisplayScope(tx, ctx, 'org', null))).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  for (const body of [
    { rootOrgId: randomUUID() },
    { rootOrgId: foreign.id },
    { rootOrgId: root.id, hiddenOrgIds: [foreign.id] },
  ])
    expect((await send(body)).status).toBe(404);
  expect(await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`)))).toEqual(
    [],
  );
});
