/** C2 SC-R5～R7 / SC-R17：检查响应值和键缺席，覆盖真实授权及历史读取。 */
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { expect, it } from 'vitest';
import { useHealthDb } from './AC-SC-07-health-support.js';
import { successionWorld, SC_NOW, SC_TODAY, labelOf } from './AC-SC-support.js';
import { mapView, mapSetting, mapOperator, queryOf, type OrgMap } from './AC-SC-org-map-support.js';
import { tenantApi } from './support/tenant-api.js';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
const db = useHealthDb();

it('AC-SC-org-map 根 / 默认层数 / 子树隐藏 / 虚拟设置直接复用 C1 集合，卡片按顺序号展示', async () => {
  const w = await successionWorld(db().db, 'c2-tree');
  const root = await w.org('根');
  const later = await w.org('晚', root.id, { displayOrder: 9 });
  const earlier = await w.org('早', root.id, { displayOrder: 1 });
  const third = await w.org('第三层', earlier.id);
  const fourth = await w.org('第四层', third.id);
  const virtual = await w.org('虚拟', root.id, { isVirtual: true });
  const virtualChild = await w.org('虚拟下级', virtual.id);
  const all = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
  for (const depth of [2, 3, 4]) {
    const result = await mapView(w, { root: root.id, depth });
    const expected = await w.asTenant((tx) =>
      readMapDisplayScope(
        tx,
        { tenantId: w.tenant.id, userId: w.user.id, asOf: SC_TODAY, scope: all },
        'org',
        { rootOrgId: root.id, depth },
        'submitted',
      ),
    );
    expect(result.items.map((o) => o.id).sort()).toEqual(expected.sort());
    expect(result).toMatchObject({ rootId: root.id, depth, asOf: SC_TODAY, hasDataPermission: true });
    expect(
      result.items
        .filter((o) => o.parentId === root.id)
        .map((o) => o.id)
        .slice(0, 2),
    ).toEqual([earlier.id, later.id]);
  }
  expect((await mapView(w, { root: root.id })).items.map((o) => o.id)).not.toContain(fourth.id);
  await mapSetting(w, 'map_default_depth', 4);
  expect((await mapView(w, { root: root.id })).items.map((o) => o.id)).toContain(fourth.id);
  await mapSetting(w, 'hide_virtual_org', true);
  const hidden = await mapView(w, { root: root.id, hiddenOrgIds: [earlier.id] });
  expect(hidden.items.map((o) => o.id).sort()).toEqual([root.id, later.id].sort());
  for (const id of [third.id, fourth.id, virtual.id, virtualChild.id])
    expect(hidden.items.map((o) => o.id)).not.toContain(id);
  expect((await mapView(w, { root: root.id, hiddenOrgIds: [root.id] })).items).toEqual([]);
  expect((await mapView(w, { root: third.id, hiddenOrgIds: [earlier.id] })).items).toEqual([]);
  expect((await mapView(w, { root: virtualChild.id })).items).toEqual([]);
});

it('AC-SC-org-map 真实范围多同级选顺序号最小根、空范围 fail-closed、范围外与不存在同 404', async () => {
  const w = await successionWorld(db().db, 'c2-root-scope');
  const b = await w.org('B', w.tenant.id, { parents: { admin: { parentId: w.tenant.id, sequence: 9 } } });
  const a = await w.org('A', w.tenant.id, { parents: { admin: { parentId: w.tenant.id, sequence: 1 } } });
  const out = await w.org('范围外');
  const viewer = await mapOperator(w, { orgIds: [a.id, b.id] });
  expect(await viewer.read({})).toMatchObject({ rootId: a.id, items: [{ id: a.id }] });
  expect(await viewer.read({ root: b.id })).toMatchObject({ rootId: b.id, items: [{ id: b.id }] });
  const responses = [];
  for (const root of [out.id, randomUUID()]) {
    const response = await viewer.request('GET', `/maps/org?root=${root}`);
    expect(response.status).toBe(404);
    responses.push(await response.json());
  }
  expect(responses[0]).toEqual(responses[1]);
  const empty = await mapOperator(w);
  expect(await empty.read({})).toMatchObject({ rootId: null, hasDataPermission: false, items: [] });
  expect((await empty.request('GET', `/maps/org?root=${a.id}`)).status).toBe(404);
});

it('AC-SC-org-map 卡片负责人、继任者准备度 / 后备类型、关键职位现任；已结束 / 已删除不出现', async () => {
  const w = await successionWorld(db().db, 'c2-cards');
  const s = await w.standard();
  const readiness = await w.readiness('近期可接任');
  await w.insertRecord({
    type: 'org',
    targetId: s.orgA.id,
    successorId: s.successor1.id,
    readinessId: readiness.id,
    backupType: 'deputy',
  });
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.successor2.id, endDate: SC_TODAY });
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.incumbent.id, deleted: true });
  await w.insertRecord({ type: 'position', targetId: s.keyPosition.id, successorId: s.successor2.id });
  await w.position(s.orgA.id, '非关键', { isKey: false });
  const disabled = await w.position(s.orgA.id, '已停用');
  expect(
    (
      await w.call('PATCH', `job/positions/${disabled.id}`, {
        ifMatch: disabled.revision,
        body: { enabled: false, effectiveDate: SC_TODAY },
      })
    ).status,
  ).toBe(200);
  const viewer = await mapOperator(w, { orgIds: [s.orgA.id] });
  const card = (await viewer.read({ root: s.orgA.id })).items[0]!;
  expect(card.personInCharge).toMatchObject({ employeeId: s.head.id, label: labelOf(s.head) });
  expect(card.successorCount).toBe(1);
  expect(card.successors).toHaveLength(1);
  expect(card.successors![0]).toMatchObject({
    successor: { employeeId: s.successor1.id, label: labelOf(s.successor1) },
    readiness: { id: readiness.id, color: readiness.color },
    backupType: 'deputy',
    startDate: '2026-09-01',
  });
  expect(card.successors![0]).not.toHaveProperty('personInCharge');
  expect(card.keyPositions).toHaveLength(1);
  expect(card.keyPositions![0]).toMatchObject({
    id: s.keyPosition.id,
    incumbents: [{ employeeId: s.incumbent.id, label: labelOf(s.incumbent) }],
    successorCount: 1,
    successors: [{ successor: { employeeId: s.successor2.id } }],
  });
  await mapSetting(w, 'show_incumbents', false);
  const without = (await viewer.read({ root: s.orgA.id })).items[0]!;
  expect(without).not.toHaveProperty('personInCharge');
  expect(without.keyPositions![0]).not.toHaveProperty('incumbents');
  expect(without.keyPositions![0]!.successors![0]).not.toHaveProperty('incumbents');
  expect(without.successorCount).toBe(1);
});

it('AC-SC-org-map SELF 对空 / 非空组织及嵌套职位键缺席；关闭现任显示不改变 SELF', async () => {
  const w = await successionWorld(db().db, 'c2-self');
  const s = await w.standard();
  const empty = await w.org('本人空继任组织');
  await w.setHead(empty, s.head);
  const position = await w.position(s.orgA.id, '负责人本人任职');
  const response = await w.request('GET', `/records`);
  expect(response.status).toBe(200);
  // 本人同时是组织负责人和关键职位现任：职位任职走真实入职接口。
  const person = await w.hire('本人现任', { departmentId: s.orgA.id, positionId: position.id });
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.successor1.id });
  await w.insertRecord({ type: 'position', targetId: position.id, successorId: s.successor2.id });
  const head = await mapOperator(w, { userId: await w.userOf(s.head), seeAll: true });
  const incumbent = await mapOperator(w, { userId: await w.userOf(person), seeAll: true });
  await mapSetting(w, 'self_successors_visible', false);
  for (const org of [s.orgA, empty]) {
    const card = (await head.read({ root: org.id })).items[0]!;
    expect(card).not.toHaveProperty('successors');
    expect(card).not.toHaveProperty('successorCount');
  }
  const card = (await incumbent.read({ root: s.orgA.id })).items[0]!;
  expect(card.successorCount).toBe(1);
  const self = card.keyPositions!.find((p) => p.id === position.id)!;
  expect(self).not.toHaveProperty('successors');
  expect(self).not.toHaveProperty('successorCount');
  await mapSetting(w, 'show_incumbents', false);
  expect((await head.read({ root: s.orgA.id })).items[0]).not.toHaveProperty('successorCount');
  await mapSetting(w, 'self_successors_visible', true);
  expect((await head.read({ root: s.orgA.id })).items[0]!.successorCount).toBe(1);
});

it('AC-SC-org-map Map / Record 字段递归裁剪；没有 HealthResult 查看权时健康度键缺席', async () => {
  const w = await successionWorld(db().db, 'c2-fields');
  const s = await w.standard();
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.successor1.id });
  await w.insertRecord({ type: 'position', targetId: s.keyPosition.id, successorId: s.successor2.id });
  const viewer = await mapOperator(w, {
    orgIds: [s.orgA.id],
    hidden: ['successorEmployeeId', 'readinessId', 'personInCharge', 'incumbents'],
    mapHidden: ['stats', 'successorCount'],
  });
  const card = (await viewer.read({ root: s.orgA.id })).items[0]!;
  expect(card).not.toHaveProperty('health');
  expect(card).not.toHaveProperty('stats');
  expect(card).not.toHaveProperty('successorCount');
  expect(card).not.toHaveProperty('personInCharge');
  for (const item of [card, ...card.keyPositions!]) {
    expect(item).not.toHaveProperty('incumbents');
    expect(item).not.toHaveProperty('successorCount');
    expect(item.successors).toHaveLength(1);
    expect(item.successors![0]).not.toHaveProperty('successor');
    expect(item.successors![0]).not.toHaveProperty('successorEmployeeId');
    expect(item.successors![0]).not.toHaveProperty('readiness');
  }
  await viewer.permit('map', ['successors', 'keyPositions']);
  const trimmed = (await viewer.read({ root: s.orgA.id })).items[0]!;
  expect(trimmed).not.toHaveProperty('successors');
  expect(trimmed).not.toHaveProperty('keyPositions');
  expect(trimmed.successorCount).toBe(1);
});

it('AC-SC-org-map 历史树 / 名称 / 任职 / 继任按 asOf，健康度当前值标时点，统计按业务日且 GET 不写库', async () => {
  const w = await successionWorld(db().db, 'c2-history');
  const s = await w.standard();
  const levelId = randomUUID();
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO succession_health_levels(id,tenant_id,code,name,color,display_order)
      VALUES (${levelId}::uuid,${w.tenant.id}::uuid,'HEALTH','当前等级','#123456',1)`);
  });
  expect(
    (
      await w.request('PUT', `/health-results/${s.orgA.id}`, {
        ifMatch: 0,
        body: { levelId },
      })
    ).status,
  ).toBe(200);
  const run = await w.request('POST', '/maps/org/compute-stats', { ifMatch: 0, body: { rootOrgId: s.orgA.id } });
  expect(run.status).toBe(202);
  const { runId } = (await run.json()) as { runId: string };
  await w.asTenant(async (tx) => {
    await tx.execute(sql`INSERT INTO succession_org_stats
      (tenant_id,org_id,stat_date,on_duty_count,green_rate,slot_key,computed_at,run_id)
      VALUES (${w.tenant.id}::uuid,${s.orgA.id}::uuid,${SC_TODAY}::date,7,0.25,'test',
        ${SC_NOW.toISOString()}::timestamptz,${runId}::uuid)`);
  });
  await w.insertRecord({ type: 'org', targetId: s.orgA.id, successorId: s.successor1.id, endDate: '2026-10-02' });
  expect(
    (
      await w.patchOrg(
        { ...s.orgA, revision: 2 },
        {
          addEmployment: false,
          name: '改名后',
          personInChargeId: s.successor2.id,
          effectiveDate: '2026-10-02',
        },
      )
    ).status,
  ).toBe(200);
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-03T01:00:00Z') });
  const historicalPosition = await w.position(s.orgA.id, '后来过期的空岗');
  const expired = await w.call('PATCH', `job/positions/${historicalPosition.id}`, {
    ifMatch: historicalPosition.revision,
    body: { stopDate: '2026-10-02', effectiveDate: '2026-10-02' },
  });
  expect(expired.status, await expired.clone().text()).toBe(200);
  const read = async (asOf: string) => {
    const response = await api.request('GET', `/api/tenant/succession/maps/org${queryOf({ root: s.orgA.id, asOf })}`, {
      user: w.user.id,
      tenant: w.tenant.id,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OrgMap;
  };
  const snapshot = () =>
    w.asTenant(async (tx) => {
      const r = await tx.execute(sql`SELECT
      (SELECT count(*)::int FROM succession_org_stats) AS stats,
      (SELECT count(*)::int FROM audit_events) AS audit,
      (SELECT count(*)::int FROM command_ledger) AS commands`);
      return JSON.stringify(r);
    });
  const before = await snapshot();
  const past = (await read(SC_TODAY)).items[0]!;
  expect(past).toMatchObject({
    name: s.orgA.name,
    personInCharge: { employeeId: s.head.id },
    successorCount: 1,
    health: { levelId, levelName: '当前等级', levelColor: '#123456', resultAsOf: SC_NOW.toISOString() },
    stats: { onDutyCount: 7, greenRate: 0.25, capacity: '--', statDate: SC_TODAY },
  });
  expect(past.keyPositions!.find((p) => p.id === s.keyPosition.id)!.incumbents).toMatchObject([
    { employeeId: s.incumbent.id },
  ]);
  expect(past.keyPositions!.map((p) => p.id)).toContain(historicalPosition.id);
  const today = (await read('2026-10-03')).items[0]!;
  expect(today).toMatchObject({ name: '改名后', personInCharge: { employeeId: s.successor2.id }, successorCount: 0 });
  expect(today.stats).toMatchObject({ onDutyCount: null, greenRate: null, statDate: '2026-10-03' });
  expect(await snapshot()).toBe(before);
  const viewer = await mapOperator(w, {
    orgIds: [s.orgA.id],
    health: true,
    healthHidden: ['levelId', 'levelColor', 'computedAt'],
  });
  const health = (await viewer.read({ root: s.orgA.id })).items[0]!.health;
  expect(health).toMatchObject({ levelName: '当前等级' });
  for (const key of ['levelId', 'levelColor', 'computedAt', 'resultAsOf']) expect(health).not.toHaveProperty(key);
});
