import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { successionWorld, SC_TODAY } from './AC-SC-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
}, 300000);
afterAll(async () => handle?.close());
it('AC-SC-risk C1 权限断层新根与冻结一致；撤范围后重放 404 且原集合不变', async () => {
  const w = await successionWorld(handle.db, 'risk-gap');
  const a = await w.org('A'),
    b = await w.org('B', a.id),
    c = await w.org('C', b.id);
  const pa = await w.position(a.id, 'A');
  const pb = await w.position(b.id, 'B', { parents: { admin: { parentId: pa.id } } });
  const pc = await w.position(c.id, 'C', { parents: { admin: { parentId: pb.id } } });
  const world = await permissionWorldOf(w),
    viewer = await recordOperator(world);
  const map = SUCCESSION_OBJECTS.map;
  expect(
    (
      await setObjectPermission(
        world,
        viewer.profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: map.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
          buttons: [{ buttonCode: 'computeRisk', level: 'list' }],
        },
        map.code,
      )
    ).status,
  ).toBe(200);
  const mou = await world.api.request('POST', '/api/tenant/permission/mous', {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      code: randomUUID(),
      name: '仅 A C',
      orgRanges: [a.id, c.id].map((orgId) => ({ orgId, includeDescendants: false })),
    },
  });
  expect(mou.status).toBe(201);
  const scopePath = `/api/tenant/permission/scopes/${viewer.userId}/SuccessionAndDevelopment`;
  expect(
    (
      await world.api.request('PUT', scopePath, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id },
      })
    ).status,
  ).toBe(200);
  const options = {
    ifMatch: 0,
    idempotencyKey: randomUUID(),
    body: { rootOrgId: a.id, depth: 2, hiddenOrgIds: [], showKeyPositions: true, showPositionsWithoutSuccessor: true },
  };
  const first = await viewer.request('POST', '/maps/position/compute-risk', options);
  expect(first.status, await first.clone().text()).toBe(202);
  const { runId } = (await first.json()) as { runId: string };
  const read = () =>
    w.asTenant(async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`
    SELECT object_id FROM succession_calc_run_objects WHERE run_id=${runId}::uuid ORDER BY object_id`),
      ),
    );
  expect(await read()).toEqual([pa.id, pc.id].sort().map((object_id) => ({ object_id })));
  expect(
    (
      await viewer.request('POST', '/maps/position/compute-risk', {
        ...options,
        idempotencyKey: randomUUID(),
        body: { ...options.body, rootOrgId: b.id },
      })
    ).status,
  ).toBe(404);
  const before = await read();
  const revoked = await world.api.request('PUT', scopePath, {
    ...world.asAdmin,
    ifMatch: 1,
    body: { kind: 'default' },
  });
  expect(revoked.status, await revoked.clone().text()).toBe(200);
  expect((await viewer.request('POST', '/maps/position/compute-risk', options)).status).toBe(404);
  expect(await read()).toEqual(before);
});
it('AC-SC-risk C1 四种语义：保存隐藏项停用后忽略；原任务重放不重施新条件门槛', async () => {
  const w = await successionWorld(handle.db, 'risk-lifecycle');
  const a = await w.org('根'),
    b = await w.org('隐藏', a.id);
  await w.position(a.id, '风险职位');
  const body = {
    rootOrgId: a.id,
    hiddenOrgIds: [b.id],
    depth: 2,
    showKeyPositions: true,
    showPositionsWithoutSuccessor: true,
  };
  expect((await w.request('PUT', '/maps/position/preferences', { ifMatch: 0, body })).status).toBe(200);
  const options = { ifMatch: 0, idempotencyKey: randomUUID(), body };
  const first = await w.request('POST', '/maps/position/compute-risk', options);
  expect(first.status).toBe(202);
  const original = await first.json();
  expect((await w.patchOrg(b, { enabled: false, effectiveDate: SC_TODAY })).status).toBe(200);
  const replay = await w.request('POST', '/maps/position/compute-risk', options);
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual(original);
  expect(
    (await w.request('POST', '/maps/position/compute-risk', { ...options, idempotencyKey: randomUUID() })).status,
  ).toBe(404);
  expect((await w.request('POST', '/maps/position/compute-risk', { ifMatch: 0, body: {} })).status).toBe(202);
});
