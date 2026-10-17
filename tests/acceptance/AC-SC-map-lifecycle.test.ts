/** #265 R3 / DEC-431①：新提交、保存筛选应用、当前授权与原回执重放分开验证。 */
import { randomUUID } from 'node:crypto';
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { SC_TODAY, SC_NOW, successionWorld, type SuccessionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';

const db = useTestDb();
const context = (w: SuccessionWorld) => ({
  tenantId: w.tenant.id,
  userId: w.user.id,
  asOf: SC_TODAY,
  scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
});
const stop = async (w: SuccessionWorld, org: { id: string; revision: number }) => {
  const response = await w.patchOrg(org, { enabled: false, effectiveDate: SC_TODAY });
  expect(response.status, await response.clone().text()).toBe(200);
};
const runs = (w: SuccessionWorld) =>
  w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs ORDER BY id`)));

it.each(['停用', '不存在'] as const)('AC-SC-map-lifecycle 已保存隐藏组织%s：剩余职位图仍可读取', async (state) => {
  const w = await successionWorld(db().db, `sc-hidden-${state}`);
  const a = await w.org('A', undefined, { establishedOn: '2026-09-30' });
  const h = await w.org('隐藏 H', a.id, { establishedOn: '2026-09-30' });
  const p = await w.position(a.id, '正常显示职位');
  const options = {
    ifMatch: 0,
    idempotencyKey: randomUUID(),
    body: {
      rootOrgId: a.id,
      depth: 2,
      hiddenOrgIds: [h.id],
      showKeyPositions: false,
      showPositionsWithoutSuccessor: true,
    },
  };
  expect((await w.request('PUT', '/maps/position/preferences', options)).status).toBe(200);
  await stop(w, h);
  if (state === '不存在') {
    // 组织尚无删除入口；用合成不存在 UUID 模拟已经保存的悬空隐藏引用，不改组织版本链。
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_map_preferences
      SET hidden_org_ids=${JSON.stringify([randomUUID()])}::jsonb WHERE user_id=${w.user.id}::uuid`),
    );
  }
  const ids = await w.asTenant((tx) => readMapDisplayScope(tx, context(w), 'position'));
  expect(ids).toEqual([p.id]);
  const before = await runs(w);
  const replay = await w.request('PUT', '/maps/position/preferences', options);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await runs(w)).toEqual(before);
});

it('AC-SC-map-lifecycle 隐藏停用：compute-stats 同键复用原回执，新命令含停用项仍拒绝', async () => {
  const w = await successionWorld(db().db, 'sc-stats-hidden-stop');
  const a = await w.org('A', undefined, { establishedOn: '2026-09-30' });
  const h = await w.org('隐藏 H', a.id, { establishedOn: '2026-09-30' });
  const options = {
    ifMatch: 0,
    idempotencyKey: randomUUID(),
    body: {
      rootOrgId: a.id,
      depth: 2,
      hiddenOrgIds: [h.id],
    },
  };
  const first = await w.request('POST', '/maps/org/compute-stats', options);
  expect(first.status).toBe(202);
  const original = (await first.json()) as { runId: string };
  await stop(w, h);
  const replay = await w.request('POST', '/maps/org/compute-stats', options);
  expect(replay.status, await replay.clone().text()).toBe(202);
  expect(await replay.json()).toEqual(original);
  expect(
    (
      await w.request('POST', '/maps/org/compute-stats', {
        ...options,
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(404);
  expect(await runs(w)).toEqual([{ id: original.runId }]);
});

it('AC-SC-map-lifecycle 偏好同键返回原配置，新提交拒绝停用隐藏项，清除旧项仍触发统计', async () => {
  const w = await successionWorld(db().db, 'sc-prefs-hidden-stop');
  const a = await w.org('A', undefined, { establishedOn: '2026-09-30' });
  const h = await w.org('隐藏 H', a.id, { establishedOn: '2026-09-30' });
  const options = {
    ifMatch: 0,
    idempotencyKey: randomUUID(),
    body: {
      rootOrgId: a.id,
      depth: 2,
      hiddenOrgIds: [h.id],
      showKeyPositions: false,
      showPositionsWithoutSuccessor: true,
    },
  };
  const first = await w.request('PUT', '/maps/position/preferences', options);
  expect(first.status).toBe(200);
  const original = await first.json();
  await stop(w, h);
  const replay = await w.request('PUT', '/maps/position/preferences', options);
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toEqual(original);
  expect(await runs(w)).toHaveLength(1);
  expect(
    (
      await w.request('PUT', '/maps/position/preferences', {
        ...options,
        ifMatch: 1,
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await w.request('PUT', '/maps/position/preferences', {
        ifMatch: 1,
        body: { ...options.body, hiddenOrgIds: [] },
      })
    ).status,
  ).toBe(200);
  expect(await runs(w)).toHaveLength(2);
});

it('AC-SC-map-lifecycle 根停用：显示和新提交 404，原统计/偏好回执仍可重放', async () => {
  const w = await successionWorld(db().db, 'sc-map-root-stop');
  const a = await w.org('根 A', undefined, { establishedOn: '2026-09-30' });
  const body = { rootOrgId: a.id, depth: 2, hiddenOrgIds: [] };
  const stats = { ifMatch: 0, idempotencyKey: randomUUID(), body };
  const prefs = {
    ...stats,
    idempotencyKey: randomUUID(),
    body: {
      ...body,
      showKeyPositions: false,
      showPositionsWithoutSuccessor: true,
    },
  };
  const saved = await w.request('PUT', '/maps/position/preferences', prefs);
  expect(saved.status).toBe(200);
  const preferenceReceipt = await saved.json();
  const first = await w.request('POST', '/maps/org/compute-stats', stats);
  expect(first.status).toBe(202);
  const statReceipt = await first.json();
  await stop(w, a);
  await expect(w.asTenant((tx) => readMapDisplayScope(tx, context(w), 'position'))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(
    (
      await w.request('POST', '/maps/org/compute-stats', {
        ...stats,
        idempotencyKey: randomUUID(),
      })
    ).status,
  ).toBe(404);
  const replay = await w.request('POST', '/maps/org/compute-stats', stats);
  expect(replay.status, await replay.clone().text()).toBe(202);
  expect(await replay.json()).toEqual(statReceipt);
  const prefReplay = await w.request('PUT', '/maps/position/preferences', prefs);
  expect(prefReplay.status, await prefReplay.clone().text()).toBe(200);
  expect(await prefReplay.json()).toEqual(preferenceReceipt);
  expect(await runs(w)).toHaveLength(2);
});

it.each(['统计', '偏好'] as const)(
  'AC-SC-map-lifecycle %s已提交后隐藏组织停用、回包丢失，失败回查恢复原回执',
  async (kind) => {
    const w = await successionWorld(db().db, `sc-map-recovery-${kind}`);
    const a = await w.org('A', undefined, { establishedOn: '2026-09-30' });
    const h = await w.org('隐藏 H', a.id, { establishedOn: '2026-09-30' });
    const compute = kind === '统计',
      status = compute ? 202 : 200;
    let unknown = true;
    const transaction: Db['transaction'] = async (callback, config) => {
      const result = await w.db.transaction(callback, config);
      if (unknown && result && typeof result === 'object' && 'status' in result && result.status === status) {
        unknown = false;
        await stop(w, h);
        throw new Error('模拟已提交、组织停用且回包丢失');
      }
      return result;
    };
    const wrapped = new Proxy(w.db, {
      get(target, key, receiver) {
        return key === 'transaction' ? transaction : Reflect.get(target, key, receiver);
      },
    });
    const api = tenantApi(wrapped, { clock: () => SC_NOW });
    const body = {
      rootOrgId: a.id,
      depth: 2,
      hiddenOrgIds: [h.id],
      ...(compute
        ? {}
        : {
            showKeyPositions: false,
            showPositionsWithoutSuccessor: true,
          }),
    };
    const path = compute
      ? '/api/tenant/succession/maps/org/compute-stats'
      : '/api/tenant/succession/maps/position/preferences';
    const options = { user: w.user.id, tenant: w.tenant.id, ifMatch: 0, body, idempotencyKey: randomUUID() };
    const recovered = await api.request(compute ? 'POST' : 'PUT', path, options);
    expect(unknown).toBe(false);
    expect(recovered.status, await recovered.clone().text()).toBe(status);
    const receipt = await recovered.json();
    const replay = await api.request(compute ? 'POST' : 'PUT', path, options);
    expect(replay.status).toBe(status);
    expect(await replay.json()).toEqual(receipt);
    expect(await runs(w)).toHaveLength(1);
  },
);

it('AC-SC-map-lifecycle 不重验启用门槛仍复核原集合授权；范围撤销后重放 404', async () => {
  const w = await successionWorld(db().db, 'sc-original-scope-revoked');
  const a = await w.org('A', undefined, { establishedOn: '2026-09-30' });
  const h = await w.org('隐藏 H', a.id, { establishedOn: '2026-09-30' });
  let hasScope = true;
  const api = tenantApi(w.db, {
    clock: () => SC_NOW,
    authorize: (q) => q.action !== 'data.scope.all' || hasScope,
  });
  const options = {
    user: w.user.id,
    tenant: w.tenant.id,
    ifMatch: 0,
    idempotencyKey: randomUUID(),
    body: { rootOrgId: a.id, depth: 2, hiddenOrgIds: [h.id] },
  };
  const path = '/api/tenant/succession/maps/org/compute-stats';
  expect((await api.request('POST', path, options)).status).toBe(202);
  await stop(w, h);
  hasScope = false;
  const before = await runs(w);
  expect((await api.request('POST', path, options)).status).toBe(404);
  expect(await runs(w)).toEqual(before);
});
