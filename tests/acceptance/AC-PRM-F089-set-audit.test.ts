/** F-089 / DEC-409⑦：集合顺序不制造审计差异，真实成员和值变化仍须保留。 */
import { randomUUID } from 'node:crypto';
import { createPermissionAuthorizer, registerObjectDefinition } from '@italent/api';
import { and, auditEvents, eq, orgObjects, permissionOutbox, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  myObject,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';

const testDb = useTestDb();
const OBJECT = 'Demo.F089';
const fields = [
  { fieldCode: 'Alpha', view: true, edit: false },
  { fieldCode: 'Zulu', view: true, edit: true },
];
const buttons = [
  { buttonCode: 'Action', level: 'detail' as const },
  { buttonCode: 'Action', level: 'list' as const },
  { buttonCode: 'Zulu', level: 'detail' as const },
];
const permission = {
  dataOperations: { create: false, update: true, delete: false },
  fields,
  buttons,
};
const ranges = [
  { orgId: '00000000-0000-4000-8000-000000000001', dimension: 'admin', includeDescendants: false },
  { orgId: '00000000-0000-4000-8000-000000000001', dimension: 'business', includeDescendants: true },
  { orgId: '00000000-0000-4000-8000-000000000002', dimension: 'admin', includeDescendants: true },
];

describe('AC-PRM F-089 权限集合保存与读取', () => {
  let world: PermissionWorld;
  beforeAll(async () => {
    registerObjectDefinition({
      code: OBJECT,
      application: 'TenantBase',
      fields: [
        { code: 'Zulu', system: false },
        { code: 'Alpha', system: false },
      ],
      buttons: [
        { code: 'Zulu', level: 'detail' },
        { code: 'Action', level: 'list' },
        { code: 'Action', level: 'detail' },
      ],
    });
    world = await seedPermissionWorld(testDb().db);
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx
        .insert(orgObjects)
        .values([...new Set(ranges.map((r) => r.orgId))].map((id) => ({ tenantId: world.tenant.id, id }))),
    );
  });

  async function get(path: string) {
    const response = await world.api.request('GET', `${BASE}${path}`, world.asAdmin);
    expect(response.status).toBe(200);
    return response.json();
  }
  async function put(path: string, body: unknown, revision: number, key = randomUUID()) {
    const response = await world.api.request('PUT', `${BASE}${path}`, {
      ...world.asAdmin,
      ifMatch: revision,
      idempotencyKey: key,
      body,
    });
    expect(response.status).toBe(200);
    return { body: await response.json(), key };
  }
  async function events(key: string) {
    return withTenant(world.db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.commandId, key)),
    );
  }
  async function unchanged(key: string, count = 1) {
    const audit = await events(key);
    expect(audit).toHaveLength(count);
    for (const event of audit) expect(event.changes).toEqual([]);
    const outbox = await withTenant(world.db, world.tenant.id, (tx) =>
      tx.select().from(permissionOutbox).where(eq(permissionOutbox.commandId, key)),
    );
    expect(outbox).toHaveLength(count);
  }
  async function changed(key: string, expected: string[]) {
    const audit = await events(key);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toEqual([...expected].sort().map((field) => expect.objectContaining({ field })));
  }

  it.each(['字段', '按钮', '字段及按钮'])('DEC-409⑦ 仅%s顺序变化：审计无字段变更，revision与重放不变', async (kind) => {
    const profile = await createProfile(world, `order-${randomUUID()}`);
    expect((await setObjectPermission(world, profile, permission, OBJECT)).status).toBe(200);
    const path = `/profiles/${profile.id}/objects/${OBJECT}`;
    const reordered = {
      ...permission,
      fields: kind === '按钮' ? fields : [...fields].reverse(),
      buttons: kind === '字段' ? buttons : [...buttons].reverse(),
    };
    const saved = await put(path, reordered, profile.revision);
    expect(saved.body.revision).toBe(profile.revision + 1);
    await unchanged(saved.key);
    const replay = await put(path, reordered, profile.revision, saved.key);
    expect(replay.body).toEqual(saved.body);
    await unchanged(saved.key);
    const stale = await world.api.request('PUT', `${BASE}${path}`, {
      ...world.asAdmin,
      ifMatch: profile.revision,
      body: permission,
    });
    expect(stale.status).toBe(409);
    const different = await world.api.request('PUT', `${BASE}${path}`, {
      ...world.asAdmin,
      ifMatch: profile.revision,
      idempotencyKey: saved.key,
      body: { ...reordered, buttons: [] },
    });
    expect(different.status).toBe(409);
  });

  it('DEC-409⑦ 身份详情、应用、本人有效权限统一排序，重排前后鉴权结果相同', async () => {
    const profile = await createProfile(world, 'read-order', { apps: ['TenantBase', 'DemoPayroll'] });
    expect(
      (
        await setObjectPermission(
          world,
          profile,
          {
            ...permission,
            fields: [...fields].reverse(),
            buttons: [...buttons].reverse(),
          },
          OBJECT,
        )
      ).status,
    ).toBe(200);
    const detail = await get(`/profiles/${profile.id}`);
    expect(detail.apps).toEqual(['DemoPayroll', 'TenantBase']);
    expect(detail.objects).toMatchObject([{ objectCode: OBJECT, fields, buttons }]);
    const list = await get('/profiles');
    expect(list.items.find((p: { id: string }) => p.id === profile.id).apps).toEqual(detail.apps);
    const user = await addMember(world, 'set-reader');
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const before = await myObject(world, user, OBJECT);
    expect(before.status).toBe(200);
    const effective = await before.json();
    expect(effective).toMatchObject({ viewableFields: ['Alpha', 'Zulu'], editableFields: ['Zulu'], buttons });
    const authorize = createPermissionAuthorizer(world.db);
    const queries = [
      { action: 'object.view', resource: OBJECT },
      { action: 'object.update', resource: OBJECT, fields: ['Zulu'] },
      { action: 'object.update', resource: OBJECT, fields: ['Alpha'] },
      { action: 'object.create', resource: OBJECT, fields: ['Zulu'] },
      { action: 'object.delete', resource: OBJECT },
      { action: 'object.button', resource: `${OBJECT}#Action@list` },
      { action: 'object.button', resource: `${OBJECT}#Action@detail` },
      { action: 'object.button', resource: `${OBJECT}#Action@list_row` },
    ];
    const decisions = async () => {
      const results: boolean[] = [];
      for (const query of queries)
        results.push(
          await authorize({
            ...query,
            tenantId: world.tenant.id,
            userId: user.id,
          }),
        );
      return results;
    };
    expect(await decisions()).toEqual([true, true, false, false, false, true, true, false]);
    expect((await setObjectPermission(world, profile, permission, OBJECT)).status).toBe(200);
    expect(await (await myObject(world, user, OBJECT)).json()).toEqual(effective);
    expect(await decisions()).toEqual([true, true, false, false, false, true, true, false]);
    const outsider = await addMember(world, 'set-outsider');
    expect((await myObject(world, outsider, OBJECT)).status).toBe(403);
  });

  it.each([
    ['查看值', { ...permission, fields: [{ ...fields[0]!, view: false }, fields[1]!] }, ['fields']],
    ['编辑值', { ...permission, fields: [fields[0]!, { ...fields[1]!, edit: false }] }, ['fields']],
    ['字段成员', { ...permission, fields: [fields[0]!] }, ['fields']],
    ['按钮级别', { ...permission, buttons: [buttons[0]!, buttons[2]!] }, ['buttons']],
    ['按钮成员', { ...permission, buttons: [buttons[0]!, buttons[1]!] }, ['buttons']],
    [
      '数据操作',
      { ...permission, dataOperations: { ...permission.dataOperations, update: false } },
      ['dataOperations.update'],
    ],
  ] as const)('DEC-409⑦ 真实%s变化仍写审计', async (_label, next, expected) => {
    const profile = await createProfile(world, `real-${randomUUID()}`);
    expect((await setObjectPermission(world, profile, permission, OBJECT)).status).toBe(200);
    const saved = await put(`/profiles/${profile.id}/objects/${OBJECT}`, next, profile.revision);
    await changed(saved.key, [...expected]);
  });

  it.each(['mou', 'user'])('DEC-409⑦ %s组织范围按组织与维度排序，只重排不记差异', async (kind) => {
    let path: string;
    let body: unknown;
    if (kind === 'mou') {
      const response = await world.api.request('POST', `${BASE}/mous`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { code: 'set-mou', name: '集合范围', orgRanges: [...ranges].reverse() },
      });
      expect(response.status).toBe(201);
      const created = (await response.json()) as { id: string; orgRanges: unknown[] };
      path = `/mous/${created.id}`;
      expect(created.orgRanges).toEqual(ranges);
      body = { code: 'set-mou', name: '集合范围', orgRanges: ranges };
    } else {
      const user = await addMember(world, 'set-scope');
      path = `/scopes/${user.id}/TenantBase`;
      body = { kind: 'org_range', orgRanges: ranges };
      const created = await put(path, { kind: 'org_range', orgRanges: [...ranges].reverse() }, 0);
      expect(created.body.orgRanges).toEqual(ranges);
      const profile = await createProfile(world, 'set-prefill');
      const prefill = await get(`/grant-prefill/${user.id}/${profile.id}`);
      expect(prefill.scopes[0].orgRanges).toEqual(ranges);
    }
    const saved = await put(path, body, 1);
    expect(saved.body.orgRanges).toEqual(ranges);
    expect((await get(path)).orgRanges).toEqual(ranges);
    await unchanged(saved.key, kind === 'user' ? 2 : 1);
    const next =
      kind === 'mou'
        ? {
            code: 'set-mou',
            name: '集合范围',
            orgRanges: [{ ...ranges[0]!, includeDescendants: true }, ...ranges.slice(1)],
          }
        : { kind: 'org_range', orgRanges: [{ ...ranges[0]!, includeDescendants: true }, ...ranges.slice(1)] };
    const real = await put(path, next, 2);
    const audit = await events(real.key);
    for (const event of audit) expect(event.changes).toEqual([expect.objectContaining({ field: 'orgRanges' })]);
  });

  it('DEC-409⑦ 应用允许范围类型是集合：读取排序，重排无差异，删除成员仍记差异', async () => {
    const path = '/scope-apps/SetDemo';
    const allowedKinds = ['default', 'mou', 'org_range'];
    const first = await put(path, { family: 'hr', allowedKinds: [...allowedKinds].reverse() }, 0);
    expect(first.body.allowedKinds).toEqual(allowedKinds);
    expect((await get(path)).allowedKinds).toEqual(allowedKinds);
    const reordered = await put(path, { family: 'hr', allowedKinds }, 1);
    await unchanged(reordered.key);
    const real = await put(path, { family: 'hr', allowedKinds: ['default', 'mou'] }, 2);
    await changed(real.key, ['allowedKinds']);
  });

  it('DEC-409⑦ 管理员可授权角色与身份集合重排无差异，真实撤销仍记差异', async () => {
    const p1 = await createProfile(world, 'delegate-a');
    const p2 = await createProfile(world, 'delegate-b');
    const current = await get(`/admins/${world.adminRecord.id}`);
    const path = `/admins/${current.id}`;
    const roles = ['audit_admin', 'tenant_admin', 'user_admin'];
    const ids = [p1.id, p2.id].sort();
    const first = await put(
      path,
      { grantableAdminRoles: [...roles].reverse(), grantableProfileIds: [...ids].reverse() },
      current.revision,
    );
    expect(first.body.grantableAdminRoles).toEqual(roles);
    expect(first.body.grantableProfileIds).toEqual(ids);
    const reordered = await put(path, { grantableAdminRoles: roles, grantableProfileIds: ids }, first.body.revision);
    await unchanged(reordered.key);
    const real = await put(
      path,
      { grantableAdminRoles: ['tenant_admin', 'user_admin'], grantableProfileIds: [ids[0]] },
      reordered.body.revision,
    );
    await changed(real.key, ['grantableAdminRoles', 'grantableProfileIds']);
  });

  it('DEC-409⑦ 范围消费规则按维度、角色、关系排序；同维度不同参数仍是不同成员', async () => {
    const code = MODULE_OBJECTS.employmentRecord.code;
    const path = `/scope-policies/TenantBase/${code}/entity/${code}`;
    const rules = [
      { dimension: 'management', roleCode: null, relationMode: null },
      { dimension: 'organization', roleCode: 'head', relationMode: null },
      { dimension: 'organization', roleCode: 'hrbp', relationMode: null },
      { dimension: 'reporting', roleCode: null, relationMode: 'all_direct' },
      { dimension: 'reporting', roleCode: null, relationMode: 'direct' },
    ];
    const input = (items: typeof rules) => ({
      rules: items.map((r) => ({
        dimension: r.dimension,
        ...(r.roleCode ? { roleCode: r.roleCode } : {}),
        ...(r.relationMode ? { relationMode: r.relationMode } : {}),
      })),
    });
    const first = await put(path, input([...rules].reverse()), 0);
    expect(first.body.rules).toEqual(rules);
    expect((await get(path)).rules).toEqual(rules);
    const reordered = await put(path, input(rules), 1);
    await unchanged(reordered.key);
    const duplicate = await put(path, input([...rules, rules[0]!]), 2);
    expect(duplicate.body.rules).toEqual(rules);
    await unchanged(duplicate.key);
    const real = await put(path, input(rules.slice(1)), 3);
    await changed(real.key, ['rules']);
    const stored = await withTenant(world.db, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.commandId, real.key), eq(auditEvents.objectType, 'permission_scope_policy'))),
    );
    expect(stored[0]!.changes).toEqual([expect.objectContaining({ field: 'rules', from: rules })]);
  });
});
