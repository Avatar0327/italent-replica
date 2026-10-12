import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { readMapDisplayScope } from '../../apps/api/src/modules/succession/map-display.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { successionWorld, SC_TODAY } from './AC-SC-support.js';

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
    hideVirtual: false,
    showKeyPositions: false,
    showPositionsWithoutSuccessor: true,
    showIncumbents: true,
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
  expect((await read({ hiddenOrgIds: [a.id], hideVirtual: true })).sort()).toEqual([root.id]);
  expect(await read({}, EMPTY_SCOPE)).toEqual([]);
  const scoped = { ...EMPTY_SCOPE, orgIds: [root.id, b.id], terms: undefined, hasDataPermission: true };
  expect(await read({}, scoped)).toEqual([root.id]);
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
    hideVirtual: false,
    showKeyPositions: false,
    showPositionsWithoutSuccessor: false,
    showIncumbents: true,
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
});
