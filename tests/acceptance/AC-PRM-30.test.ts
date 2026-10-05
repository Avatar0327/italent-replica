/**
 * AC-PRM-30（DEC-121、DEC-081；R1-T17）：开通租户时为标准 HR 身份预置无组织字段对象（职务字典、编制方案）的“看全部”，
 * 开箱效果与原站一致（`11` §17）；新建的自定义身份默认看不到（数据范围默认空）。有组织字段的对象仍按组织范围裁剪：
 * 职位按所属组织，组织编制按组织（预置只放开编制方案，不连带放开组织编制）。
 */
import { randomUUID } from 'node:crypto';
import { grantMembership } from '@italent/db';
import { ESTABLISHMENT_SCHEME_PAGE, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';
const CLOCK = () => new Date(`${TODAY}T04:00:00Z`);

interface Listing {
  items: { id: string }[];
  hasDataPermission: boolean;
}

describe('AC-PRM-30 标准 HR 身份预置无组织字段对象的看全部', () => {
  let api: ReturnType<typeof tenantApi>;
  let fixture: ReturnType<typeof tenantApi>;
  let result: ProvisionResult;
  let asAdmin: { user: string; tenant: string };
  let asH: { user: string; tenant: string };
  let asX: { user: string; tenant: string };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const { db } = testDb();
    api = tenantApi(db, { authorize: undefined, clock: CLOCK });
    fixture = tenantApi(db, { clock: CLOCK });
    const operator = await seedOperator(db);
    const admin = await newUser(db, 'prm30-admin');
    result = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: admin.id });
    asAdmin = { user: admin.id, tenant: result.tenant.id };

    const create = async (path: string, body: object) => {
      const res = await fixture.request('POST', path, { ...asAdmin, ifMatch: 0, body });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const root = { admin: { parentId: result.tenant.id } };
    ids.inside = await create('/api/tenant/org/organizations', {
      name: 'H 的组织',
      startDate: '2026-01-01',
      parents: root,
    });
    ids.outside = await create('/api/tenant/org/organizations', {
      name: '范围外',
      startDate: '2026-01-01',
      parents: root,
    });
    for (const name of ['职务甲', '职务乙']) {
      ids[name] = await create('/api/tenant/job/posts', {
        name,
        code: `P${randomUUID().slice(0, 8)}`,
        startDate: '2026-01-01',
      });
    }
    ids.positionIn = await create('/api/tenant/job/positions', {
      name: '范围内职位',
      orgId: ids.inside,
      postId: ids['职务甲'],
      startDate: '2026-01-01',
    });
    ids.positionOut = await create('/api/tenant/job/positions', {
      name: '范围外职位',
      orgId: ids.outside,
      postId: ids['职务乙'],
      startDate: '2026-01-01',
    });
    for (const name of ['方案一', '方案二']) {
      ids[name] = await create('/api/tenant/establishment/schemes', {
        name,
        periodType: 'annual',
        maintenanceMode: 'inclusive',
        startDate: '2026-01-01',
      });
    }
    ids.capacityOut = await create('/api/tenant/establishment/capacities', {
      orgId: ids.outside,
      schemeId: ids['方案一'],
      periodStart: '2026-01-01',
      inclusiveCapacity: 3,
    });

    const member = async (label: string) => {
      const user = await newUser(db, label);
      await grantMembership(db, { tenantId: result.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
      return { user: user.id, tenant: result.tenant.id };
    };
    asH = await member('hr-h');
    asX = await member('custom-x');

    const hrProfile = result.profiles.find((p) => p.code === 'standard_hr_admin')!;
    const granted = await api.request('POST', '/api/tenant/permission/grants', {
      ...asAdmin,
      body: { userId: asH.user, profileId: hrProfile.id },
    });
    expect(granted.status, await granted.clone().text()).toBe(201);
    const scope = await api.request('PUT', `/api/tenant/permission/scopes/${asH.user}/TenantBase`, {
      ...asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: ids.inside, includeDescendants: false }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);

    // 自定义身份 X：只勾选了“职务”对象权限，未配置看全部
    const created = await api.request('POST', '/api/tenant/permission/profiles', {
      ...asAdmin,
      body: { code: 'custom_post_viewer', name: '职务查看', apps: ['TenantBase'], licenseType: null },
    });
    const custom = (await created.json()) as { id: string; revision: number };
    const post = MODULE_OBJECTS.jobPost;
    const configured = await api.request('PUT', `/api/tenant/permission/profiles/${custom.id}/objects/${post.code}`, {
      ...asAdmin,
      ifMatch: custom.revision,
      body: {
        dataOperations: { create: false, update: false, delete: false },
        fields: post.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
        buttons: [],
      },
    });
    expect(configured.status, await configured.clone().text()).toBe(200);
    const admins = await api.request('GET', '/api/tenant/permission/admins', asAdmin);
    const record = (
      (await admins.json()) as { items: { id: string; revision: number; grantableProfileIds: string[] }[] }
    ).items[0]!;
    await api.request('PUT', `/api/tenant/permission/admins/${record.id}`, {
      ...asAdmin,
      ifMatch: record.revision,
      body: { grantableAdminRoles: ['tenant_admin'], grantableProfileIds: [...record.grantableProfileIds, custom.id] },
    });
    const grantX = await api.request('POST', '/api/tenant/permission/grants', {
      ...asAdmin,
      body: { userId: asX.user, profileId: custom.id },
    });
    expect(grantX.status, await grantX.clone().text()).toBe(201);
  });

  const list = async (as: { user: string; tenant: string }, path: string) => {
    const res = await api.request('GET', `${path}?asOf=${TODAY}`, as);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as Listing;
  };

  it('H（标准 HR 身份，范围 = 某组织）看到全部职务与全部编制方案', async () => {
    const posts = await list(asH, '/api/tenant/job/posts');
    expect(posts.hasDataPermission).toBe(true);
    expect(posts.items.map((p) => p.id).sort()).toEqual([ids['职务甲'], ids['职务乙']].sort());
    const schemes = await list(asH, '/api/tenant/establishment/schemes');
    expect(schemes.hasDataPermission).toBe(true);
    expect(schemes.items.map((s) => s.id).sort()).toEqual([ids['方案一'], ids['方案二']].sort());
    const detail = await api.request('GET', `/api/tenant/establishment/schemes/${ids['方案二']}?asOf=${TODAY}`, asH);
    expect(detail.status).toBe(200);
  });

  it('H 的职位列表仍按组织范围裁剪；组织编制不因预置而放开', async () => {
    const positions = await list(asH, '/api/tenant/job/positions');
    expect(positions.items.map((p) => p.id)).toEqual([ids.positionIn]);
    const outside = await api.request('GET', `/api/tenant/job/positions/${ids.positionOut}?asOf=${TODAY}`, asH);
    expect(outside.status).toBe(404);
    const capacities = await list(asH, '/api/tenant/establishment/capacities');
    expect(capacities.items.map((c) => c.id)).not.toContain(ids.capacityOut);
    const capacity = await api.request(
      'GET',
      `/api/tenant/establishment/capacities/${ids.capacityOut}?asOf=${TODAY}`,
      asH,
    );
    expect(capacity.status).toBe(404);
  });

  it('X（自定义身份，只勾选职务、未配置看全部）看到 0 条，并提示无数据权限', async () => {
    const posts = await list(asX, '/api/tenant/job/posts');
    expect(posts).toEqual({ items: [], hasDataPermission: false });
  });

  it('预置的看全部可在数据权限中查看（租户管理员可调整）', async () => {
    const hrProfile = result.profiles.find((p) => p.code === 'standard_hr_admin')!;
    const base = `/api/tenant/permission/profiles/${hrProfile.id}/data-scopes/TenantBase`;
    const post = await api.request(
      'GET',
      `${base}?targetKind=entity&targetCode=${MODULE_OBJECTS.jobPost.code}`,
      asAdmin,
    );
    expect(post.status, await post.clone().text()).toBe(200);
    expect(await post.json()).toMatchObject({ seeAll: true, revision: 1 });
    const scheme = await api.request('GET', `${base}?targetKind=page&targetCode=${ESTABLISHMENT_SCHEME_PAGE}`, asAdmin);
    expect(scheme.status, await scheme.clone().text()).toBe(200);
    expect(await scheme.json()).toMatchObject({ seeAll: true, revision: 1 });
    const position = await api.request(
      'GET',
      `${base}?targetKind=entity&targetCode=${MODULE_OBJECTS.jobPosition.code}`,
      asAdmin,
    );
    expect(await position.json()).toMatchObject({ seeAll: false });
    const custom = result.profiles.find((p) => p.code === 'standard_manager')!;
    const manager = await api.request(
      'GET',
      `/api/tenant/permission/profiles/${custom.id}/data-scopes/TenantBase?targetKind=entity&targetCode=${MODULE_OBJECTS.jobPost.code}`,
      asAdmin,
    );
    expect(await manager.json()).toMatchObject({ seeAll: false });
  });
});
