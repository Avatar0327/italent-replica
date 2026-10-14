/** C2 的历史读取按今天授权；真实范围断层与结果对象范围分别校验。 */
import { expect, it } from 'vitest';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { successionWorld } from './AC-SC-support.js';
import { mapOperator, mapSetting, queryOf, type OrgMap } from './AC-SC-org-map-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
const db = useHealthDb();

it('AC-SC-org-map 组织范围 A/C、不可见 B 时从 A 截断，不把 C 暴露成新根', async () => {
  const w = await successionWorld(db().db, 'c2-gap');
  const a = await w.org('A'),
    b = await w.org('B', a.id),
    c = await w.org('C', b.id);
  const viewer = await mapOperator(w);
  const mou = await viewer.world.api.request('POST', '/api/tenant/permission/mous', {
    ...viewer.world.asAdmin,
    ifMatch: 0,
    body: {
      code: `gap-${uniqueSuffix()}`,
      name: '只含 A C',
      orgRanges: [a.id, c.id].map((orgId) => ({ orgId, includeDescendants: false })),
    },
  });
  expect(mou.status).toBe(201);
  const assigned = await viewer.world.api.request(
    'PUT',
    `/api/tenant/permission/scopes/${viewer.userId}/SuccessionAndDevelopment`,
    {
      ...viewer.world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id },
    },
  );
  expect(assigned.status).toBe(200);
  expect((await viewer.read({ root: a.id })).items.map((o) => o.id)).toEqual([a.id]);
  expect((await viewer.read({ root: c.id })).items.map((o) => o.id)).toEqual([c.id]);
  expect((await viewer.request('GET', `/maps/org?root=${b.id}`)).status).toBe(404);
});

it('AC-SC-org-map 历史 SELF 按当前负责人判断，嵌套职位迁出当前范围后不返回历史名称或继任', async () => {
  const w = await successionWorld(db().db, 'c2-current-rights');
  const s = await w.standard();
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.successor1.id });
  await w.insertRecord({ type: 'position', targetId: s.keyPosition.id, successorId: s.successor2.id });
  const patch = await w.patchOrg(
    { id: s.orgA.id, revision: 2 },
    {
      name: '当前负责人组织',
      personInChargeId: s.successor2.id,
      addEmployment: false,
      effectiveDate: '2026-10-02',
    },
  );
  expect(patch.status, await patch.clone().text()).toBe(200);
  const moved = await w.call('PATCH', `job/positions/${s.keyPosition.id}`, {
    ifMatch: s.keyPosition.revision,
    body: { orgId: s.orgB.id, effectiveDate: '2026-10-02' },
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const viewer = await mapOperator(w, { userId: await w.userOf(s.successor2), orgIds: [s.orgA.id] });
  await mapSetting(w, 'self_successors_visible', false);
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-03T01:00:00Z') });
  const response = await api.request(
    'GET',
    `/api/tenant/succession/maps/org${queryOf({
      root: s.orgA.id,
      asOf: '2026-10-01',
    })}`,
    viewer.as,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const card = ((await response.json()) as OrgMap).items[0]!;
  expect(card.personInCharge).toMatchObject({ employeeId: s.head.id });
  expect(card).not.toHaveProperty('successors');
  expect(card).not.toHaveProperty('successorCount');
  expect(card.keyPositions).toEqual([]);
});

it('AC-SC-org-map 结果对象字段与范围独立；无记录对象查看权也不会输出继任者载荷或计数', async () => {
  const w = await successionWorld(db().db, 'c2-result-scope');
  const s = await w.standard();
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.successor1.id });
  const viewer = await mapOperator(w, { orgIds: [s.orgA.id], health: true });
  expect((await viewer.read({ root: s.orgA.id })).items[0]!.health).toMatchObject({
    levelId: null,
    levelName: null,
    levelColor: '#F2F3F5',
    resultAsOf: null,
  });
  const api = tenantApi(w.db, {
    authorize: (q) => !(q.action === 'object.view' && q.resource === 'Succession.Record'),
  });
  const denied = await api.request('GET', `/api/tenant/succession/maps/org?root=${s.orgA.id}`, {
    user: w.user.id,
    tenant: w.tenant.id,
  });
  expect(denied.status).toBe(200);
  const card = ((await denied.json()) as OrgMap).items[0]!;
  for (const key of ['successors', 'successorCount', 'personInCharge']) expect(card).not.toHaveProperty(key);
  const scoped = tenantApi(w.db, {
    authorize: (q) => !(q.action === 'data.scope.all' && q.resource === 'Succession.HealthResult'),
  });
  const out = await scoped.request('GET', `/api/tenant/succession/maps/org?root=${s.orgA.id}`, {
    user: w.user.id,
    tenant: w.tenant.id,
  });
  expect(out.status).toBe(200);
  const withoutHealth = ((await out.json()) as OrgMap).items[0]!;
  expect(withoutHealth).not.toHaveProperty('health');
  expect(withoutHealth.successorCount).toBe(1);
});
