/**
 * DEC-281⑨（`23` §7 ②）：指标库、指标库分类、指标、标准分类、人才标准都带所属人与所属管理单元，**按管理单元控制**
 * （以组织表达，DEC-026 同思路；范围按 用户 × TalentCenter 存一份，DEC-043）。数据范围默认空（fail-closed）。
 * - 范围外的对象在列表、详情、候选里不可见，写入（含新建到范围外、引用范围外的对象）一律 404，数据不变；
 * - 收回管理单元后，原命令按原 ID 重放重新校验范围（404）；
 * - 发展建议类型是没有组织字段的字典（DEC-121 同口径：看全部或创建人），下拉候选只要求指标查看权。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { BASE, seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import {
  clock,
  ownedTargets,
  seedTalentData,
  talentOperator,
  type TalentPermissionData,
} from './AC-TC-permission-support.js';
import { TC_BASE } from './AC-TC-support.js';

const testDb = useTestDb();
const LISTS = ['/libraries', '/dimension-categories', '/dimensions', '/criterion-categories', '/criteria'] as const;

describe('DEC-281⑨ 按管理单元控制人才标准数据', () => {
  let world: PermissionWorld;
  let data: TalentPermissionData;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seedTalentData(world);
  });

  const adminRead = async <T>(path: string): Promise<T> => {
    const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
    expect(response.status, path).toBe(200);
    return (await response.json()) as T;
  };
  const snapshot = () =>
    Promise.all(
      [...LISTS, ...ownedTargets(data.inside), ...ownedTargets(data.outside)].map((entry) =>
        typeof entry === 'string' ? adminRead(entry) : adminRead(`/${entry[0]}/${entry[1].id}`),
      ),
    );

  it('数据范围默认空：列表与候选为空，详情、修改、删除、新建都 404，数据不变', async () => {
    const op = await talentOperator(world);
    for (const path of [...LISTS, '/description-types', '/candidates/dimensions']) {
      const response = await op.request('GET', path);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toMatchObject({ items: [], hasDataPermission: false });
    }
    const owners = (await (await op.request('GET', '/candidates/owner-orgs?object=library')).json()) as {
      items: unknown[];
    };
    expect(owners.items).toEqual([]);
    const before = await snapshot();
    for (const [path, item] of ownedTargets(data.inside)) {
      expect((await op.request('GET', `/${path}/${item.id}`)).status, path).toBe(404);
      const patched = await op.request('PATCH', `/${path}/${item.id}`, {
        ifMatch: item.revision,
        body: { name: '改' },
      });
      expect(patched.status, path).toBe(404);
      expect((await op.request('DELETE', `/${path}/${item.id}`, { ifMatch: item.revision })).status, path).toBe(404);
    }
    const created = await op.request('POST', '/criterion-categories', {
      ifMatch: 0,
      body: { name: '自建分类', ownerOrgId: data.inside.orgId },
    });
    expect(created.status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('管理单元内：列表、候选只含本单元的对象；范围外对象的详情 404', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    for (const path of LISTS) {
      const response = await op.request('GET', path);
      expect(response.status, path).toBe(200);
      const listing = (await response.json()) as { items: { id: string }[]; hasDataPermission: boolean };
      expect(listing.hasDataPermission, path).toBe(true);
      const ids = listing.items.map((item) => item.id);
      const inside = ownedTargets(data.inside).find(([key]) => `/${key}` === path)![1].id;
      const outside = ownedTargets(data.outside).find(([key]) => `/${key}` === path)![1].id;
      expect(ids, path).toContain(inside);
      expect(ids, path).not.toContain(outside);
    }
    const candidates = (await (await op.request('GET', '/candidates/dimensions')).json()) as {
      items: { id: string }[];
    };
    expect(candidates.items.map((item) => item.id)).toEqual([data.inside.dimension.id]);
    const owners = (await (await op.request('GET', '/candidates/owner-orgs?object=library')).json()) as {
      items: { id: string; name: string }[];
    };
    expect(owners.items.map((item) => item.id)).toEqual([data.inside.orgId]);
    // 只有带“所属管理单元”输入的对象才有该候选（库内分类与指标随所属指标库）
    expect((await op.request('GET', '/candidates/owner-orgs?object=dimension')).status).toBe(400);
    for (const [path, item] of ownedTargets(data.inside)) {
      expect((await op.request('GET', `/${path}/${item.id}`)).status, path).toBe(200);
    }
    for (const [path, item] of ownedTargets(data.outside)) {
      expect((await op.request('GET', `/${path}/${item.id}`)).status, path).toBe(404);
    }
  });

  it('管理单元外的写入一律 404：改 / 删范围外对象、新建到范围外、在范围外的库下建指标或分类、引用范围外的指标', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    const { inside, outside } = data;
    const before = await snapshot();
    for (const [path, item] of ownedTargets(outside)) {
      const patched = await op.request('PATCH', `/${path}/${item.id}`, {
        ifMatch: item.revision,
        body: { name: '越权' },
      });
      expect(patched.status, `PATCH ${path}`).toBe(404);
      expect((await op.request('DELETE', `/${path}/${item.id}`, { ifMatch: item.revision })).status, path).toBe(404);
    }
    const posts = [
      ['/libraries', { name: '建到范围外', type: 'ability', ownerOrgId: outside.orgId }],
      ['/criterion-categories', { name: '建到范围外', ownerOrgId: outside.orgId }],
      ['/criteria', { categoryId: inside.criterionCategory.id, name: '建到范围外', ownerOrgId: outside.orgId }],
      ['/dimensions', { libraryId: outside.library.id, code: `OUT${randomUUID().slice(0, 4)}`, name: '外库指标' }],
      ['/dimension-categories', { libraryId: outside.library.id, name: '外库分类', displayOrder: 1 }],
      [
        '/criteria',
        {
          categoryId: inside.criterionCategory.id,
          name: '引用外部指标',
          ownerOrgId: inside.orgId,
          dimensions: [{ dimensionId: outside.dimension.id }],
        },
      ],
      ['/criteria', { categoryId: outside.criterionCategory.id, name: '引用外部分类', ownerOrgId: inside.orgId }],
      [
        '/dimensions',
        {
          libraryId: inside.library.id,
          code: `CAT${randomUUID().slice(0, 4)}`,
          name: '引用外部库分类',
          categoryId: outside.dimensionCategory.id,
        },
      ],
    ] as const;
    for (const [path, body] of posts) {
      const response = await op.request('POST', path, { ifMatch: 0, body });
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(404);
    }
    expect(await snapshot()).toEqual(before);

    // 范围内的新建与修改照常
    const created = await op.request('POST', '/libraries', {
      ifMatch: 0,
      body: { name: '范围内新库', type: 'potential', ownerOrgId: inside.orgId },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await created.json()).toMatchObject({ ownerOrgId: inside.orgId, ownerId: op.user.id });
  });

  it('收回管理单元后，原命令按原 ID 重放重新校验范围：404', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    const command = {
      ifMatch: 0,
      idempotencyKey: `tc-mou-replay-${randomUUID().slice(0, 8)}`,
      body: { name: '重放分类', ownerOrgId: data.inside.orgId },
    };
    const first = await op.request('POST', '/criterion-categories', command);
    expect(first.status, await first.clone().text()).toBe(201);
    const created = (await first.json()) as { id: string };
    await op.setMou(null);
    const replay = await op.request('POST', '/criterion-categories', command);
    expect(replay.status).toBe(404);
    expect((await op.request('GET', `/criterion-categories/${created.id}`)).status).toBe(404);
    expect(await adminRead(`/criterion-categories/${created.id}`)).toMatchObject({ revision: 1 });
  });

  it('发展建议类型是字典（DEC-121）：管理单元内的操作人看不到字典列表，但下拉候选可用、可以选用', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    const listing = (await (await op.request('GET', '/description-types')).json()) as { items: unknown[] };
    expect(listing.items).toEqual([]);
    expect((await op.request('GET', `/description-types/${data.type.id}`)).status).toBe(404);
    const options = (await (await op.request('GET', '/candidates/description-types')).json()) as {
      items: { id: string; name: string }[];
    };
    expect(options.items).toContainEqual(expect.objectContaining({ id: data.type.id, name: '行动建议' }));
    const dimension = await adminRead<{ revision: number }>(`/dimensions/${data.inside.dimension.id}`);
    const saved = await op.request('PATCH', `/dimensions/${data.inside.dimension.id}`, {
      ifMatch: dimension.revision,
      body: { suggestions: [{ typeId: data.type.id, description: '范围内补充建议', displayOrder: 1 }] },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
  });
  // 放在最后：数据权限策略是租户级配置，避免影响前面的用例
  it('DEC-082：管理单元只含 A 且配置了“使用用户”规则，向 B 新建五类对象仍 404，数据不变', async () => {
    const op = await talentOperator(world, { mouId: data.mouId });
    for (const definition of Object.values(TALENT_OBJECTS).filter((d) => d !== TALENT_OBJECTS.descriptionType)) {
      const policy = await world.api.request(
        'PUT',
        `${BASE}/scope-policies/${TALENT_APP}/${definition.code}/entity/${definition.code}`,
        { ...world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'management' }, { dimension: 'using_user' }] } },
      );
      expect(policy.status, await policy.clone().text()).toBe(200);
    }
    // 操作人自己是所属人、但挂在 B 组织下的库：按“使用用户”规则对本人可见
    const own = await data.setup.request('POST', `${TC_BASE}/libraries`, {
      ...op.as,
      ifMatch: 0,
      body: { name: '本人在 B 的库', type: 'ability', ownerOrgId: data.outside.orgId },
    });
    expect(own.status, await own.clone().text()).toBe(201);
    const ownLibrary = (await own.json()) as { id: string };
    expect((await op.request('GET', `/libraries/${ownLibrary.id}`)).status).toBe(200);

    const before = await snapshot();
    const ownLibraryChildren = () =>
      Promise.all([
        adminRead(`/dimension-categories?libraryId=${ownLibrary.id}`),
        adminRead(`/dimensions?libraryId=${ownLibrary.id}`),
      ]);
    const childrenBefore = await ownLibraryChildren();
    const { inside, outside } = data;
    const posts = [
      ['/libraries', { name: 'B 的新库', type: 'ability', ownerOrgId: outside.orgId }],
      ['/criterion-categories', { name: 'B 的新分类', ownerOrgId: outside.orgId }],
      ['/criteria', { categoryId: inside.criterionCategory.id, name: 'B 的新标准', ownerOrgId: outside.orgId }],
      ['/dimension-categories', { libraryId: ownLibrary.id, name: 'B 库下分类', displayOrder: 1 }],
      ['/dimensions', { libraryId: ownLibrary.id, code: `B${randomUUID().slice(0, 4)}`, name: 'B 库下指标' }],
    ] as const;
    for (const [path, body] of posts) {
      const response = await op.request('POST', path, { ifMatch: 0, body });
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
    expect(await ownLibraryChildren()).toEqual(childrenBefore);

    // 本人已有记录照常可改（创建人规则只放行查看与修改）；管理范围内照常新建
    const renamed = await op.request('PATCH', `/libraries/${ownLibrary.id}`, { ifMatch: 1, body: { name: '改名' } });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const inScope = await op.request('POST', '/criterion-categories', {
      ifMatch: 0,
      body: { name: 'A 的新分类', ownerOrgId: inside.orgId },
    });
    expect(inScope.status, await inScope.clone().text()).toBe(201);
  });
});
