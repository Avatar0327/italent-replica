/** AC-PRM-14~16：管理单元与用户×应用共享范围的实际 API 生命周期。 */
import { randomUUID } from 'node:crypto';
import { orgObjects, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  type PermissionWorld,
} from './AC-PRM-support.js';

const testDb = useTestDb();
type Mou = { id: string; code: string; name: string; revision: number; status: string };
type Scope = { kind: string; mouId: string | null; revision: number; orgRanges: { orgId: string }[] };

describe('AC-PRM-14~16 数据范围管理与共享授权生命周期', () => {
  let world: PermissionWorld;
  let orgId: string;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    orgId = randomUUID();
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.insert(orgObjects).values({ tenantId: world.tenant.id, id: orgId }),
    );
  });

  async function createMou(code: string, idempotencyKey = randomUUID()) {
    return world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      idempotencyKey,
      body: { code, name: `范围${code}`, orgRanges: [{ orgId, includeDescendants: true }] },
    });
  }
  const scopePath = (userId: string, app = 'TenantBase') => `${BASE}/scopes/${userId}/${app}`;
  const scope = async (userId: string): Promise<Scope> => {
    const res = await world.api.request('GET', scopePath(userId), world.asAdmin);
    expect(res.status).toBe(200);
    return (await res.json()) as Scope;
  };

  it('MOU CRUD 使用 revision、幂等命令、不可变版本及同事务审计', async () => {
    const key = randomUUID();
    const first = await createMou('crud', key);
    expect(first.status).toBe(201);
    const created = (await first.json()) as Mou;
    const replay = await createMou('crud', key);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);
    const updated = await world.api.request('PUT', `${BASE}/mous/${created.id}`, {
      ...world.asAdmin,
      ifMatch: 1,
      body: { code: 'crud', name: '范围更新', orgRanges: [{ orgId, includeDescendants: false }] },
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ name: '范围更新', revision: 2 });
    const stale = await world.api.request('DELETE', `${BASE}/mous/${created.id}`, {
      ...world.asAdmin,
      ifMatch: 1,
      body: {},
    });
    expect(stale.status).toBe(409);
    const deleted = await world.api.request('DELETE', `${BASE}/mous/${created.id}`, {
      ...world.asAdmin,
      ifMatch: 2,
      body: {},
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ revision: 3, status: 'deleted' });
    const versions = await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`
      SELECT revision FROM permission_scope_versions WHERE object_id=${created.id} ORDER BY revision
    `),
    );
    const rows = Array.isArray(versions) ? versions : (versions as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map((r: Record<string, unknown>) => Number(r.revision))).toEqual([1, 2, 3]);
    const audit = await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`
      SELECT command_id FROM audit_events WHERE object_id=${created.id}
    `),
    );
    const events = Array.isArray(audit) ? audit : (audit as { rows: Record<string, unknown>[] }).rows;
    expect(events).toHaveLength(3);
    expect(events.every((r: Record<string, unknown>) => typeof r.command_id === 'string')).toBe(true);
  });

  it('AC-PRM-14/15/16 两身份共享一份范围、表单预填、撤销不回滚、新授权显式覆盖', async () => {
    const user = await addMember(world, 'scope-shared');
    const p1 = await createProfile(world, 'scope-p1');
    const p2 = await createProfile(world, 'scope-p2');
    const p3 = await createProfile(world, 'scope-p3');
    await makeGrantable(world, [p1.id, p2.id, p3.id]);
    const firstGrant = await grant(world, user.id, p1.id);
    expect(firstGrant.status).toBe(201);
    const g1 = (await firstGrant.json()) as { id: string; revision: number };
    expect(await scope(user.id)).toMatchObject({ kind: 'default', mouId: null, revision: 0 });
    const assigned = await world.api.request('PUT', scopePath(user.id), {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId, includeDescendants: false }] },
    });
    expect(assigned.status).toBe(200);
    const shared = await scope(user.id);
    expect(shared).toMatchObject({ kind: 'org_range', revision: 1, orgRanges: [{ orgId }] });
    const prefill = await world.api.request('GET', `${BASE}/grant-prefill/${user.id}/${p2.id}`, world.asAdmin);
    expect(prefill.status).toBe(200);
    expect(await prefill.json()).toMatchObject({
      sharedScopeNotice: '此范围由该用户在应用下的所有身份共享',
      scopes: [expect.objectContaining({ appCode: 'TenantBase', kind: 'org_range', revision: 1 })],
    });
    expect((await grant(world, user.id, p2.id)).status).toBe(201);
    expect(await scope(user.id)).toEqual(shared);
    const revoked = await world.api.request('POST', `${BASE}/grants/${g1.id}/revoke`, {
      ...world.asAdmin,
      ifMatch: g1.revision,
      body: {},
    });
    expect(revoked.status).toBe(200);
    expect(await scope(user.id)).toEqual(shared);
    const replacement = await world.api.request('POST', `${BASE}/grants`, {
      ...world.asAdmin,
      body: {
        userId: user.id,
        profileId: p3.id,
        scopes: [{ appCode: 'TenantBase', expectedRevision: 1, kind: 'default' }],
      },
    });
    expect(replacement.status).toBe(201);
    expect(await scope(user.id)).toMatchObject({ kind: 'default', revision: 2, mouId: null });
  });

  it('共享范围写冲突回滚授权，拒绝无管理权与跨租户 MOU 引用', async () => {
    const user = await addMember(world, 'scope-conflict');
    const profile = await createProfile(world, 'scope-conflict-profile');
    await makeGrantable(world, [profile.id]);
    const conflict = await world.api.request('POST', `${BASE}/grants`, {
      ...world.asAdmin,
      body: {
        userId: user.id,
        profileId: profile.id,
        scopes: [{ appCode: 'TenantBase', expectedRevision: 99, kind: 'default' }],
      },
    });
    expect(conflict.status).toBe(409);
    const grants = await world.api.request('GET', `${BASE}/grants?userId=${user.id}`, world.asAdmin);
    expect(await grants.json()).toMatchObject({ items: [] });
    const denied = await world.api.request('PUT', scopePath(user.id), {
      user: user.id,
      tenant: world.tenant.id,
      ifMatch: 0,
      body: { kind: 'default' },
    });
    expect(denied.status).toBe(403);
    const another = await seedPermissionWorld(world.db);
    const foreign = await another.api.request('POST', `${BASE}/mous`, {
      ...another.asAdmin,
      ifMatch: 0,
      body: { code: 'foreign', name: '外部范围', orgRanges: [] },
    });
    expect(foreign.status).toBe(201);
    const foreignMou = (await foreign.json()) as Mou;
    const invalid = await world.api.request('PUT', scopePath(user.id), {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: foreignMou.id },
    });
    expect(invalid.status).toBe(404);
  });

  it('每应用范围独立且组织批次有界，默认管理员也不自动获得业务范围', async () => {
    expect(await scope(world.admin.id)).toMatchObject({ kind: 'default', revision: 0, mouId: null });
    const user = await addMember(world, 'scope-bounded');
    const tooLarge = await world.api.request('PUT', scopePath(user.id), {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: Array.from({ length: 201 }, () => ({ orgId, includeDescendants: false })) },
    });
    expect(tooLarge.status).toBe(400);
    expect(await scope(user.id)).toMatchObject({ revision: 0, kind: 'default' });
  });

  it('首次并发设置仅一方成功，同命令异内容返回409且版本只追加', async () => {
    const user = await addMember(world, 'scope-race');
    const requests = ['default', 'org_range'].map((kind) =>
      world.api.request('PUT', scopePath(user.id), {
        ...world.asAdmin,
        ifMatch: 0,
        body: kind === 'default' ? { kind } : { kind, orgRanges: [{ orgId, includeDescendants: false }] },
      }),
    );
    const replies = await Promise.all(requests);
    expect(replies.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await scope(user.id)).toMatchObject({ revision: 1 });
    const key = randomUUID();
    expect((await createMou('key-original', key)).status).toBe(201);
    expect((await createMou('key-different', key)).status).toBe(409);
    await expect(
      withTenant(world.db, world.tenant.id, (tx) =>
        tx.execute(sql`
      UPDATE permission_scope_versions SET revision=100
      WHERE object_id=${user.id + ':TenantBase'}
    `),
      ),
    ).rejects.toThrow();
  });

  it('用户管理员可授身份但不能借grant.scopes或MOU接口修改共享范围', async () => {
    const operator = await addMember(world, 'user-admin');
    const target = await addMember(world, 'grant-target');
    const profile = await createProfile(world, 'delegated-profile');
    await makeGrantable(world, [profile.id]);
    const admin = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: operator.id, role: 'user_admin', grantableAdminRoles: [], grantableProfileIds: [profile.id] },
    });
    expect(admin.status).toBe(201);
    const asOperator = { user: operator.id, tenant: world.tenant.id };
    const blocked = await world.api.request('POST', `${BASE}/grants`, {
      ...asOperator,
      body: {
        userId: target.id,
        profileId: profile.id,
        scopes: [{ appCode: 'TenantBase', expectedRevision: 0, kind: 'default' }],
      },
    });
    expect(blocked.status).toBe(403);
    expect((await world.api.request('GET', `${BASE}/mous`, asOperator)).status).toBe(403);
    expect(
      (
        await world.api.request('POST', `${BASE}/grants`, {
          ...asOperator,
          body: { userId: target.id, profileId: profile.id },
        })
      ).status,
    ).toBe(201);
    expect(await scope(target.id)).toMatchObject({ revision: 0, kind: 'default' });
  });
});
