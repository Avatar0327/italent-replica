import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { overrideSetting } from '../../apps/api/src/modules/tenant-settings/service.js';
import { readMapTenantSettings } from '../../apps/api/src/modules/succession/map-preferences.js';
import { randomUUID } from 'node:crypto';
import { SUCCESSION_OBJECTS } from '@italent/domain';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import { scopeAllows } from '../../apps/api/src/modules/permission/module-access.js';
import { permissionWorldOf, recordOperator } from './AC-SC-permission-support.js';
import { setObjectPermission } from './AC-PRM-support.js';
import { successionWorld, SC_TODAY, SC_NOW } from './AC-SC-support.js';
import { uniqueSuffix } from './support/unique.js';

const db = useTestDb();
it('AC-SC-map-display 根、层数、隐藏子树、虚拟子树、权限断层与空范围', async () => {
  const w = await successionWorld(db().db, 'sc-display');
  const root = await w.org('根');
  const a = await w.org('A', root.id);
  const b = await w.org('B', a.id);
  const virtual = await w.org('虚拟', root.id, { isVirtual: true });
  const leaf = await w.org('虚拟下级', virtual.id);
  const prefs = {
    rootOrgId: root.id,
    depth: 3,
    hiddenOrgIds: [],
  };
  const all = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
  const read = (extra = {}, scope = all) =>
    w.asTenant((tx) =>
      readMapDisplayScope(tx, { tenantId: w.tenant.id, userId: w.user.id, asOf: SC_TODAY, scope }, 'org', {
        ...prefs,
        ...extra,
      }),
    );
  expect((await read()).sort()).toEqual([root.id, a.id, b.id, virtual.id, leaf.id].sort());
  expect((await read({ depth: 2 })).sort()).toEqual([root.id, a.id, virtual.id].sort());
  await w.asTenant((tx) =>
    overrideSetting(
      tx,
      {
        tenantId: w.tenant.id,
        userId: w.user.id,
        key: 'succession.hide_virtual_org',
        expectedRevision: 0,
        commandId: randomUUID(),
        now: SC_NOW,
      },
      true,
    ),
  );
  expect((await read({ hiddenOrgIds: [a.id] })).sort()).toEqual([root.id]);
  expect(await w.asTenant((tx) => readMapTenantSettings(tx, w.tenant.id, 'position'))).toEqual({
    hideVirtual: false,
    showIncumbents: true,
  });
  expect(await read({}, EMPTY_SCOPE)).toEqual([]);
  const scoped = { ...EMPTY_SCOPE, orgIds: [root.id, b.id], terms: undefined, hasDataPermission: true };
  expect(await read({}, scoped)).toEqual([root.id]);
});

it('AC-SC-map-display F-087：真实授权范围 A/C、不可见 B；C 职位新根按职位层数显示', async () => {
  const w = await successionWorld(db().db, 'sc-real-position-gap');
  const a = await w.org('A');
  const b = await w.org('B', a.id);
  const c = await w.org('C', b.id);
  const pA = await w.position(a.id, 'A 职位');
  const pB = await w.position(b.id, 'B 职位', { parents: { admin: { parentId: pA.id } } });
  const pC = await w.position(c.id, 'C 职位', { parents: { admin: { parentId: pB.id } } });
  const pD = await w.position(c.id, 'C 第二层', { parents: { admin: { parentId: pC.id } } });
  await w.position(c.id, 'C 第三层', { parents: { admin: { parentId: pD.id } } });
  const world = await permissionWorldOf(w);
  const viewer = await recordOperator(world);
  const map = SUCCESSION_OBJECTS.map;
  expect(
    (
      await setObjectPermission(
        world,
        viewer.profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          buttons: [{ buttonCode: 'computeStats', level: 'list' }],
          fields: map.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        },
        map.code,
      )
    ).status,
  ).toBe(200);
  const mou = await world.api.request('POST', '/api/tenant/permission/mous', {
    ...world.asAdmin,
    ifMatch: 0,
    body: {
      code: `gap-${uniqueSuffix()}`,
      name: '仅 A C',
      orgRanges: [a.id, c.id].map((orgId) => ({ orgId, includeDescendants: false })),
    },
  });
  expect(mou.status, await mou.clone().text()).toBe(201);
  expect(
    (
      await world.api.request('PUT', `/api/tenant/permission/scopes/${viewer.userId}/SuccessionAndDevelopment`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'mou', mouId: ((await mou.json()) as { id: string }).id },
      })
    ).status,
  ).toBe(200);
  const scope = await w.asTenant((tx) =>
    resolveDataScope(tx, {
      tenantId: w.tenant.id,
      userId: viewer.userId,
      appCode: 'SuccessionAndDevelopment',
      objectCode: map.code,
      asOf: SC_TODAY,
    }),
  );
  expect(scope.all).toBe(false);
  for (const org of [a, c]) expect(scopeAllows(scope, { orgId: org.id })).toBe(true);
  expect(scopeAllows(scope, { orgId: b.id })).toBe(false);
  const ctx = { tenantId: w.tenant.id, userId: viewer.userId, asOf: SC_TODAY, scope };
  const prefs = {
    rootOrgId: a.id,
    depth: 2,
    hiddenOrgIds: [],
    showKeyPositions: false,
    showPositionsWithoutSuccessor: true,
  };
  expect((await w.asTenant((tx) => readMapDisplayScope(tx, ctx, 'position', prefs))).sort()).toEqual(
    [pA.id, pC.id, pD.id].sort(),
  );
  for (const rootOrgId of [b.id, randomUUID()]) {
    const response = await world.api.request('POST', '/api/tenant/succession/maps/org/compute-stats', {
      ...viewer.as,
      ifMatch: 0,
      body: { rootOrgId, depth: 2, hiddenOrgIds: [] },
    });
    expect(response.status, await response.clone().text()).toBe(404);
  }
});

it('AC-SC-map-display 职位图保留有继任者的祖先；停用/非关键祖先跳过，权限断层多根', async () => {
  const w = await successionWorld(db().db, 'sc-display-position');
  const org = await w.org('职位所属');
  const parent = await w.position(org.id, '父');
  const skipped = await w.position(org.id, '非关键', { isKey: false, parents: { admin: { parentId: parent.id } } });
  const child = await w.position(org.id, '子', { parents: { admin: { parentId: skipped.id } } });
  const empty = await w.position(org.id, '空树');
  const employee = await w.hire('继任者', { departmentId: org.id });
  await w.insertRecord({ type: 'position', targetId: child.id, successorId: employee.id });
  const prefs = {
    rootOrgId: null,
    depth: 3,
    hiddenOrgIds: [],
    showKeyPositions: true,
    showPositionsWithoutSuccessor: false,
  };
  const ctx = {
    tenantId: w.tenant.id,
    userId: w.user.id,
    asOf: SC_TODAY,
    scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
  };
  const ids = await w.asTenant((tx) => readMapDisplayScope(tx, ctx, 'position', prefs));
  expect(ids.sort()).toEqual([parent.id, child.id].sort());
  expect(ids).not.toContain(empty.id);
  expect(
    (await w.asTenant((tx) => readMapDisplayScope(tx, ctx, 'position', { ...prefs, showKeyPositions: false }))).sort(),
  ).toEqual([parent.id, skipped.id, child.id].sort());
});

it('AC-SC-map-display P2-1：同组织四层职位链按职位层数截断，保存值供冻结读取', async () => {
  const w = await successionWorld(db().db, 'sc-position-depth');
  const org = await w.org('层数组织');
  const p1 = await w.position(org.id, 'P1');
  const p2 = await w.position(org.id, 'P2', { parents: { admin: { parentId: p1.id } } });
  const p3 = await w.position(org.id, 'P3', { parents: { admin: { parentId: p2.id } } });
  const p4 = await w.position(org.id, 'P4', { parents: { admin: { parentId: p3.id } } });
  const ctx = {
    tenantId: w.tenant.id,
    userId: w.user.id,
    asOf: SC_TODAY,
    scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
  };
  for (const depth of [2, 3, 4]) {
    const saved = await w.request('PUT', '/maps/position/preferences', {
      ifMatch: depth - 2,
      body: {
        rootOrgId: org.id,
        depth,
        hiddenOrgIds: [],
        showKeyPositions: false,
        showPositionsWithoutSuccessor: true,
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const ids = await w.asTenant((tx) => readMapDisplayScope(tx, ctx, 'position'));
    expect(ids.sort()).toEqual([p1.id, p2.id, p3.id, p4.id].slice(0, depth).sort());
  }
});

it('AC-SC-map-display P2-1：先跳过停用/非关键结构节点，再计层；组织下级不消耗职位层数', async () => {
  const w = await successionWorld(db().db, 'sc-position-skip-depth');
  const a = await w.org('A');
  const b = await w.org('B', a.id);
  const c = await w.org('C', b.id);
  const d = await w.org('D', c.id);
  const p1 = await w.position(a.id, '根');
  const disabled = await w.position(a.id, '停用', { parents: { admin: { parentId: p1.id } } });
  const nonkey = await w.position(a.id, '非关键', { isKey: false, parents: { admin: { parentId: disabled.id } } });
  const p2 = await w.position(d.id, '第二展示层', { parents: { admin: { parentId: nonkey.id } } });
  const p3 = await w.position(d.id, '第三展示层', { parents: { admin: { parentId: p2.id } } });
  expect(
    (
      await w.call('PATCH', `job/positions/${disabled.id}`, {
        ifMatch: disabled.revision,
        body: { enabled: false, effectiveDate: SC_TODAY },
      })
    ).status,
  ).toBe(200);
  const successor = await w.hire('深层继任者', { departmentId: d.id });
  await w.insertRecord({ type: 'position', targetId: p3.id, successorId: successor.id });
  const ctx = {
    tenantId: w.tenant.id,
    userId: w.user.id,
    asOf: SC_TODAY,
    scope: { ...EMPTY_SCOPE, all: true, hasDataPermission: true },
  };
  const prefs = {
    rootOrgId: a.id,
    depth: 2,
    hiddenOrgIds: [],
    showKeyPositions: true,
    showPositionsWithoutSuccessor: false,
  };
  expect((await w.asTenant((tx) => readMapDisplayScope(tx, ctx, 'position', prefs))).sort()).toEqual(
    [p1.id, p2.id].sort(),
  );
});
