/**
 * AC-SC-guards（R3-T05 A1 第 2 轮，DEC-368①，设计 §5.8）：资源归属只按“今天”的管理范围判断——asOf 查历史时，
 * 职位继任的范围锚点也用职位今天所属的组织，不用 asOf 当日的历史组织。职位从 A 部划到 B 部后：
 * 只管 A 部的 HR 今天与迁移前的 asOf 都是 404、不在列表也不计数；管 B 部的 HR 两者都可见。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { type RecordList, successionWorld } from './AC-SC-support.js';
import { errorCode, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-SC-guards 职位继任的范围锚点按今天归属（DEC-368①）', () => {
  it('职位 A → B：管 A 的 HR 今天与迁移前 asOf 都 404 / 不计数；管 B 的 HR 两者可见', async () => {
    const w = await successionWorld(testDb().db, 'sc-anchor');
    const std = await w.standard();
    const moved = await w.position(std.orgA.id, '调组职位');
    const record = await w.insertRecord({
      type: 'position',
      targetId: moved.id,
      successorId: std.successor1.id,
      startDate: '2026-10-01',
    });
    const move = await w.call('PATCH', `job/positions/${moved.id}`, {
      ifMatch: moved.revision,
      body: { orgId: std.orgB.id, effectiveDate: '2026-10-02' },
    });
    expect(move.status, await move.clone().text()).toBe(200);

    const world = await permissionWorldOf(w);
    const inA = await recordOperator(world, { orgIds: [std.orgA.id] });
    const inB = await recordOperator(world, { orgIds: [std.orgB.id] });
    // 请求日 2026-10-03：职位今天属于 B 部
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-03T01:00:00Z') });
    const get = (who: { as: { user: string; tenant: string } }, path: string) =>
      api.request('GET', `/api/tenant/succession${path}`, who.as);

    for (const asOf of ['', '?asOf=2026-10-01']) {
      const hidden = await get(inA, `/records/${record}${asOf}`);
      expect([hidden.status, await errorCode(hidden)], `管 A ${asOf}`).toEqual([404, 'NOT_FOUND']);
      const list = (await (await get(inA, `/records?status=all${asOf.replace('?', '&')}`)).json()) as RecordList;
      expect([list.items.length, list.total], `管 A 列表 ${asOf}`).toEqual([0, 0]);
      expect((await get(inB, `/records/${record}${asOf}`)).status, `管 B ${asOf}`).toBe(200);
      const visible = (await (await get(inB, `/records?status=all${asOf.replace('?', '&')}`)).json()) as RecordList;
      expect(
        visible.items.map((item) => item.id),
        `管 B 列表 ${asOf}`,
      ).toEqual([record]);
      expect(visible.total).toBe(1);
    }
  });
});
