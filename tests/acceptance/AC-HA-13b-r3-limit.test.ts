/**
 * BE-13b 第 3 轮返工回归（派单第三节第 1 项③、第 4 项）：编制对象的单次统计上限 5000。
 * 造数用 SQL 批量插入编制对象与版本（API 逐条建几千个太慢）；插入后整个租户的编制都接近 / 超过上限，所以单独一个库。
 * - 第 4 项：覆盖取数时点的编制对象 4999 / 5000 / 5001 个 → 200 / 200 / 413（取到第 5001 条才报超限）；
 * - 第 1 项③：月度方案下某组织有 5000 个以上已结束的历史对象（期间按天合成，只为凑数量），当月编制经 API 建；
 *   历史对象不进统计，看板与 6.29 明细 200。这条用数据范围只看该组织，不受第 4 项留下的 5001 个对象影响。
 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { managementScope, restrictedAuthorizer } from './AC-HA-13a-support.js';
import { MOVEMENT_BASE as BASE, movementClient, movementWorld, type MovementWorld } from './AC-HA-13b-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();
const AS_OF = '2026-10-06';
const BOARD = `${BASE}?asOf=${AS_OF}`;

describe('AC-HA-13b 第 3 轮：编制对象单次统计上限', () => {
  let w: MovementWorld;
  beforeAll(async () => {
    w = await movementWorld(database().db);
  }, 600_000);

  async function scheme(periodType: 'annual' | 'monthly') {
    const body = {
      name: `合成上限方案-${uniqueSuffix()}`,
      periodType,
      startMonth: 1,
      subdivision: 'none',
      maintenanceMode: 'inclusive',
      startDate: '2000-01-01',
    };
    const response = await w.call('POST', '/api/tenant/establishment/schemes', { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }
  /** 批量插入编制对象（每个一版）：period_start = 起点 + offset 天（offset ∈ [from, to]），版本自期间首日生效。 */
  async function insertObjects(input: {
    orgId: string;
    schemeId: string;
    start: string;
    from: number;
    to: number;
    periodEnd: 'same-day' | string;
  }) {
    const periodStart = sql`(${input.start}::date + g)`;
    const periodEnd = input.periodEnd === 'same-day' ? periodStart : sql`${input.periodEnd}::date`;
    await w.x.sqlRows(sql`WITH o AS (
        INSERT INTO establishment_objects(tenant_id, org_id, scheme_id, period_start, period_end)
        SELECT ${w.tenantId}::uuid, ${input.orgId}::uuid, ${input.schemeId}::uuid, ${periodStart}, ${periodEnd}
        FROM generate_series(${input.from}::int, ${input.to}::int) g
        RETURNING id, period_start
      )
      INSERT INTO establishment_versions(tenant_id, object_id, version_no, start_date, inclusive_capacity)
      SELECT ${w.tenantId}::uuid, o.id, 1, o.period_start, 1 FROM o`);
  }
  const covering = async () =>
    (
      await w.x.sqlRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM establishment_objects
        WHERE tenant_id = ${w.tenantId}::uuid AND period_start <= ${AS_OF}::date AND period_end >= ${AS_OF}::date`)
    )[0]!.n;

  it('第 4 项：覆盖时点的编制对象 4999 / 5000 / 5001 个 → 200 / 200 / 413', async () => {
    const c = movementClient(w.db, w.who);
    const org = await w.org(`上限部-${uniqueSuffix()}`);
    const schemeId = await scheme('annual');
    const baseline = await covering();
    expect(baseline).toBeLessThan(4999);
    // 期间都覆盖 asOf：起点从 asOf 往前逐天错开（同组织同方案按期间起点唯一），止于年底
    let inserted = 0;
    const fillTo = async (target: number) => {
      const need = target - baseline - inserted;
      const range = { from: -(inserted + need - 1), to: -inserted };
      await insertObjects({ orgId: org.id, schemeId, start: AS_OF, ...range, periodEnd: '2026-12-31' });
      inserted += need;
      expect(await covering()).toBe(target);
    };
    const statuses: Record<number, number> = {};
    for (const target of [4999, 5000, 5001]) {
      await fillTo(target);
      const response = await c.get(BOARD);
      statuses[target] = response.status;
      if (target === 5001) expect(await response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    }
    expect(statuses).toEqual({ 4999: 200, 5000: 200, 5001: 413 });
  });

  it('第 1 项③：月度方案下 5000 个以上已结束的历史对象不进统计，看板与 6.29 明细 200', async () => {
    const org = await w.org(`历史对象部-${uniqueSuffix()}`);
    const schemeId = await scheme('monthly');
    await insertObjects({ orgId: org.id, schemeId, start: '2000-01-01', from: 0, to: 5100, periodEnd: 'same-day' });
    const body = { orgId: org.id, schemeId, periodStart: '2026-10-01', inclusiveCapacity: 3, strictControl: false };
    const created = await w.call('POST', '/api/tenant/establishment/capacities', { ifMatch: 0, body });
    expect(created.status, await created.clone().text()).toBe(201);
    const current = ((await created.json()) as { id: string }).id;
    await w.hire(`历史对象部员工-${uniqueSuffix()}`, '2026-02-02', org);

    const authorize = restrictedAuthorizer({ scope: managementScope(w.tenantId, [org.id]) });
    const c = movementClient(w.db, w.who, authorize);
    for (const path of [BOARD, `${BASE}/components/6.29?asOf=${AS_OF}`]) {
      const response = await c.get(path);
      expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    }
    const groups = await c.groups('3.1.36', `asOf=${AS_OF}`);
    expect(groups.map((g) => ({ key: g.key, count: g.count }))).toEqual([{ key: current, count: 1 }]);
  });
});
