/** DEC-453③：组织卡片复用 B4 当前结果，权限与业务 asOf 分离。 */
import { expect, it } from 'vitest';
import { sql } from '@italent/db';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { tenantApi } from './support/tenant-api.js';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { successionWorld } from './AC-SC-support.js';
import { mapOperator, mapView } from './AC-SC-org-map-support.js';
const db = useHealthDb();

it('AC-SC-org-map 有风险结果按 B4 投影展示，历史地图仍标当前结果时间', async () => {
  const w = await successionWorld(db().db, 'c2-risk-result');
  const s = await w.standard();
  const created = await w.request('POST', '/risk-levels', {
    ifMatch: 0,
    body: { code: 'HIGH', name: '高风险', color: '#123456', rules: null },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const levelId = ((await created.json()) as { id: string }).id;
  await w.asTenant((tx) =>
    tx.execute(sql`INSERT INTO succession_risk_results
    (tenant_id,position_id,level_id,method,computed_at,revision)
    VALUES (${w.tenant.id}::uuid,${s.keyPosition.id}::uuid,${levelId}::uuid,'computed',
      '2026-10-01T00:30:00Z'::timestamptz,2)`),
  );
  const viewer = await mapOperator(w, { seeAll: true, risk: true });
  const card = (await viewer.read({ root: s.orgA.id, asOf: '2026-10-01' })).items[0]!.keyPositions![0]!;
  const direct = await viewer.request('GET', '/risk-results');
  expect(direct.status).toBe(200);
  const rows = ((await direct.json()) as { items: Record<string, unknown>[] }).items;
  expect(card.risk).toEqual({ ...rows[0], resultAsOf: '2026-10-01T00:30:00.000Z' });
  expect(card.risk).toMatchObject({
    positionId: s.keyPosition.id,
    levelId,
    levelName: '高风险',
    levelColor: '#123456',
  });
  const futureApi = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-03T01:00:00Z') });
  const history = await futureApi.request(
    'GET',
    `/api/tenant/succession/maps/org?root=${s.orgA.id}&asOf=2026-10-01`,
    viewer.as,
  );
  expect(history.status).toBe(200);
  expect((await history.json()).items[0].keyPositions[0].risk).toEqual(card.risk);
  await viewer.permit('riskResult', ['levelId', 'levelName', 'levelColor', 'computedAt']);
  const hidden = (await viewer.read({ root: s.orgA.id })).items[0]!.keyPositions![0]!.risk!;
  for (const key of ['levelId', 'levelName', 'levelColor', 'computedAt', 'resultAsOf'])
    expect(hidden).not.toHaveProperty(key);
});

it('AC-SC-org-map 无风险结果展示默认颜色，读取不建结果行', async () => {
  const w = await successionWorld(db().db, 'c2-risk-empty');
  const s = await w.standard();
  await w.asTenant((tx) =>
    tx.execute(sql`INSERT INTO succession_rule_settings (tenant_id,kind,default_color)
    VALUES (${w.tenant.id}::uuid,'position_risk','#abcdef')
    ON CONFLICT (tenant_id,kind) DO UPDATE SET default_color=excluded.default_color`),
  );
  const card = (await mapView(w, { root: s.orgA.id })).items[0]!.keyPositions![0]!;
  expect(card.risk).toMatchObject({
    levelId: null,
    levelName: null,
    levelColor: '#abcdef',
    computedAt: null,
    resultAsOf: null,
  });
  const count = await w.asTenant((tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM succession_risk_results
    WHERE tenant_id=${w.tenant.id}::uuid`),
  );
  expect(rowsOf<{ n: number }>(count)[0]!.n).toBe(0);
});

it('AC-SC-org-map 无风险查看权或范围时风险键缺席，关键职位与继任卡片仍展示', async () => {
  const w = await successionWorld(db().db, 'c2-risk-rights');
  const s = await w.standard();
  const denied = await mapOperator(w, { seeAll: true });
  const card = (await denied.read({ root: s.orgA.id })).items[0]!.keyPositions![0]!;
  expect(card.id).toBe(s.keyPosition.id);
  expect(card).not.toHaveProperty('risk');
  await denied.permit('riskResult');
  // permit 继承 seeAll；显式撤销该结果对象范围。
  await w.asTenant((tx) =>
    tx.execute(sql`UPDATE permission_identity_scopes SET see_all=false
    WHERE tenant_id=${w.tenant.id}::uuid AND profile_id=${denied.profile.id}::uuid
      AND target_code='Succession.RiskResult'`),
  );
  expect((await denied.read({ root: s.orgA.id })).items[0]!.keyPositions![0]!).not.toHaveProperty('risk');
});
