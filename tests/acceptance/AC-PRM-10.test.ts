/**
 * AC-PRM-10（REQ-PRM-001 R1、R2；06 §2.1）：管理员的可授权业务身份集合不含 X → 选择器中不出现 X，后端也拒绝授予 X。
 * 管理员身份同理：只能授予「可授权管理员身份」内的管理员身份。
 * 同时覆盖平台约定（AGENTS.md §10）：Idempotency-Key 幂等、撤销带 revision（409）、业务与审计同事务。
 */
import { auditEvents, eq, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  type ProfileBody,
  seedPermissionWorld,
} from './AC-PRM-support.js';
import { errorCode, seedTenantWithMember } from './support/tenant-api.js';

const testDb = useTestDb();

interface ListBody<T> {
  items: T[];
}
interface GrantBody {
  id: string;
  userId: string;
  profileId: string;
  status: string;
  revision: number;
}

describe('AC-PRM-10 只能授予可授权集合内的身份', () => {
  let world: PermissionWorld;
  let allowed: ProfileBody;
  let notAllowed: ProfileBody;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    allowed = await createProfile(world, 'hr');
    notAllowed = await createProfile(world, 'restricted');
    await makeGrantable(world, [allowed.id]);
  });

  async function grantableCodes(as: { user: string; tenant: string }): Promise<string[]> {
    const res = await world.api.request('GET', `${BASE}/grantable-profiles`, as);
    expect(res.status).toBe(200);
    return ((await res.json()) as ListBody<{ code: string }>).items.map((p) => p.code);
  }

  it('新建身份默认不可授权；选择器只列可授权集合，授予集合外的身份 → 403', async () => {
    expect(await grantableCodes(world.asAdmin)).toEqual(['hr']);
    const user = await addMember(world, 'target');
    const denied = await grant(world, user.id, notAllowed.id);
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe('FORBIDDEN');
    expect((await grant(world, user.id, allowed.id)).status).toBe(201);
  });

  it('用户管理员只能把自己可授权的身份再授出；无「可授权管理员身份」时不能建管理员', async () => {
    const userAdmin = await addMember(world, 'user-admin');
    const created = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: userAdmin.id, role: 'user_admin', grantableAdminRoles: [], grantableProfileIds: [allowed.id] },
    });
    expect(created.status).toBe(201);
    const asUserAdmin = { user: userAdmin.id, tenant: world.tenant.id };
    expect(await grantableCodes(asUserAdmin)).toEqual(['hr']);

    const someone = await addMember(world, 'someone');
    const asSystemAdmin = await world.api.request('POST', `${BASE}/admins`, {
      ...asUserAdmin,
      body: { userId: someone.id, role: 'system_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(asSystemAdmin.status).toBe(403);
  });

  it('授予给非本租户成员 → 400；重复授予同一身份 → 409', async () => {
    // 他租户成员：有全局用户，但不是本租户成员
    const other = await seedTenantWithMember(testDb().db, 'other');
    const notMember = await grant(world, other.user.id, allowed.id);
    expect(notMember.status).toBe(400);
    const listed = await world.api.request('GET', `${BASE}/grants?userId=${other.user.id}`, world.asAdmin);
    expect(((await listed.json()) as ListBody<GrantBody>).items).toEqual([]);
    const twice = await addMember(world, 'twice');
    expect((await grant(world, twice.id, allowed.id)).status).toBe(201);
    const again = await grant(world, twice.id, allowed.id);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('CONFLICT');
  });

  it('同一 Idempotency-Key 重放返回首次结果；撤销必须带 revision，旧 revision → 409；授权与撤销都写审计', async () => {
    const user = await addMember(world, 'idem');
    const options = {
      ...world.asAdmin,
      idempotencyKey: 'grant-idem-1',
      body: { userId: user.id, profileId: allowed.id },
    };
    const first = await world.api.request('POST', `${BASE}/grants`, options);
    const replay = await world.api.request('POST', `${BASE}/grants`, options);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const created = (await first.json()) as GrantBody;
    expect(((await replay.json()) as GrantBody).id).toBe(created.id);

    const noRevision = await world.api.request('POST', `${BASE}/grants/${created.id}/revoke`, world.asAdmin);
    expect(await errorCode(noRevision)).toBe('REVISION_REQUIRED');
    const stale = await world.api.request('POST', `${BASE}/grants/${created.id}/revoke`, {
      ...world.asAdmin,
      ifMatch: 9,
    });
    expect(stale.status).toBe(409);
    const revoked = await world.api.request('POST', `${BASE}/grants/${created.id}/revoke`, {
      ...world.asAdmin,
      ifMatch: created.revision,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ status: 'revoked', revision: created.revision + 1 });

    const events = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.objectId, created.id)),
    );
    expect(events.map((e) => e.action).sort()).toEqual(['permission_grant.create', 'permission_grant.revoke']);
  });
});
