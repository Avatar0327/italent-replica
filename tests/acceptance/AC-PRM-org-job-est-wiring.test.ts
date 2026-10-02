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
  let position: { id: string; revision: number };
  let outsidePosition: { id: string; revision: number };

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
    position = await create('/api/tenant/job/positions', {
      name: '范围内职位',
      orgId: org.id,
      postId: post.id,
      workLocation: '隐藏地点',
      startDate: '2026-01-01',
    });
    outsidePosition = await create('/api/tenant/job/positions', {
      name: '范围外职位',
      orgId: secondOrg.id,
      postId: post.id,
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
    key: keyof typeof MODULE_OBJECTS,
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
    return { user: user.id, tenant: world.tenant.id, profile };
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

  it('职位按所属组织在SQL分页前过滤，范围外详情/修改不可见', async () => {
    const as = await actor('jobPosition', { scope: true, hidden: ['workLocation'] });
    const list = await world.api.request('GET', `/api/tenant/job/positions?asOf=${TODAY}&pageSize=1`, as);
    expect(list.status).toBe(200);
    const result = (await list.json()) as { items: Record<string, unknown>[]; hasDataPermission: boolean };
    expect(result.hasDataPermission).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe(position.id);
    expect(result.items[0]).not.toHaveProperty('workLocation');
    const detail = await world.api.request('GET', `/api/tenant/job/positions/${position.id}?asOf=${TODAY}`, as);
    expect(detail.status).toBe(200);
    expect(await detail.json()).not.toHaveProperty('workLocation');
    expect(
      (await world.api.request('GET', `/api/tenant/job/positions/${outsidePosition.id}?asOf=${TODAY}`, as)).status,
    ).toBe(404);
    expect(
      (
        await world.api.request('PATCH', `/api/tenant/job/positions/${outsidePosition.id}`, {
          ...as,
          ifMatch: outsidePosition.revision,
          body: { effectiveDate: TODAY, name: '范围外修改' },
        })
      ).status,
    ).toBe(404);
  });

  it('组织预占释放受delete操作控制', async () => {
    const as = await actor('organization', { delete: false, scope: 'all' });
    const held = await fixture.request('POST', '/api/tenant/org/code-reservations', { ...as, ifMatch: 0, body: {} });
    const record = (await held.json()) as { id: string; revision: number };
    expect(held.status).toBe(201);
    expect(
      (
        await world.api.request('DELETE', `/api/tenant/org/code-reservations/${record.id}`, {
          ...as,
          ifMatch: record.revision,
          body: {},
        })
      ).status,
    ).toBe(403);
  });

  it('范围和字段/导入按钮齐备的组织导入可执行并按字段返回回执', async () => {
    const as = await actor('organization', { scope: true, buttons: [{ buttonCode: 'import', level: 'list' }] });
    const response = await world.api.request('POST', '/api/tenant/org/import', {
      ...as,
      ifMatch: 0,
      body: { rows: [{ sourceCode: 'positive-org', code: 'POSITIVE-ORG', name: '有权导入', parentId: org.id }] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ results: [{ status: 'created', sourceCode: 'positive-org' }] });
  });

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
  async function fixtureCreate(path: string, body: object) {
    const response = await fixture.request('POST', path, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  }

  async function revokeScope(user: string) {
    const response = await world.api.request('PUT', `/api/tenant/permission/scopes/${user}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 1,
      body: { kind: 'default' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  it('职位成功命令在收回范围后不能用原幂等键重放旧结果', async () => {
    const as = await actor('jobPosition', { scope: true });
    const made = await fixtureCreate('/api/tenant/job/positions', {
      name: '重放职位',
      orgId: org.id,
      postId: post.id,
      startDate: '2026-01-01',
    });
    const input = {
      ...as,
      ifMatch: made.revision,
      idempotencyKey: randomUUID(),
      body: { effectiveDate: TODAY, name: '第一次成功' },
    };
    expect((await world.api.request('PATCH', `/api/tenant/job/positions/${made.id}`, input)).status).toBe(200);
    await revokeScope(as.user);
    expect((await world.api.request('PATCH', `/api/tenant/job/positions/${made.id}`, input)).status).toBe(404);
  });

  it('当前职位移入范围也不能重放包含旧范围外组织的缓存快照', async () => {
    const as = await actor('jobPosition', { scope: 'all' });
    const made = await fixtureCreate('/api/tenant/job/positions', {
      name: '旧快照职位',
      orgId: secondOrg.id,
      postId: post.id,
      startDate: '2026-01-01',
    });
    const input = {
      ...as,
      ifMatch: made.revision,
      idempotencyKey: randomUUID(),
      body: { effectiveDate: TODAY, name: '旧范围外快照' },
    };
    const first = await world.api.request('PATCH', `/api/tenant/job/positions/${made.id}`, input);
    expect(first.status).toBe(200);
    const moved = await fixture.request('PATCH', `/api/tenant/job/positions/${made.id}`, {
      ...world.asAdmin,
      ifMatch: 2,
      body: { effectiveDate: TODAY, orgId: org.id },
    });
    expect(moved.status).toBe(200);
    expect(
      (
        await world.api.request('PUT', `/api/tenant/permission/profiles/${as.profile.id}/data-scopes/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 1,
          body: { targetKind: 'app', targetCode: '', seeAll: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await world.api.request('PUT', `/api/tenant/permission/scopes/${as.user}/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { kind: 'org_range', orgRanges: [{ orgId: org.id, includeDescendants: false }] },
        })
      ).status,
    ).toBe(200);
    expect((await world.api.request('PATCH', `/api/tenant/job/positions/${made.id}`, input)).status).toBe(404);
  });

  it('编制修改在收回范围后不能重放', async () => {
    const as = await actor('establishment', { scope: true, buttons: [{ buttonCode: 'copy', level: 'list' }] });
    const made = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: org.id,
      schemeId: scheme.id,
      periodStart: '2027-01-01',
      inclusiveCapacity: 10,
    });
    const patch = {
      ...as,
      ifMatch: made.revision,
      idempotencyKey: randomUUID(),
      body: { effectiveDate: '2027-01-01', inclusiveCapacity: 11 },
    };
    expect((await world.api.request('PATCH', `/api/tenant/establishment/capacities/${made.id}`, patch)).status).toBe(
      200,
    );
    await revokeScope(as.user);
    expect((await world.api.request('PATCH', `/api/tenant/establishment/capacities/${made.id}`, patch)).status).toBe(
      404,
    );
  });

  it('编制 subdivisions 的 edit 不能代替嵌套容量字段 edit', async () => {
    const as = await actor('establishment', { scope: true, editable: ['effectiveDate', 'subdivisions', 'positionId'] });
    const customScheme = await fixtureCreate(paths.establishment, {
      name: '细分字段方案',
      periodType: 'annual',
      maintenanceMode: 'both',
      subdivision: 'position',
      startDate: '2026-01-01',
    });
    const made = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: org.id,
      schemeId: customScheme.id,
      periodStart: '2026-01-01',
      subdivisions: [{ positionId: position.id, localCapacity: 1, inclusiveCapacity: 2 }],
    });
    const changed = await world.api.request('PATCH', `/api/tenant/establishment/capacities/${made.id}`, {
      ...as,
      ifMatch: made.revision,
      body: {
        effectiveDate: TODAY,
        subdivisions: [{ positionId: position.id, localCapacity: 5, inclusiveCapacity: 6 }],
      },
    });
    expect(changed.status).toBe(403);
    expect(
      await (await fixture.request('GET', `/api/tenant/establishment/capacities/${made.id}`, world.asAdmin)).json(),
    ).toMatchObject({ revision: 1, localCapacity: 1, inclusiveCapacity: 2 });
  });

  it('子部门范围不能通过 syncParents 修改无权父部门，整单回滚', async () => {
    const child = await fixtureCreate(paths.organization, {
      name: '仅有权子部门',
      startDate: '2026-01-01',
      parents: { admin: { parentId: org.id } },
    });
    const ownScheme = await fixtureCreate(paths.establishment, {
      name: '同步父级方案',
      periodType: 'annual',
      maintenanceMode: 'inclusive',
      startDate: '2026-01-01',
    });
    const parentCap = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: org.id,
      schemeId: ownScheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 10,
    });
    const childCap = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: child.id,
      schemeId: ownScheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 1,
    });
    const as = await actor('establishment');
    expect(
      (
        await world.api.request('PUT', `/api/tenant/permission/scopes/${as.user}/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { kind: 'org_range', orgRanges: [{ orgId: child.id, includeDescendants: false }] },
        })
      ).status,
    ).toBe(200);
    const changed = await world.api.request('PATCH', `/api/tenant/establishment/capacities/${childCap.id}`, {
      ...as,
      ifMatch: 1,
      body: { effectiveDate: TODAY, inclusiveCapacity: 2, syncParents: true },
    });
    expect(changed.status).toBe(404);
    for (const [record, expected] of [
      [parentCap, 10],
      [childCap, 1],
    ] as const) {
      expect(
        await (await fixture.request('GET', `/api/tenant/establishment/capacities/${record.id}`, world.asAdmin)).json(),
      ).toMatchObject({ revision: 1, inclusiveCapacity: expected });
    }
  });

  it('原同步父级命令即使入口子级仍有权，收窄为子级后也不能重放', async () => {
    const child = await fixtureCreate(paths.organization, {
      name: '重放子部门',
      startDate: '2026-01-01',
      parents: { admin: { parentId: org.id } },
    });
    const ownScheme = await fixtureCreate(paths.establishment, {
      name: '重放祖先方案',
      periodType: 'annual',
      maintenanceMode: 'inclusive',
      startDate: '2026-01-01',
    });
    await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: org.id,
      schemeId: ownScheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 10,
    });
    const childCap = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: child.id,
      schemeId: ownScheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 1,
    });
    const as = await actor('establishment', { scope: 'all' });
    const input = {
      ...as,
      ifMatch: 1,
      idempotencyKey: randomUUID(),
      body: { effectiveDate: TODAY, inclusiveCapacity: 2, syncParents: true },
    };
    expect(
      (await world.api.request('PATCH', `/api/tenant/establishment/capacities/${childCap.id}`, input)).status,
    ).toBe(200);
    expect(
      (
        await world.api.request('PUT', `/api/tenant/permission/profiles/${as.profile.id}/data-scopes/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 1,
          body: { targetKind: 'app', targetCode: '', seeAll: false },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await world.api.request('PUT', `/api/tenant/permission/scopes/${as.user}/TenantBase`, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { kind: 'org_range', orgRanges: [{ orgId: child.id, includeDescendants: false }] },
        })
      ).status,
    ).toBe(200);
    expect(
      (await world.api.request('PATCH', `/api/tenant/establishment/capacities/${childCap.id}`, input)).status,
    ).toBe(404);
  });

  it('职务导入映射与编制复制入队重放前仍检查当前范围', async () => {
    const as = await actor('jobPosition', { scope: true, buttons: [{ buttonCode: 'import', level: 'list' }] });
    const input = {
      ...as,
      ifMatch: 0,
      idempotencyKey: randomUUID(),
      body: {
        kind: 'positions',
        rows: [{ sourceCode: randomUUID(), code: randomUUID(), name: '导入重放', orgId: org.id, postId: post.id }],
      },
    };
    expect((await world.api.request('POST', '/api/tenant/job/import', input)).status).toBe(200);
    await revokeScope(as.user);
    expect((await world.api.request('POST', '/api/tenant/job/import', input)).status).toBe(404);
    const est = await actor('establishment', { scope: true, buttons: [{ buttonCode: 'copy', level: 'list' }] });
    const ownScheme = await fixtureCreate(paths.establishment, {
      name: '复制重放方案',
      periodType: 'annual',
      maintenanceMode: 'inclusive',
      startDate: '2026-01-01',
    });
    const source = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: org.id,
      schemeId: ownScheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 10,
    });
    const copy = { ...est, ifMatch: 0, idempotencyKey: randomUUID(), body: { capacityIds: [source.id] } };
    expect((await world.api.request('POST', '/api/tenant/establishment/copy-jobs', copy)).status).toBe(202);
    await revokeScope(est.user);
    expect((await world.api.request('POST', '/api/tenant/establishment/copy-jobs', copy)).status).toBe(404);
  });

  it('编制复制执行的缓存不能绕过目标字段权限收回', async () => {
    const buttons = [
      { buttonCode: 'copy', level: 'list' },
      { buttonCode: 'execute', level: 'detail' },
    ];
    const as = await actor('establishment', { scope: true, buttons });
    const ownScheme = await fixtureCreate(paths.establishment, {
      name: '复制字段重放方案',
      periodType: 'annual',
      maintenanceMode: 'inclusive',
      startDate: '2026-01-01',
    });
    const source = await fixtureCreate('/api/tenant/establishment/capacities', {
      orgId: org.id,
      schemeId: ownScheme.id,
      periodStart: '2026-01-01',
      inclusiveCapacity: 10,
    });
    const queued = await world.api.request('POST', '/api/tenant/establishment/copy-jobs', {
      ...as,
      ifMatch: 0,
      body: { capacityIds: [source.id] },
    });
    expect(queued.status).toBe(202);
    const job = (await queued.json()) as { id: string; revision: number };
    const input = { ...as, ifMatch: job.revision, idempotencyKey: randomUUID(), body: {} };
    const executed = await world.api.request('POST', `/api/tenant/establishment/copy-jobs/${job.id}/execute`, input);
    expect(executed.status, await executed.clone().text()).toBe(200);
    expect(await executed.json()).toMatchObject({ status: 'succeeded' });
    expect(
      (
        await setObjectPermission(
          world,
          as.profile,
          {
            dataOperations: { create: true, update: true, delete: true },
            buttons,
            fields: MODULE_OBJECTS.establishment.fields.map((field) => ({
              fieldCode: field.code,
              view: true,
              edit: !field.system && field.code !== 'inclusiveCapacity',
            })),
          },
          MODULE_OBJECTS.establishment.code,
        )
      ).status,
    ).toBe(200);
    expect(
      (await world.api.request('POST', `/api/tenant/establishment/copy-jobs/${job.id}/execute`, input)).status,
    ).toBe(403);
  });

  for (const imported of [false, true]) {
    it(`组织${imported ? '导入新增' : '直接新增'}同键重放必须按现行父级权限检查`, async () => {
      const as = await actor('organization', { scope: true, buttons: [{ buttonCode: 'import', level: 'list' }] });
      const body = imported
        ? { rows: [{ sourceCode: randomUUID(), code: randomUUID(), name: '导入创建后移出', parentId: org.id }] }
        : { name: '直接创建后移出', parents: { admin: { parentId: org.id } } };
      const path = imported ? '/api/tenant/org/import' : paths.organization;
      const input = { ...as, ifMatch: 0, idempotencyKey: randomUUID(), body };
      const first = await world.api.request('POST', path, input);
      expect(first.status, await first.clone().text()).toBe(imported ? 200 : 201);
      const data = (await first.json()) as { id: string; results: { orgId: string }[] };
      const id = imported ? data.results[0]!.orgId : data.id;
      expect((await world.api.request('POST', path, input)).status).toBe(imported ? 200 : 201);
      expect(
        (
          await fixture.request('PATCH', `${paths.organization}/${id}`, {
            ...world.asAdmin,
            ifMatch: 1,
            body: { effectiveDate: TODAY, parents: { admin: { parentId: secondOrg.id } } },
          })
        ).status,
      ).toBe(200);
      expect((await world.api.request('GET', `${paths.organization}/${id}`, as)).status).toBe(404);
      expect((await world.api.request('POST', path, input)).status).toBe(404);
    });
  }

  for (const imported of [false, true]) {
    it(`职位${imported ? '导入新增' : '直接新增'}同键重放不能绕过当前组织范围`, async () => {
      const as = await actor('jobPosition', { scope: true, buttons: [{ buttonCode: 'import', level: 'list' }] });
      const row = {
        name: `职位创建后移出-${randomUUID()}`,
        code: randomUUID(),
        orgId: org.id,
        postId: post.id,
        startDate: '2026-01-01',
      };
      const body = imported ? { kind: 'positions', rows: [{ ...row, sourceCode: randomUUID() }] } : row;
      const path = imported ? '/api/tenant/job/import' : '/api/tenant/job/positions';
      const input = { ...as, ifMatch: 0, idempotencyKey: randomUUID(), body };
      const first = await world.api.request('POST', path, input);
      expect(first.status, await first.clone().text()).toBe(imported ? 200 : 201);
      const data = (await first.json()) as { id: string; results: { objectId: string }[] };
      const raw = await (await fixture.request('POST', path, input)).json();
      if (imported) expect(raw, JSON.stringify(raw)).toMatchObject({ results: [{ status: 'created' }] });
      const current = (await (
        await fixture.request('GET', `/api/tenant/job/positions?name=${encodeURIComponent(row.name)}`, world.asAdmin)
      ).json()) as { items: { id: string; code: string }[] };
      const id = imported ? current.items.find((item) => item.code === row.code)!.id : data.id;
      expect((await world.api.request('POST', path, input)).status).toBe(imported ? 200 : 201);
      expect(
        (
          await fixture.request('PATCH', `/api/tenant/job/positions/${id}`, {
            ...world.asAdmin,
            ifMatch: 1,
            body: { effectiveDate: TODAY, orgId: secondOrg.id },
          })
        ).status,
      ).toBe(200);
      expect((await world.api.request('GET', `/api/tenant/job/positions/${id}`, as)).status).toBe(404);
      expect((await world.api.request('POST', path, input)).status).toBe(404);
    });
  }

  async function addObjectView(as: Awaited<ReturnType<typeof actor>>, key: keyof typeof MODULE_OBJECTS) {
    const definition = MODULE_OBJECTS[key];
    const response = await setObjectPermission(
      world,
      as.profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function objectAll(as: Awaited<ReturnType<typeof actor>>, key: keyof typeof MODULE_OBJECTS) {
    const response = await world.api.request(
      'PUT',
      `/api/tenant/permission/profiles/${as.profile.id}/data-scopes/TenantBase`,
      {
        ...world.asAdmin,
        ifMatch: 0,
        body: { targetKind: 'entity', targetCode: MODULE_OBJECTS[key].code, seeAll: true },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }

  it('职级候选不能借用 JobLevel 看全部查询范围外 JobPost', async () => {
    const as = await actor('jobLevel');
    await addObjectView(as, 'jobPost');
    await objectAll(as, 'jobLevel');
    expect((await world.api.request('GET', `/api/tenant/job/candidates/levels?postId=${post.id}`, as)).status).toBe(
      404,
    );
  });

  for (const [kind, key, field] of [
    ['levels', 'jobLevel', 'levelId'],
    ['grades', 'jobGrade', 'gradeId'],
  ] as const) {
    it(`任职校验不能探测范围外 ${key}`, async () => {
      const as = await actor('jobPost', { buttons: [{ buttonCode: 'validate', level: 'detail' }] });
      await addObjectView(as, key);
      await objectAll(as, 'jobPost');
      const reference = await fixtureCreate(`/api/tenant/job/${kind}`, {
        name: '隐藏的关联对象',
        startDate: '2026-01-01',
        [kind === 'levels' ? 'level' : 'grade']: 1,
      });
      expect(
        (
          await world.api.request('POST', '/api/tenant/job/validate-assignment', {
            ...as,
            body: { postId: post.id, [field]: reference.id, asOf: TODAY },
          })
        ).status,
      ).toBe(404);
    });
  }

  for (const key of Object.keys(paths) as (keyof typeof paths)[]) {
    it(`${key}：页面使用用户规则覆盖默认空范围，只读本人创建记录`, async () => {
      const as = await actor(key);
      const body =
        key === 'organization'
          ? { name: '本人创建组织', parents: { admin: { parentId: world.tenant.id } } }
          : key === 'jobPost'
            ? { name: '本人创建职务', code: `P${randomUUID().slice(0, 8)}` }
            : { name: '本人创建方案', periodType: 'annual', maintenanceMode: 'local' };
      const made = await fixture.request('POST', paths[key], { ...as, ifMatch: 0, body });
      expect(made.status).toBe(201);
      const own = (await made.json()) as { id: string };
      const objectCode = MODULE_OBJECTS[key].code;
      for (const page of ['list', 'detail']) {
        const configured = await world.api.request(
          'PUT',
          `/api/tenant/permission/scope-policies/TenantBase/${objectCode}/page/${objectCode}.${page}`,
          {
            ...world.asAdmin,
            ifMatch: 0,
            body: { creatorField: 'createdBy', rules: [{ dimension: 'using_user' }] },
          },
        );
        expect(configured.status, await configured.clone().text()).toBe(200);
      }
      const list = await world.api.request('GET', `${paths[key]}?asOf=${TODAY}`, as);
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ items: [{ id: own.id }], hasDataPermission: true });
      expect((await world.api.request('GET', `${paths[key]}/${own.id}?asOf=${TODAY}`, as)).status).toBe(200);
      const other = key === 'organization' ? org : key === 'jobPost' ? post : scheme;
      expect((await world.api.request('GET', `${paths[key]}/${other.id}?asOf=${TODAY}`, as)).status).toBe(404);
    });
  }
  it('组织 using_user 实体范围允许修改本人创建记录，拒绝他人记录', async () => {
    const as = await actor('organization');
    const created = await fixture.request('POST', paths.organization, {
      ...as,
      ifMatch: 0,
      body: { name: '本人维护的组织', parents: { admin: { parentId: org.id } } },
    });
    expect(created.status).toBe(201);
    const own = (await created.json()) as { id: string; revision: number };
    const code = MODULE_OBJECTS.organization.code;
    expect(
      (
        await world.api.request('PUT', `/api/tenant/permission/scope-policies/TenantBase/${code}/entity/${code}`, {
          ...world.asAdmin,
          ifMatch: 0,
          body: { creatorField: 'createdBy', rules: [{ dimension: 'using_user' }] },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await world.api.request('PATCH', `${paths.organization}/${own.id}`, {
          ...as,
          ifMatch: own.revision,
          body: { effectiveDate: TODAY, name: '本人可维护' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await world.api.request('PATCH', `${paths.organization}/${org.id}`, {
          ...as,
          ifMatch: org.revision,
          body: { effectiveDate: TODAY, name: '无权维护' },
        })
      ).status,
    ).toBe(404);
  });
});
