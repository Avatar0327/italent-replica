/** C3：设计 §5.6 / §5.8、DEC-443 / DEC-453④；仅 asOf，范围完全应用 C1 保存条件。 */
import { randomUUID } from 'node:crypto';
import { sql, type DbHandle } from '@italent/db';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { successionWorld, SC_TODAY, SC_NOW, labelOf, type SuccessionWorld } from './AC-SC-support.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());

it('AC-SC-06 地图范围锚点仍是节点组织，不把职位创建人的范围替代地图范围', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-creator-scope');
  const org = await w.org('创建人范围组织');
  await w.position(org.id, '本人创建职位');
  const ids = await w.asTenant((tx) =>
    readMapDisplayScope(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        asOf: SC_TODAY,
        scope: {
          ...EMPTY_SCOPE,
          hasDataPermission: true,
          terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId: w.user.id }],
        },
      },
      'position',
    ),
  );
  expect(ids).toEqual([]);
});

interface Card {
  id: string;
  name: string;
  parentId: string | null;
  incumbents?: { employeeId: string; label: string }[];
  successors?: { id: string; successor: { employeeId: string; label: string }; backupType: string }[];
  successorCount?: number;
  risk?: Record<string, unknown>;
}
interface MapView {
  items: Card[];
  roots: string[];
  asOf: string;
  hasDataPermission: boolean;
}
const prefs = {
  rootOrgId: null,
  depth: 3,
  hiddenOrgIds: [],
  showKeyPositions: false,
  showPositionsWithoutSuccessor: true,
};
async function map(w: Pick<SuccessionWorld, 'request'>, query = ''): Promise<MapView> {
  const response = await w.request('GET', `/maps/position${query}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as MapView;
}
async function save(w: SuccessionWorld, body = prefs, revision = 0) {
  const response = await w.request('PUT', '/maps/position/preferences', { ifMatch: revision, body });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function grantMap(
  world: PermissionWorld,
  viewer: Awaited<ReturnType<typeof recordOperator>>,
  hidden: string[] = [],
  risk = false,
) {
  for (const object of [SUCCESSION_OBJECTS.map, ...(risk ? [SUCCESSION_OBJECTS.riskResult] : [])]) {
    const response = await setObjectPermission(
      world,
      viewer.profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        buttons: [],
        fields: object.fields.map((f) => ({ fieldCode: f.code, view: !hidden.includes(f.code), edit: false })),
      },
      object.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
}
async function exactScope(world: PermissionWorld, viewer: Awaited<ReturnType<typeof recordOperator>>, ids: string[]) {
  const created = await world.api.request('POST', '/api/tenant/permission/mous', {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      code: randomUUID(),
      name: '职位地图精确范围',
      orgRanges: ids.map((orgId) => ({ orgId, includeDescendants: false })),
    },
  });
  expect(created.status).toBe(201);
  const response = await world.api.request(
    'PUT',
    `/api/tenant/permission/scopes/${viewer.userId}/SuccessionAndDevelopment`,
    { ...world.asAdmin, ifMatch: 0, body: { kind: 'mou', mouId: ((await created.json()) as { id: string }).id } },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

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

it('AC-SC-06 DEC-453④ 只接受单个 asOf；roots、显示条件与重复参数拒绝', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-query');
  for (const query of ['roots=', 'depth=2', 'showKeyPositions=true', 'asOf=2026-09-01&asOf=2026-09-02']) {
    const response = await w.request('GET', `/maps/position?${query}`);
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  }
});

it('AC-SC-06 停用与非关键结构节点跳过；保存筛选、层数与 C1 集合一致', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-tree');
  const org = await w.org('结构组织');
  const root = await w.position(org.id, '根');
  const disabled = await w.position(org.id, '停用中间', { parents: { admin: { parentId: root.id } } });
  const nonkey = await w.position(org.id, '非关键中间', {
    isKey: false,
    parents: { admin: { parentId: disabled.id } },
  });
  const child = await w.position(org.id, '子', { parents: { admin: { parentId: nonkey.id } } });
  const leaf = await w.position(org.id, '第三展示层', { parents: { admin: { parentId: child.id } } });
  expect(
    (
      await w.call('PATCH', `job/positions/${disabled.id}`, {
        ifMatch: disabled.revision,
        body: { enabled: false, effectiveDate: SC_TODAY },
      })
    ).status,
  ).toBe(200);
  await save(w, { ...prefs, showKeyPositions: true, depth: 2 });
  const result = await map(w);
  expect(result.roots).toEqual([root.id]);
  expect(result.items.map((p) => [p.id, p.parentId])).toEqual([
    [root.id, null],
    [child.id, root.id],
  ]);
  const displayed = await w.asTenant((tx) =>
    readMapDisplayScope(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        asOf: SC_TODAY,
        scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
      },
      'position',
    ),
  );
  expect(result.items.map((p) => p.id)).toEqual(displayed);
  expect(result.items.map((p) => p.id)).not.toContain(leaf.id);
  await save(w, { ...prefs, depth: 4 }, 1);
  const all = await map(w);
  expect(all.items.map((p) => [p.id, p.parentId])).toEqual([
    [root.id, null],
    [nonkey.id, root.id],
    [child.id, nonkey.id],
    [leaf.id, child.id],
  ]);
});

it('AC-SC-06 无继任者子树开关保留生效继任者祖先；结束、未来、删除记录不保留子树', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-successor-subtree');
  const org = await w.org('子树组织');
  const root = await w.position(org.id, '无继任者祖先');
  const child = await w.position(org.id, '有继任者子', { parents: { admin: { parentId: root.id } } });
  const successor = await w.hire('子树继任者', { departmentId: org.id });
  await w.insertRecord({ type: 'position', targetId: child.id, successorId: successor.id });
  for (const extra of [{ endDate: SC_TODAY }, { startDate: '2026-10-02' }, { deleted: true }]) {
    const empty = await w.position(org.id, `无生效继任者${Object.keys(extra)[0]}`);
    await w.insertRecord({ type: 'position', targetId: empty.id, successorId: successor.id, ...extra });
  }
  await save(w, { ...prefs, showPositionsWithoutSuccessor: false });
  const result = await map(w);
  expect(result.items.map((p) => p.id)).toEqual([root.id, child.id]);
  expect(result.items[0]?.successorCount).toBe(0);
  expect(result.items[1]?.successors).toMatchObject([{ successor: { employeeId: successor.id } }]);
  await save(w, prefs, 1);
  expect((await map(w)).items).toHaveLength(5);
});

it('AC-SC-06 真实授权 A/不可见 B/C：C 新根不挂 A，空范围空图，撤字段权键缺席', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-gap');
  const a = await w.org('A'),
    b = await w.org('B', a.id),
    c = await w.org('C', b.id);
  const pa = await w.position(a.id, 'A职位');
  const pb = await w.position(b.id, 'B职位', { parents: { admin: { parentId: pa.id } } });
  const pc = await w.position(c.id, 'C职位', { parents: { admin: { parentId: pb.id } } });
  const successor = await w.hire('C继任者', { departmentId: b.id });
  await w.insertRecord({ type: 'position', targetId: pc.id, successorId: successor.id });
  const world = await permissionWorldOf(w),
    viewer = await recordOperator(world);
  await grantMap(world, viewer);
  expect(await map(viewer)).toMatchObject({ items: [], roots: [], hasDataPermission: false });
  await exactScope(world, viewer, [a.id, c.id]);
  const result = await map(viewer);
  expect(result.items.map((p) => [p.id, p.parentId]).sort()).toEqual(
    [
      [pa.id, null],
      [pc.id, null],
    ].sort(),
  );
  expect(result.roots.sort()).toEqual([pa.id, pc.id].sort());
  expect(result.items.find((p) => p.id === pc.id)?.successors?.[0]?.successor.label).toBe(labelOf(successor));
  expect(result.items.find((p) => p.id === pc.id)?.successorCount).toBe(1);
  expect(result.items.every((p) => !('risk' in p))).toBe(true);
  await grantMap(world, viewer, ['successors', 'successorCount']);
  const trimmed = await map(viewer);
  expect(trimmed.items.every((p) => !('successors' in p) && !('successorCount' in p))).toBe(true);
  expect(trimmed.items.map((p) => p.id).sort()).toEqual([pa.id, pc.id].sort());
});

it('AC-SC-06 历史职位结构与现任取 asOf；风险使用当前值并标 resultAsOf，无结果用默认颜色', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-history');
  const earlyPost = await w.job('posts', '历史职务', { startDate: '2026-08-01' });
  const org = await w.org('历史组织', undefined, { establishedOn: '2026-08-01' });
  const old = await w.position(org.id, '历史根', { startDate: '2026-09-01', postId: earlyPost.id });
  const child = await w.position(org.id, '历史子', {
    startDate: '2026-09-01',
    postId: earlyPost.id,
    parents: { admin: { parentId: old.id } },
  });
  const incumbent = await w.hire('历史现任', { departmentId: org.id, positionId: child.id }, '2026-09-01');
  const successor = await w.hire('历史继任者', { departmentId: org.id }, '2026-09-01');
  const readiness = await w.readiness('可立即接任');
  const record = await w.insertRecord({
    type: 'position',
    targetId: child.id,
    successorId: successor.id,
    readinessId: readiness.id,
    backupType: 'deputy',
    startDate: '2026-09-01',
    endDate: SC_TODAY,
  });
  expect(
    (
      await w.call('PATCH', `job/positions/${old.id}`, {
        ifMatch: old.revision,
        body: { enabled: false, effectiveDate: SC_TODAY },
      })
    ).status,
  ).toBe(200);
  const levelResponse = await w.request('POST', '/risk-levels', {
    ifMatch: 0,
    body: { code: 'C3', name: '当前风险', color: '#112233', description: '', enabled: true, rules: null },
  });
  expect(levelResponse.status).toBe(201);
  const level = (await levelResponse.json()) as { id: string };
  expect(
    (await w.request('PUT', `/risk-results/${child.id}`, { ifMatch: 0, body: { levelId: level.id } })).status,
  ).toBe(200);
  await w.asTenant((tx) =>
    tx.execute(sql`UPDATE succession_risk_results SET computed_at=${SC_NOW.toISOString()}::timestamptz
    WHERE position_id=${child.id}::uuid`),
  );
  const historic = await map(w, '?asOf=2026-09-15');
  expect(historic.items.map((p) => [p.id, p.parentId])).toEqual([
    [old.id, null],
    [child.id, old.id],
  ]);
  expect(historic.items[1]?.incumbents).toMatchObject([{ employeeId: incumbent.id, label: labelOf(incumbent) }]);
  expect(historic.items[1]?.successors).toMatchObject([
    {
      id: record,
      backupType: 'deputy',
      successor: { employeeId: successor.id },
      readiness: { id: readiness.id, name: readiness.name },
    },
  ]);
  expect(historic.items[1]?.risk).toMatchObject({
    levelName: '当前风险',
    levelColor: '#112233',
    resultAsOf: SC_NOW.toISOString(),
  });
  expect(historic.items[0]?.risk).toMatchObject({ levelName: null, levelColor: '#7498FB', resultAsOf: null });
  expect((await map(w)).items.map((p) => [p.id, p.parentId])).toEqual([[child.id, null]]);
  expect((await map(w)).items[0]?.successors).toEqual([]);
  await w.asTenant((tx) =>
    overrideSetting(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        key: 'succession.show_incumbents',
        expectedRevision: 0,
        commandId: randomUUID(),
        now: SC_NOW,
      },
      false,
    ),
  );
  expect((await map(w, '?asOf=2026-09-15')).items.every((p) => !('incumbents' in p))).toBe(true);
});

it('AC-SC-06 历史地图按今天职位所属组织裁范围，不能借历史归属查看已移出职位', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-current-scope');
  const earlyPost = await w.job('posts', '历史职务', { startDate: '2026-08-01' });
  const a = await w.org('当前范围内', undefined, { establishedOn: '2026-08-01' });
  const b = await w.org('当前范围外', undefined, { establishedOn: '2026-08-01' });
  const movedOut = await w.position(a.id, '移出职位', { startDate: '2026-09-01', postId: earlyPost.id });
  const movedIn = await w.position(b.id, '移入职位', { startDate: '2026-09-01', postId: earlyPost.id });
  for (const [position, org] of [
    [movedOut, b],
    [movedIn, a],
  ] as const)
    expect(
      (
        await w.call('PATCH', `job/positions/${position.id}`, {
          ifMatch: position.revision,
          body: { orgId: org.id, effectiveDate: SC_TODAY },
        })
      ).status,
    ).toBe(200);
  const world = await permissionWorldOf(w),
    viewer = await recordOperator(world);
  await grantMap(world, viewer);
  await exactScope(world, viewer, [a.id]);
  expect((await map(viewer, '?asOf=2026-09-15')).items.map((p) => p.id)).toEqual([movedIn.id]);
});

it('AC-SC-06 SELF 使用请求当日现任，历史卡片无继任者键；租户开关恢复后可读', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-self');
  const earlyPost = await w.job('posts', '历史职务', { startDate: '2026-08-01' });
  const org = await w.org('SELF组织', undefined, { establishedOn: '2026-08-01' });
  const position = await w.position(org.id, 'SELF职位', { startDate: '2026-09-01', postId: earlyPost.id });
  const incumbent = await w.hire('今天现任', { departmentId: org.id, positionId: position.id });
  const successor = await w.hire('SELF继任者', { departmentId: org.id }, '2026-09-01');
  await w.insertRecord({ type: 'position', targetId: position.id, successorId: successor.id });
  const world = await permissionWorldOf(w),
    viewer = await recordOperator(world, { userId: await w.userOf(incumbent) });
  await grantMap(world, viewer);
  await exactScope(world, viewer, [org.id]);
  const setting = (value: boolean, revision: number) =>
    w.asTenant((tx) =>
      overrideSetting(
        tx,
        {
          tenantId: w.tenant.id,
          userId: w.user.id,
          key: 'succession.self_successors_visible',
          expectedRevision: revision,
          commandId: randomUUID(),
          now: SC_NOW,
        },
        value,
      ),
    );
  await setting(false, 0);
  const hidden = await map(viewer, '?asOf=2026-09-15');
  expect(hidden.items[0]?.id).toBe(position.id);
  expect(hidden.items[0]?.incumbents).toEqual([]);
  expect(hidden.items[0]).not.toHaveProperty('successors');
  expect(hidden.items[0]).not.toHaveProperty('successorCount');
  await setting(true, 1);
  expect((await map(viewer, '?asOf=2026-09-15')).items[0]?.successorCount).toBe(1);
});

it('AC-SC-06 风险卡片独立对象权、范围与字段权；Map 看全部不放大风险范围', async () => {
  const w = await successionWorld(handle.db, 'sc-c3-risk-permission');
  const a = await w.org('风险范围内'),
    b = await w.org('风险范围外');
  const pa = await w.position(a.id, '风险A'),
    pb = await w.position(b.id, '风险B');
  const world = await permissionWorldOf(w),
    viewer = await recordOperator(world);
  await grantMap(world, viewer, ['levelColor', 'computedAt'], true);
  const seeAll = await world.api.request(
    'PUT',
    `/api/tenant/permission/profiles/${viewer.profile.id}/data-scopes/SuccessionAndDevelopment`,
    {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'entity', targetCode: SUCCESSION_OBJECTS.map.code, seeAll: true },
    },
  );
  expect(seeAll.status).toBe(200);
  await exactScope(world, viewer, [a.id]);
  const result = await map(viewer);
  expect(result.items.map((p) => p.id).sort()).toEqual([pa.id, pb.id].sort());
  const cards = new Map(result.items.map((p) => [p.id, p]));
  expect(cards.get(pa.id)?.risk).toMatchObject({ levelName: null });
  expect(cards.get(pa.id)?.risk).not.toHaveProperty('levelColor');
  expect(cards.get(pa.id)?.risk).not.toHaveProperty('resultAsOf');
  expect(cards.get(pb.id)).not.toHaveProperty('risk');
});
