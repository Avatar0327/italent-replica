/** B4 / F-090b：列表只依赖读入口；写结果复核仍逐次检查查看权。 */
import { randomUUID } from 'node:crypto';
import type { DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { riskWorld } from './AC-SC-risk-support.js';
import { SC_BASE, SC_NOW } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';
import { scanPrimitives } from './support/route-policy/primitives.js';
import {
  closureText,
  indexSources,
  matchRegistrations,
  moduleDirs,
  scanRegistrations,
} from './support/route-policy/scan.js';

it('AC-SC-risk-route-policy：风险列表的源码闭包只承载查看入口，不展开写结果适配器的授权分支', () => {
  const path = `${SC_BASE}/risk-results`;
  const index = indexSources();
  const { module, dirs } = moduleDirs(path);
  const hits = matchRegistrations(scanRegistrations(index), 'GET', path, dirs);
  expect(hits).toHaveLength(1);
  const facts = scanPrimitives(
    {
      deep: hits.map((hit) => closureText(index, hit, 6)).join('\n'),
      near: hits.map((hit) => closureText(index, hit, 3)).join('\n'),
    },
    'GET',
    module,
    path,
  );
  expect(facts.object).toEqual(['objectContext']);
  expect(facts.button ?? []).toEqual([]);
});

let handle: DbHandle;
// 与 B4 其余验收一致：完整迁移在多工作区并行时可能超过公共建库的 60 秒。
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());

it('AC-SC-risk-route-policy：仅查看权可读风险结果；无按钮时赋值、清除与计算均拒绝', async () => {
  const w = await riskWorld(handle.db);
  expect((await w.assign(0)).status).toBe(200);
  const api = tenantApi(w.db, { clock: () => SC_NOW, authorize: (q) => q.action !== 'object.button' });
  const caller = { tenant: w.tenant.id, user: w.user.id };
  const read = await api.request('GET', `${SC_BASE}/risk-results`, caller);
  expect(read.status, await read.clone().text()).toBe(200);
  expect(await read.json()).toMatchObject({ items: [{ positionId: w.position.id, levelId: w.levelId }] });
  for (const levelId of [w.levelId, null])
    expect(
      (
        await api.request('PUT', `${SC_BASE}/risk-results/${w.position.id}`, {
          ...caller,
          ifMatch: 1,
          body: { levelId },
        })
      ).status,
    ).toBe(403);
  expect(
    (
      await api.request('POST', `${SC_BASE}/maps/position/compute-risk`, {
        ...caller,
        ifMatch: 0,
        body: {},
      })
    ).status,
  ).toBe(403);
  expect(await w.result()).toMatchObject({ level_id: w.levelId, method: 'manual', revision: 1 });
});

it('AC-SC-risk-route-policy：撤销风险查看权后，列表与赋值命令重放均拒绝且不改变原值', async () => {
  const w = await riskWorld(handle.db);
  const options = { ifMatch: 0, idempotencyKey: randomUUID(), body: { levelId: w.levelId } };
  expect((await w.request('PUT', `/risk-results/${w.position.id}`, options)).status).toBe(200);
  const api = tenantApi(w.db, {
    clock: () => SC_NOW,
    authorize: (q) => !(q.resource === 'Succession.RiskResult' && q.action === 'object.view'),
  });
  const caller = { tenant: w.tenant.id, user: w.user.id };
  expect((await api.request('GET', `${SC_BASE}/risk-results`, caller)).status).toBe(403);
  expect((await api.request('PUT', `${SC_BASE}/risk-results/${w.position.id}`, { ...caller, ...options })).status).toBe(
    403,
  );
  expect(await w.result()).toMatchObject({ level_id: w.levelId, method: 'manual', revision: 1 });
});
