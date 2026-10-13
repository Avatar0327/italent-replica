/** D4 × B5：真实求值、统计缓存和结果表；不注入计算宿主或 SQL 存储替身。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { describe, expect, it } from 'vitest';
import { healthComputePort } from '../../apps/api/src/modules/succession/health-compute.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { successionWorld, SC_TODAY, type SuccessionWorld } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';

const db = useHealthDb();
async function level(w: SuccessionWorld, code: string, rows: object[]) {
  const response = await w.request('POST', '/health-levels', {
    ifMatch: 0,
    body: { code, name: code, color: '#336699', rules: { expression: '1', rows } },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()).id as string;
}
const countRow = {
  rowNo: 1,
  population: 'all',
  fieldSource: 'org',
  fieldCode: 'on_duty_count',
  measure: 'average',
  comparator: 'eq',
  threshold: 1,
};
function compute(w: SuccessionWorld, orgId: string) {
  return w.asTenant((tx) =>
    healthComputePort.compute(tx, {
      tenantId: w.tenant.id,
      principalUserId: w.user.id,
      context: { projectId: randomUUID(), meetingId: null },
      orgIds: [orgId],
      businessDate: SC_TODAY,
    }),
  );
}

describe('AC-SC-health-sync / SP-15 B5 真实集成', () => {
  it('在岗人数缓存缺失 / 命中都使用真实 run，计算终态不会被地图 worker 再执行', async () => {
    const w = await successionWorld(db().db, 'd4-b5-count');
    const org = await w.org('真实统计来源');
    await w.hire('合成在岗人员', { departmentId: org.id });
    await enableHealthRunner(w);
    const levelId = await level(w, 'COUNT_ONE', [countRow]);
    const cache = () =>
      w.asTenant(async (tx) =>
        rowsOf<{ run_id: string; on_duty_count: number }>(
          await tx.execute(sql`SELECT run_id,on_duty_count FROM succession_org_stats
        WHERE tenant_id=${w.tenant.id}::uuid AND org_id=${org.id}::uuid AND stat_date=${SC_TODAY}::date`),
        ),
      );
    expect(await cache()).toEqual([]);
    for (const hit of [false, true]) {
      const before = await cache();
      expect(await compute(w, org.id)).toEqual([{ orgId: org.id, levelId, levelCode: 'COUNT_ONE', failures: [] }]);
      const [stored] = await cache();
      expect(stored).toMatchObject({ run_id: expect.any(String), on_duty_count: 1 });
      if (hit) expect(await cache()).toEqual(before);
      expect(await runCalcPage(w.db, w.tenant.id, stored!.run_id)).toBe('succeeded');
    }
    const committed = await w.asTenant(async (tx) => ({
      runs: rowsOf(await tx.execute(sql`SELECT status FROM succession_calc_runs WHERE kind='org_health'`)),
      results: rowsOf(await tx.execute(sql`SELECT * FROM succession_health_results WHERE org_id=${org.id}::uuid`)),
    }));
    expect(committed.runs).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
    expect(committed.results).toEqual([]);
  });

  it.each(['unreferenced', 'later_level'])('DEC-460 项目计算与 B5 一致，拒绝 %s 的旧禁用组合', async (layout) => {
    const w = await successionWorld(db().db, `d4-b5-${layout}`);
    const org = await w.org('项目禁用组合');
    await w.hire('合成在岗人员', { departmentId: org.id });
    await enableHealthRunner(w);
    if (layout === 'later_level') await level(w, 'FIRST_MATCH', [countRow]);
    const rowNo = layout === 'unreferenced' ? 2 : 1;
    const supported = { ...countRow, rowNo, population: 'incumbents', fieldCode: null, measure: 'count' };
    const legacyId = await level(w, 'LEGACY', layout === 'unreferenced' ? [countRow, supported] : [supported]);
    // 模拟 B5 已有配置的禁用组合；当前 HTTP 保存入口本来就禁止创建它。
    await w.asTenant((tx) =>
      tx.execute(sql`UPDATE succession_health_level_rows SET population='all'
      WHERE tenant_id=${w.tenant.id}::uuid AND level_id=${legacyId}::uuid AND row_no=${rowNo}`),
    );
    expect(await compute(w, org.id)).toEqual([
      {
        orgId: org.id,
        levelId: null,
        levelCode: null,
        failures: [{ code: 'FIELD_FORBIDDEN', params: { levelId: legacyId, rowNo } }],
      },
    ]);
    const committed = await w.asTenant(async (tx) => ({
      runs: rowsOf(await tx.execute(sql`SELECT status FROM succession_calc_runs WHERE kind='org_health'`)),
      results: rowsOf(await tx.execute(sql`SELECT * FROM succession_health_results WHERE org_id=${org.id}::uuid`)),
      cache: rowsOf(await tx.execute(sql`SELECT * FROM succession_org_stats WHERE org_id=${org.id}::uuid`)),
    }));
    expect(committed).toEqual({ runs: [{ status: 'partial' }], results: [], cache: [] });
  });
});
