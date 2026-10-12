/** C3 开工红测：先固定设计 §2.2 #7 / §5.8 明确的入口与日期约束。
 * roots 的对象类型及其与 C1 显示范围的关系待总编排确认，暂不写入推断规则。
 */
import { type DbHandle } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { successionWorld } from './AC-SC-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());

it('AC-SC-06 Map.view 可读取职位继任地图入口', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-entry');
  const org = await w.org('职位地图组织');
  await w.position(org.id, '职位地图根');
  const response = await w.request('GET', '/maps/position');
  expect(response.status, await response.clone().text()).toBe(200);
});

it('AC-SC-06 历史日期须合法，未来日期返回 AS_OF_IN_FUTURE', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-date');
  const malformed = await w.request('GET', '/maps/position?asOf=2026-13-40');
  expect(malformed.status, await malformed.clone().text()).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  const future = await w.request('GET', '/maps/position?asOf=2026-10-02');
  expect(future.status, await future.clone().text()).toBe(400);
  expect(await future.json()).toMatchObject({
    error: { code: 'VALIDATION_FAILED', details: { reason: 'AS_OF_IN_FUTURE' } },
  });
});

it('AC-SC-06 只有 Record.view、没有 Map.view 的业务人员返回 403', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-no-map');
  const world = await permissionWorldOf(w);
  const viewer = await recordOperator(world);
  const response = await viewer.request('GET', '/maps/position');
  expect(response.status, await response.clone().text()).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
});
