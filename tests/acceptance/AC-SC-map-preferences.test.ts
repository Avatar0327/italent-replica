/** DEC-443：仅职位地图的个人筛选；管理员显示开关走租户设置。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { successionWorld, type SuccessionWorld } from './AC-SC-support.js';
import { tenantApi } from './support/tenant-api.js';

const db = useTestDb();
let w: SuccessionWorld, rootId: string, hiddenId: string;
const PATH = '/maps/position/preferences';
const preferences = () => ({
  rootOrgId: rootId.toUpperCase(),
  depth: 3,
  hiddenOrgIds: [hiddenId.toUpperCase()],
  showKeyPositions: false,
  showPositionsWithoutSuccessor: true,
});
const runs = () =>
  w.asTenant(async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT idempotency_key
  FROM succession_calc_runs WHERE trigger='preferences_change' ORDER BY idempotency_key`),
    ),
  );
const setting = (key: string, value: boolean) =>
  w.call('PUT', `settings/succession.${key}`, {
    ifMatch: 0,
    body: { value },
  });

beforeAll(async () => {
  w = await successionWorld(db().db, 'sc-c1-preferences');
  rootId = (await w.org('显示根组织')).id;
  hiddenId = (await w.org('隐藏组织', rootId)).id;
});

describe('AC-SC-map-preferences DEC-443', () => {
  it('个人初值 true / false；无个人 hideVirtual / showIncumbents；组织偏好拒绝', async () => {
    const response = await w.request('GET', PATH);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ depth: 3, revision: 0, showKeyPositions: false, showPositionsWithoutSuccessor: true });
    expect(view).not.toHaveProperty('hideVirtual');
    expect(view).not.toHaveProperty('showIncumbents');
    expect((await w.request('GET', '/maps/org/preferences')).status).toBe(400);
    expect((await w.request('PUT', '/maps/org/preferences', { ifMatch: 0, body: preferences() })).status).toBe(400);
    expect(await runs()).toEqual([]);
  });

  it('保存读回 UUID 规范化，重放不递增；个人变更触发统计，相同值不重复触发', async () => {
    const input = { ifMatch: 0, idempotencyKey: randomUUID(), body: preferences() };
    const first = await w.request('PUT', PATH, input);
    expect(first.status, await first.clone().text()).toBe(200);
    const saved = await first.json();
    expect(saved).toMatchObject({ ...preferences(), rootOrgId: rootId, hiddenOrgIds: [hiddenId], revision: 1 });
    expect((await w.request('PUT', PATH, input)).status).toBe(200);
    expect(await (await w.request('GET', PATH)).json()).toEqual(saved);
    expect(await runs()).toEqual([{ idempotency_key: `org_stats:preferences:${w.user.id}:1` }]);
    const conflict = await w.request('PUT', PATH, { ifMatch: 0, body: { ...preferences(), showKeyPositions: true } });
    expect(conflict.status).toBe(409);
    expect(await (await w.request('GET', PATH)).json()).toEqual(saved);
    const body = { ...preferences(), showKeyPositions: true };
    expect((await w.request('PUT', PATH, { ifMatch: 1, body })).status).toBe(200);
    expect(await runs()).toHaveLength(2);
    expect((await w.request('PUT', PATH, { ifMatch: 2, body })).status).toBe(200);
    expect(await runs()).toHaveLength(2);
  });

  it('白名单拒绝 hideVirtual / showIncumbents，数量 / 层数非法也拒绝且不写', async () => {
    const before = await (await w.request('GET', PATH)).json();
    for (const extra of [
      { hideVirtual: true },
      { showIncumbents: false },
      { depth: 1 },
      { hiddenOrgIds: Array.from({ length: 201 }, () => randomUUID()) },
      { userId: randomUUID() },
    ]) {
      expect((await w.request('PUT', PATH, { ifMatch: 3, body: { ...preferences(), ...extra } })).status).toBe(400);
    }
    expect(await (await w.request('GET', PATH)).json()).toEqual(before);
    const columns = rowsOf<{ column_name: string }>(
      await db().db.execute(sql`SELECT column_name
      FROM information_schema.columns WHERE table_name='succession_map_preferences'`),
    ).map((r) => r.column_name);
    expect(columns).not.toContain('hide_virtual');
    expect(columns).not.toContain('show_incumbents');
  });

  it('租户默认值与覆盖可读取；个人不可改，管理员变更两键不触发统计', async () => {
    for (const [key, value] of [
      ['hide_virtual_org', false],
      ['show_incumbents', true],
    ] as const) {
      const read = await w.call('GET', `settings/succession.${key}`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ value, source: 'system', revision: 0 });
    }
    const before = await runs();
    const personal = tenantApi(w.db, { authorize: (q) => q.action !== 'tenant.settings.write' });
    expect(
      (
        await personal.request('PUT', '/api/tenant/settings/succession.hide_virtual_org', {
          user: w.user.id,
          tenant: w.tenant.id,
          ifMatch: 0,
          body: { value: true },
        })
      ).status,
    ).toBe(403);
    expect((await setting('hide_virtual_org', true)).status).toBe(200);
    expect((await setting('show_incumbents', false)).status).toBe(200);
    expect(await (await w.call('GET', 'settings/succession.show_incumbents')).json()).toMatchObject({ value: false });
    expect(await runs()).toEqual(before);
  });
});
