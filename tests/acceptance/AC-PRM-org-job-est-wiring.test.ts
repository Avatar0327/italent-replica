/** DEC-080 / AC-PRM-03,04,22：真实权限授权器覆盖组织、职务、编制的每层边界。 */
import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';
const CLOCK = () => new Date(`${TODAY}T12:00:00Z`);
const paths = {
  organization: '/api/tenant/org/organizations',
  jobPost: '/api/tenant/job/posts',
  establishment: '/api/tenant/establishment/schemes',
} as const;

describe('DEC-080 组织 / 职务 / 编制真实路由权限', () => {
  let world: PermissionWorld;
  let fixture: ReturnType<typeof tenantApi>;
  let org: { id: string; revision: number };
  let secondOrg: { id: string; revision: number };
  let post: { id: string; revision: number };
  let scheme: { id: string; revision: number };
  let capacity: { id: string; revision: number };

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: CLOCK }) };
    fixture = tenantApi(world.db, { clock: CLOCK });
    const create = async (path: string, body: object) => {
      const response = await fixture.request('POST', path, { ...world.asAdmin, ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string; revision: number };
    };
    org = await create(paths.organization, {
      name: '范围内组织',
      remarks: '隐藏组织备注',
      startDate: '2026-01-01',
      parents: { admin: { parentId: world.tenant.id } },
    });
    secondOrg = await create(paths.organization, {
      name: '范围外组织',
      startDate: '2026-01-01',
      parents: { admin: { parentId: world.tenant.id } },
    });
    post = await create(paths.jobPost, {
      name: '测试职务',
      code: `P${randomUUID().slice(0, 8)}`,
      responsibilities: '隐藏职责',
      startDate: '2026-01-01',
    });
    scheme = await create(paths.establishment, {
      name: '测试编制方案',
      periodType: 'annual',
      maintenanceMode: 'inclusive',
      startDate: '2026-01-01',
    });
    capacity = await create('/api/tenant/establishment/capacities', {
      orgId: secondOrg.id,
      schemeId: scheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 10,
    });
  });

  async function actor(
    key: keyof typeof paths,
    options: {
      create?: boolean;
      update?: boolean;
      delete?: boolean;
      editable?: readonly string[];
      hidden?: readonly string[];
      buttons?: { buttonCode: string; level: string }[];
      scope?: boolean | 'all';
    } = {},
  ) {
    const definition = MODULE_OBJECTS[key];
    const profile = await createProfile(world, `scope-${randomUUID().slice(0, 8)}`);
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: {
          create: options.create ?? true,
          update: options.update ?? true,
          delete: options.delete ?? true,
        },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !options.hidden?.includes(field.code),
          edit:
            !field.system &&
            !options.hidden?.includes(field.code) &&
            (options.editable === undefined || options.editable.includes(field.code)),
        })),
        buttons: options.buttons ?? [],
      },
      definition.code,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, 'module-wiring');
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    if (options.scope === 'all') {
      const all = await world.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
        {
          ...world.asAdmin,
          ifMatch: 0,
          body: { targetKind: 'app', targetCode: '', seeAll: true },
        },
      );
      expect(all.status, await all.clone().text()).toBe(200);
    } else if (options.scope) {
      const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
        ...world.asAdmin,
        ifMatch: 0,
        body: { kind: 'org_range', orgRanges: [{ orgId: org.id, includeDescendants: false }] },
      });
      expect(scope.status, await scope.clone().text()).toBe(200);
    }
    return { user: user.id, tenant: world.tenant.id };
  }

  for (const key of Object.keys(paths) as (keyof typeof paths)[]) {
    it(`${key}：canCreate=false 时新建拒绝`, async () => {
      const as = await actor(key, { create: false });
      const body =
        key === 'organization'
          ? { name: '不能创建', parents: { admin: { parentId: org.id } } }
          : key === 'jobPost'
            ? { name: '不能创建', code: `P${randomUUID().slice(0, 8)}` }
            : { name: '不能创建', periodType: 'annual', maintenanceMode: 'local' };
      const response = await world.api.request('POST', paths[key], { ...as, ifMatch: 0, body });
      expect(response.status).toBe(403);
    });

    it(`${key}：不可编辑字段整单拒绝`, async () => {
      const as = await actor(key, { editable: [], scope: key === 'organization' ? true : 'all' });
      const object = key === 'organization' ? org : key === 'jobPost' ? post : scheme;
      const response = await world.api.request('PATCH', `${paths[key]}/${object.id}`, {
        ...as,
        ifMatch: object.revision,
        body: { name: '越权字段修改', effectiveDate: TODAY },
      });
      expect(response.status).toBe(403);
    });

    it(`${key}：默认空范围列表返回无数据权限，详情同不存在`, async () => {
      const as = await actor(key);
      const object = key === 'organization' ? org : key === 'jobPost' ? post : scheme;
      const response = await world.api.request('GET', `${paths[key]}?asOf=${TODAY}`, as);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: [], hasDataPermission: false });
      expect((await world.api.request('GET', `${paths[key]}/${object.id}?asOf=${TODAY}`, as)).status).toBe(404);
    });

    it(`${key}：列表与详情隐藏字段一致`, async () => {
      const hidden = key === 'organization' ? 'remarks' : key === 'jobPost' ? 'responsibilities' : 'name';
      const as = await actor(key, { hidden: [hidden], scope: key === 'organization' ? true : 'all' });
      const object = key === 'organization' ? org : key === 'jobPost' ? post : scheme;
      const response = await world.api.request('GET', `${paths[key]}?asOf=${TODAY}`, as);
      expect(response.status).toBe(200);
      const rows = (await response.json()) as { items: Record<string, unknown>[] };
      expect(rows.items.length).toBeGreaterThan(0);
      for (const row of rows.items) expect(row).not.toHaveProperty(hidden);
      const detail = await world.api.request('GET', `${paths[key]}/${object.id}?asOf=${TODAY}`, as);
      expect(detail.status).toBe(200);
      expect(await detail.json()).not.toHaveProperty(hidden);
    });
  }

  it('组织导入必须具有业务按钮', async () => {
    const as = await actor('organization', { scope: true });
    const response = await world.api.request('POST', '/api/tenant/org/import', {
      ...as,
      ifMatch: 0,
      body: { rows: [{ sourceCode: 'source-org', code: 'IMPORT-ORG', name: '按钮受限', parentId: org.id }] },
    });
    expect(response.status).toBe(403);
  });

  it('职务导入必须具有业务按钮', async () => {
    const as = await actor('jobPost', { scope: 'all' });
    const response = await world.api.request('POST', '/api/tenant/job/import', {
      ...as,
      ifMatch: 0,
      body: { kind: 'posts', rows: [{ sourceCode: 'source-job', code: 'IMPORT-JOB', name: '按钮受限' }] },
    });
    expect(response.status).toBe(403);
  });

  it('编制删除必须具有 canDelete', async () => {
    const as = await actor('establishment', { delete: false, scope: 'all' });
    const response = await world.api.request('DELETE', `${paths.establishment}/${scheme.id}`, {
      ...as,
      ifMatch: scheme.revision,
      body: {},
    });
    expect(response.status).toBe(403);
  });

  it('编制复制必须具有业务按钮', async () => {
    const as = await actor('establishment', { scope: true });
    const response = await world.api.request('POST', '/api/tenant/establishment/copy-jobs', {
      ...as,
      ifMatch: 0,
      body: { capacityIds: [capacity.id] },
    });
    expect(response.status).toBe(403);
  });

  it('编制范围外容量在列表、详情及修改中均不可见', async () => {
    const as = await actor('establishment', { scope: true });
    const list = await world.api.request('GET', '/api/tenant/establishment/capacities', as);
    expect(await list.json()).toMatchObject({ items: [], hasDataPermission: true });
    expect((await world.api.request('GET', `/api/tenant/establishment/capacities/${capacity.id}`, as)).status).toBe(
      404,
    );
    expect(
      (
        await world.api.request('PATCH', `/api/tenant/establishment/capacities/${capacity.id}`, {
          ...as,
          ifMatch: capacity.revision,
          body: { effectiveDate: TODAY, inclusiveCapacity: 11 },
        })
      ).status,
    ).toBe(404);
  });
});
