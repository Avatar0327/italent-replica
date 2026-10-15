/**
 * DEC-503（补充 DEC-500③）：评定三个字典（活动类型、活动周期、通用评分项）的“看全部 + 新建”给企业设置层的
 * system_admin（系统管理员）；评定管理员不给；存量补装清单里没有这三项。dictionary-service 的新建条件不变（新建只认看全部）。
 * 原站对应身份未取证（未验证，DEC-503）。真实授权器；设了 TEST_DATABASE_URL 时跑在真 PostgreSQL 上。
 */
import { randomUUID } from 'node:crypto';
import { permissionIdentityScopes, sql, withTenant, eq } from '@italent/db';
import { EVALUATION_OBJECTS, presetSeeAllTargets, SEE_ALL_BACKFILL_APPROVED, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { operator } from './AC-EV-support.js';
import { addMember, seedPermissionWorld } from './AC-PRM-support.js';
import { grantsInstalled, legacyWorld, provisionWorld, runBackfill } from './support/f061.js';
import { holderOfProfile } from './support/ql-presets.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const EV_ADMIN = 'standard_evaluation_admin';
const BASE = '/api/tenant/evaluation';
const DICTIONARIES = [
  ['activity-types', 'ev_activity_types', EVALUATION_OBJECTS.activityType.code],
  ['activity-cycles', 'ev_cycles', EVALUATION_OBJECTS.activityCycle.code],
  ['general-score-items', 'ev_general_items', EVALUATION_OBJECTS.generalScoreItem.code],
] as const;
const nameOf = () => `字典${randomUUID()}`;

async function countOf(db: ReturnType<typeof testDb>['db'], tenantId: string, table: string) {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
    return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { n: number }[])[0]!.n;
  });
}

describe('AC-F141-dictionary-see-all 评定字典看全部给企业设置层 system_admin（DEC-503）', () => {
  it('预置清单：任何标准身份都不预置评定三个字典的看全部；批准清单里也没有它们', () => {
    for (const profile of STANDARD_PROFILES)
      expect(
        presetSeeAllTargets(profile).filter((t) => t.appCode === 'TEvaluation'),
        profile.code,
      ).toEqual([]);
    expect(SEE_ALL_BACKFILL_APPROVED.filter((a) => a.appCode === 'TEvaluation')).toEqual([]);
  });

  it('系统管理员（企业设置层，没有任何业务身份）能看到三个字典的全部记录，并能新建', async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    const world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined }) };
    const creator = await operator(world, { seeAll: true });
    const made: Record<string, string[]> = {};
    for (const [path] of DICTIONARIES) {
      made[path] = [];
      for (let i = 0; i < 2; i++) {
        const res = await creator.request('POST', `/${path}`, { ifMatch: 0, body: { name: nameOf() } });
        expect(res.status, `${path} 创建人造数据: ${await res.clone().text()}`).toBe(201);
        made[path]!.push(((await res.json()) as { name: string }).name);
      }
    }
    const sys = await addMember(world, 'f141-system-admin');
    const grantRole = await world.api.request('POST', '/api/tenant/permission/admins', {
      ...world.asAdmin,
      body: { userId: sys.id, role: 'system_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(grantRole.status, await grantRole.clone().text()).toBe(201);
    const as = { user: sys.id, tenant: world.tenant.id };

    for (const [path] of DICTIONARIES) {
      const list = await world.api.request('GET', `${BASE}/${path}?pageSize=50`, as);
      expect(list.status, `${path} 列表: ${await list.clone().text()}`).toBe(200);
      const names = ((await list.json()) as { items: { name: string }[] }).items.map((i) => i.name);
      expect(names, path).toEqual(expect.arrayContaining(made[path]!));
      const created = await world.api.request('POST', `${BASE}/${path}`, {
        ...as,
        ifMatch: 0,
        body: { name: nameOf() },
      });
      expect(created.status, `${path} 新建: ${await created.clone().text()}`).toBe(201);
    }
    // 只限这三个字典：评审组等评定对象不因系统管理员而可见
    const groups = await world.api.request('GET', `${BASE}/review-groups`, as);
    expect([403, 404]).toContain(groups.status);
  });

  it('系统管理员只有看全部与新建：改、删别人建的三个字典记录被拒，库内不变（第 8 轮，DEC-503）', async () => {
    const seeded = await seedPermissionWorld(testDb().db);
    const world = { ...seeded, api: tenantApi(seeded.db, { authorize: undefined }) };
    const creator = await operator(world, { seeAll: true });
    const sys = await addMember(world, 'f141-system-admin-readonly');
    const grantRole = await world.api.request('POST', '/api/tenant/permission/admins', {
      ...world.asAdmin,
      body: { userId: sys.id, role: 'system_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(grantRole.status, await grantRole.clone().text()).toBe(201);
    const as = { user: sys.id, tenant: world.tenant.id };

    for (const [path, table, objectCode] of DICTIONARIES) {
      const made = await creator.request('POST', `/${path}`, { ifMatch: 0, body: { name: nameOf() } });
      expect(made.status, `${path} 造数据: ${await made.clone().text()}`).toBe(201);
      const row = (await made.json()) as { id: string; name: string; revision: number };
      const rowsBefore = await countOf(world.db, world.tenant.id, table);

      const patched = await world.api.request('PATCH', `${BASE}/${path}/${row.id}`, {
        ...as,
        ifMatch: row.revision,
        body: { name: nameOf() },
      });
      expect(patched.status, `${path} 修改: ${await patched.clone().text()}`).toBe(403);
      const removed = await world.api.request('DELETE', `${BASE}/${path}/${row.id}`, { ...as, ifMatch: row.revision });
      expect(removed.status, `${path} 删除: ${await removed.clone().text()}`).toBe(403);

      expect(await countOf(world.db, world.tenant.id, table), `${path} 记录数不变`).toBe(rowsBefore);
      const after = await creator.request('GET', `/${path}/${row.id}`);
      expect(after.status).toBe(200);
      expect(await after.json(), `${path} 记录内容不变`).toMatchObject({ name: row.name, revision: row.revision });

      // 服务端回传的按钮只有新建；前端只按它显示（改、删按钮不出现）
      const me = await world.api.request('GET', `/api/tenant/permission/me/objects/${objectCode}`, as);
      expect(me.status, await me.clone().text()).toBe(200);
      const meBody = (await me.json()) as { buttons: { buttonCode: string }[] };
      expect(
        meBody.buttons.map((b) => b.buttonCode),
        `${path} 可执行按钮`,
      ).toEqual(['create']);

      // 看全部与新建不受影响
      const list = await world.api.request('GET', `${BASE}/${path}?pageSize=50`, as);
      expect(list.status).toBe(200);
      expect(((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(row.id);
      const created = await world.api.request('POST', `${BASE}/${path}`, {
        ...as,
        ifMatch: 0,
        body: { name: nameOf() },
      });
      expect(created.status, `${path} 新建: ${await created.clone().text()}`).toBe(201);
    }
  });

  it('评定管理员不预置看全部：不能新建三个字典（库内不变），也看不到别人建的', async () => {
    const w = await provisionWorld(testDb().db, 'f141-dict-ev-admin');
    const holder = await holderOfProfile(w, EV_ADMIN, 'f141-ev-admin');
    for (const [path, table] of DICTIONARIES) {
      const before = await countOf(w.db, w.tenantId, table);
      const res = await w.api.request('POST', `${BASE}/${path}`, { ...holder, ifMatch: 0, body: { name: nameOf() } });
      expect(res.status, `${path}: ${await res.clone().text()}`).not.toBe(201);
      expect([403, 404], path).toContain(res.status);
      expect(await countOf(w.db, w.tenantId, table), `${path} 库内不变`).toBe(before);
    }
    const scopes = await withTenant(w.db, w.tenantId, (tx) =>
      tx
        .select()
        .from(permissionIdentityScopes)
        .where(eq(permissionIdentityScopes.profileId, w.profileIds.get(EV_ADMIN)!)),
    );
    expect(scopes.filter((row) => row.appCode === 'TEvaluation')).toEqual([]);
  });

  it('存量租户补装后，评定管理员不会多出这三项看全部', async () => {
    const stripped = (profile: (typeof STANDARD_PROFILES)[number]) =>
      profile.code === EV_ADMIN ? { ...profile, seeAll: undefined } : profile;
    const w = await legacyWorld(testDb().db, 'f141-dict-backfill', [stripped]);
    const installed = grantsInstalled(await runBackfill(w));
    expect(installed.filter((code) => code.startsWith(`${EV_ADMIN}/seeAll:TEvaluation`))).toEqual([]);
    const scopes = await withTenant(w.db, w.tenantId, (tx) =>
      tx
        .select()
        .from(permissionIdentityScopes)
        .where(eq(permissionIdentityScopes.profileId, w.profileIds.get(EV_ADMIN)!)),
    );
    expect(scopes.filter((row) => row.appCode === 'TEvaluation')).toEqual([]);
  });
});
