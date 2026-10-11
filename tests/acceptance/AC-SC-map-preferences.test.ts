/** C1：这里只断言设计已经明确的契约，不在红测里猜显示开关初值。 */
// TODO(需取证 #263)：总编排登记四个显示开关初值后，补 org / position 的完整默认值断言。
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { successionWorld, type SuccessionWorld } from './AC-SC-support.js';

const db = useTestDb();
let w: SuccessionWorld;
let rootId: string;
let hiddenId: string;
const preferences = () => ({
  rootOrgId: rootId.toUpperCase(),
  depth: 3,
  hiddenOrgIds: [hiddenId.toUpperCase()],
  hideVirtual: true,
  showKeyPositions: true,
  showPositionsWithoutSuccessor: false,
  showIncumbents: false,
});

beforeAll(async () => {
  w = await successionWorld(db().db, 'sc-c1-preferences');
  rootId = (await w.org('显示根组织')).id;
  hiddenId = (await w.org('隐藏组织', rootId)).id;
});

describe('AC-SC-map-preferences 个人显示设置', () => {
  it('尚未保存时层数取租户默认设置，读操作不写入偏好', async () => {
    const response = await w.request('GET', '/maps/org/preferences');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ depth: 3, revision: 0 });
    const rows = await w.asTenant((tx) =>
      tx.execute(sql`SELECT * FROM succession_map_preferences WHERE user_id = ${w.user.id}::uuid`),
    );
    expect(rowsOf(rows)).toEqual([]);
  });

  it('本人按地图种类保存、读回，包括 showIncumbents；UUID 规范化', async () => {
    const response = await w.request('PUT', '/maps/position/preferences', {
      ifMatch: 0,
      body: preferences(),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('etag')).toBe('"1"');
    const expected = { ...preferences(), rootOrgId: rootId, hiddenOrgIds: [hiddenId], revision: 1 };
    expect(await response.json()).toMatchObject(expected);
    const read = await w.request('GET', '/maps/position/preferences');
    expect(read.status, await read.clone().text()).toBe(200);
    expect(await read.json()).toMatchObject(expected);
    const otherKind = await w.request('GET', '/maps/org/preferences');
    expect(otherKind.status, await otherKind.clone().text()).toBe(200);
    expect(await otherKind.json()).toMatchObject({ revision: 0 });
  });

  it('同命令重放不递增 revision；旧 revision 的新命令返回 409 并保留偏好', async () => {
    const commandId = randomUUID();
    const input = { ifMatch: 0, idempotencyKey: commandId, body: preferences() };
    const first = await w.request('PUT', '/maps/org/preferences', input);
    expect(first.status, await first.clone().text()).toBe(200);
    const saved = await first.json();
    const replay = await w.request('PUT', '/maps/org/preferences', input);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toEqual(saved);
    const conflict = await w.request('PUT', '/maps/org/preferences', {
      ifMatch: 0,
      body: { ...preferences(), showIncumbents: true },
    });
    expect(conflict.status, await conflict.clone().text()).toBe(409);
    const read = await w.request('GET', '/maps/org/preferences');
    expect(await read.json()).toEqual(saved);
  });

  it('层数超出 2～4、隐藏组织超过 200、非白名单键均返回 400', async () => {
    for (const body of [
      { ...preferences(), depth: 1 },
      { ...preferences(), hiddenOrgIds: Array.from({ length: 201 }, () => randomUUID()) },
      { ...preferences(), userId: randomUUID() },
    ]) {
      const response = await w.request('PUT', '/maps/position/preferences', { ifMatch: 1, body });
      expect(response.status, await response.clone().text()).toBe(400);
    }
  });
});
