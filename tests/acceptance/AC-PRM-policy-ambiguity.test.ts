/** AC-PRM-17 / Q-M0-32：页面与数据源之间未定义优先级，冲突配置必须 fail-closed。 */
import { permissionScopePolicies, permissionScopePolicyRules, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { resolveDataScope } from '../../apps/api/src/modules/permission/scope-resolver.js';
import {
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  type PermissionWorld,
} from './AC-PRM-support.js';

const database = useTestDb();
const objectCode = MODULE_OBJECTS.employmentRecord.code;
const targetCode = `${objectCode}.list`;
const path = (kind: string) => `${BASE}/scope-policies/TenantBase/${objectCode}/${kind}/${targetCode}`;
const put = (w: PermissionWorld, kind: string, revision = 0) =>
  w.api.request('PUT', path(kind), { ...w.asAdmin, ifMatch: revision, body: { rules: [] } });

async function storedConflict(w: PermissionWorld) {
  await withTenant(w.db, w.tenant.id, async (tx) => {
    const rows = await tx
      .insert(permissionScopePolicies)
      .values(
        (['entity', 'page', 'datasource'] as const).map((targetKind) => ({
          tenantId: w.tenant.id,
          appCode: 'TenantBase',
          objectCode,
          targetKind,
          targetCode: targetKind === 'entity' ? objectCode : targetCode,
        })),
      )
      .returning();
    const page = rows.find((row) => row.targetKind === 'page')!;
    await tx.insert(permissionScopePolicyRules).values({
      tenantId: w.tenant.id,
      policyId: page.id,
      dimension: 'using_user',
    });
  });
}

const resolve = (w: PermissionWorld, extra = { pageCode: targetCode, dataSourceCode: targetCode }) =>
  withTenant(w.db, w.tenant.id, (tx) =>
    resolveDataScope(tx, {
      tenantId: w.tenant.id,
      userId: w.admin.id,
      appCode: 'TenantBase',
      objectCode,
      asOf: '2026-10-01',
      ...extra,
    }),
  );

describe('AC-PRM-17 Q-M0-32 页面/数据源冲突保守处理', () => {
  it.each(['page', 'datasource'])('先配置 %s 后拒绝另一种策略，即使两者均为空', async (first) => {
    const w = await seedPermissionWorld(database().db);
    const second = first === 'page' ? 'datasource' : 'page';
    expect((await put(w, first)).status).toBe(200);
    const conflict = await put(w, second);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'CONFLICT' } });
    const absent = await w.api.request('GET', path(second), w.asAdmin);
    expect(await absent.json()).toMatchObject({ configured: false, revision: 0 });
    expect((await put(w, first, 1)).status).toBe(200);
  });

  it('并发首次创建不同种类策略只允许一个成功，不能各自锁不同的 targetKind', async () => {
    const w = await seedPermissionWorld(database().db);
    const results = await Promise.all([put(w, 'page'), put(w, 'datasource')]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const rows = await withTenant(w.db, w.tenant.id, (tx) => tx.select().from(permissionScopePolicies));
    expect(rows).toHaveLength(1);
  });

  it('存量双配置不能任意排序取一个；只请求单一上下文时仍分别替换实体', async () => {
    const w = await seedPermissionWorld(database().db);
    await storedConflict(w);
    await expect(resolve(w)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    const page = await resolve(w, { pageCode: targetCode, dataSourceCode: '' });
    expect(page).toMatchObject({ source: 'page', hasDataPermission: true });
    expect(page.terms).toMatchObject([{ dimension: 'using_user', creatorId: w.admin.id }]);
    const source = await resolve(w, { pageCode: '', dataSourceCode: targetCode });
    expect(source).toMatchObject({ source: 'datasource', hasDataPermission: false });
    expect((await resolve(w, { pageCode: '', dataSourceCode: '' })).source).toBe('entity');
  });

  it('明确的身份 seeAll 仍优先，冲突的下层策略不能改变已确认的身份优先级', async () => {
    const w = await seedPermissionWorld(database().db);
    await storedConflict(w);
    const profile = await createProfile(w, 'ambiguity-see-all');
    await makeGrantable(w, [profile.id]);
    expect((await grant(w, w.admin.id, profile.id)).status).toBe(201);
    const all = await w.api.request('PUT', `${BASE}/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...w.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(all.status).toBe(200);
    expect(await resolve(w)).toMatchObject({ all: true, source: 'identity', hasDataPermission: true });
  });
});
