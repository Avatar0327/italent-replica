/** 第 2 轮 P2-1：历史统计缺缓存时复用 C1 人数与日缓存，当前权限控制触发集合。 */
import { expect, it } from 'vitest';
import { sql } from '@italent/db';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { successionWorld } from './AC-SC-support.js';
import { mapOperator, type OrgMap } from './AC-SC-org-map-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
const db = useHealthDb();
const now = new Date('2026-10-03T01:00:00Z');

it('AC-SC-org-map 历史任职无缓存：返回人数并写入历史业务日，保留来源且重复读取不重复登记', async () => {
  const w = await successionWorld(db().db, 'c2-history-count');
  const root = await w.org('历史统计根'),
    child = await w.org('行政下级', root.id);
  const outside = await w.org('范围外组织');
  await w.hire('根员工', { departmentId: root.id });
  await w.hire('下级员工', { departmentId: child.id });
  await w.hire('范围外员工', { departmentId: outside.id });
  await w.hire('历史日尚未入职', { departmentId: root.id }, '2026-10-02');
  const viewer = await mapOperator(w, { orgIds: [root.id, child.id] });
  const api = tenantApi(w.db, { authorize: undefined, clock: () => now });
  const path = `/api/tenant/succession/maps/org?root=${root.id}&asOf=2026-10-01`;
  const read = async () => {
    const response = await api.request('GET', path, viewer.as);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OrgMap;
  };
  const [first, concurrent] = await Promise.all([read(), read()]);
  expect(concurrent).toEqual(first);
  expect(first.items.map((o) => [o.id, o.stats?.onDutyCount])).toEqual([
    [root.id, 2],
    [child.id, 1],
  ]);
  const cached = () =>
    w.asTenant(async (tx) =>
      rowsOf<{
        orgId: string;
        n: number;
        day: string;
        slot: string;
        runId: string;
        sourceDay: string;
        requester: string;
      }>(
        await tx.execute(sql`SELECT s.org_id AS "orgId",s.on_duty_count AS n,s.stat_date::text AS day,
    s.slot_key AS slot,s.run_id AS "runId",r.business_date::text AS "sourceDay",r.requested_by AS requester
    FROM succession_org_stats s JOIN succession_calc_runs r ON r.tenant_id=s.tenant_id AND r.id=s.run_id
    WHERE s.tenant_id=${w.tenant.id}::uuid ORDER BY s.on_duty_count DESC`),
      ),
    );
  const before = await cached();
  expect(before.map((r) => [r.orgId, r.n])).toEqual([
    [root.id, 2],
    [child.id, 1],
  ]);
  for (const row of before)
    expect(row).toMatchObject({
      day: '2026-10-01',
      sourceDay: '2026-10-01',
      slot: 'history:2026-10-01',
      requester: viewer.userId,
    });
  const runs = await w.asTenant(async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT object_id FROM succession_calc_run_objects
    WHERE tenant_id=${w.tenant.id}::uuid ORDER BY object_id`),
    ),
  );
  expect(runs).toHaveLength(2);
  await read();
  expect(await cached()).toEqual(before);
  const after = await w.asTenant(async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT id FROM succession_calc_runs
    WHERE tenant_id=${w.tenant.id}::uuid`),
    ),
  );
  expect(after).toHaveLength(1);
});

it('AC-SC-org-map stats 字段无权时不补历史缓存；查看当前日仍只读已有缓存', async () => {
  const w = await successionWorld(db().db, 'c2-history-hidden');
  const root = await w.org('统计字段隐藏');
  await w.hire('在岗员工', { departmentId: root.id });
  const viewer = await mapOperator(w, { seeAll: true, mapHidden: ['stats'] });
  const api = tenantApi(w.db, { authorize: undefined, clock: () => now });
  const hidden = await api.request('GET', `/api/tenant/succession/maps/org?root=${root.id}&asOf=2026-10-01`, viewer.as);
  expect(hidden.status).toBe(200);
  expect((await hidden.json()).items[0]).not.toHaveProperty('stats');
  await viewer.permit('map');
  const current = await api.request('GET', `/api/tenant/succession/maps/org?root=${root.id}`, viewer.as);
  expect(current.status).toBe(200);
  expect((await current.json()).items[0].stats.onDutyCount).toBeNull();
  const rows = await w.asTenant(async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT id FROM succession_calc_runs
    WHERE tenant_id=${w.tenant.id}::uuid`),
    ),
  );
  expect(rows).toEqual([]);
});
