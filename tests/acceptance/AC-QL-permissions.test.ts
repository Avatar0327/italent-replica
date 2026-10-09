/**
 * R3-T02 PR-A 任职资格配置的权限（设计 §5.1、§5.2；DEC-026 / 324② 向下公开；DEC-309 带出值；DEC-043 用户 × 应用范围）：
 * - 数据范围缺省为空：列表为空、新建没有授权管理单元 403；
 * - 读取 = 所属管理单元在范围内 ∪（向下公开 ∧ 范围内有其下级组织）；仅因向下公开可见的对象写入 403
 *   QL_PUBLIC_DOWN_READONLY；不向下公开的上级对象与范围外对象同一个 404；新建的向下公开缺省 false；
 * - 带出值 #1：新建标准时非通用指标的说明只有操作人当前对 Target.description 有查看权才复制，否则能力标准留空；
 * - 带出值 #2：通用指标覆盖写入的能力标准，读取时按查看人当前对 Target.description 的查看权给出，看不到只留标记。
 */
import { randomUUID } from 'node:crypto';
import { QUALIFICATION_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import {
  assignQualificationMou,
  type CategoryView,
  QL_APP,
  QL_BASE,
  QL_NOW,
  type StandardView,
} from './AC-QL-support.js';
import { createMou, createOrg } from './AC-TC-support.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
type ObjectKey = keyof typeof QUALIFICATION_OBJECTS;

interface Data {
  readonly parent: string;
  readonly child: string;
  readonly outside: string;
  readonly childMou: string;
  readonly open: CategoryView;
  readonly closed: CategoryView;
  readonly foreign: CategoryView;
  readonly levelId: string;
  readonly plainTarget: string;
  readonly commonTarget: string;
  readonly standardId: string;
}

async function seed(world: PermissionWorld): Promise<Data> {
  const setup = tenantApi(world.db, { clock: () => QL_NOW });
  const parent = await createOrg(setup, world.asAdmin, '任职资格上级部');
  const child = await createOrg(setup, world.asAdmin, '任职资格下级部', parent);
  const outside = await createOrg(setup, world.asAdmin, '任职资格其他部');
  let revision = 0;
  /** 管理员（单一授权管理单元）在指定组织下建对象：资源集合由系统按授权管理单元填写。 */
  const as = async (orgId: string) => {
    const mou = await createMou(setup, world.asAdmin, [orgId], '任职资格');
    revision = await assignQualificationMou(setup, world.asAdmin, world.asAdmin.user, mou, revision);
  };
  const create = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await setup.request('POST', `${QL_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as T;
  };
  const code = () => `Q${randomUUID().slice(0, 6)}`;
  await as(parent);
  const klass = await create<{ id: string }>('/category-classes', { code: code(), name: '分类', publicDown: true });
  const open = await create<CategoryView>('/categories', {
    code: code(),
    name: '公开类',
    classId: klass.id,
    publicDown: true,
  });
  const closed = await create<CategoryView>('/categories', { code: code(), name: '不公开类', classId: klass.id });
  const level = await create<{ id: string }>('/levels', {
    code: code(),
    name: 'P1',
    displayOrder: 1,
    publicDown: true,
  });
  const type = await create<{ id: string }>('/target-types', { code: code(), name: '类型', publicDown: true });
  const plainTarget = await create<{ id: string }>('/targets', {
    code: code(),
    name: '普通指标',
    typeId: type.id,
    description: '保密说明',
    evalMode: 'score',
    publicDown: true,
  });
  const commonTarget = await create<{ id: string }>('/targets', {
    code: code(),
    name: '通用指标',
    typeId: type.id,
    description: '通用保密说明',
    evalMode: 'score',
    isCommon: true,
    confirmOverwrite: true,
    publicDown: true,
  });
  const standard = await create<StandardView>('/standards', {
    categoryId: open.id,
    name: '公开标准',
    levelIds: [level.id],
    details: [{ levelId: level.id, targetId: commonTarget.id }],
  });
  await as(outside);
  const foreignClass = await create<{ id: string }>('/category-classes', { code: code(), name: '外分类' });
  const foreign = await create<CategoryView>('/categories', { code: code(), name: '外类', classId: foreignClass.id });
  const childMou = await createMou(setup, world.asAdmin, [child], '下级');
  return {
    parent,
    child,
    outside,
    childMou,
    open,
    closed,
    foreign,
    levelId: level.id,
    plainTarget: plainTarget.id,
    commonTarget: commonTarget.id,
    standardId: standard.id,
  };
}

async function operator(
  world: PermissionWorld,
  options: { mouId?: string; hidden?: Partial<Record<ObjectKey, string[]>> },
) {
  const profile = await createProfile(world, `ql-${randomUUID().slice(0, 8)}`, { apps: [QL_APP] });
  for (const key of Object.keys(QUALIFICATION_OBJECTS) as ObjectKey[]) {
    const definition = QUALIFICATION_OBJECTS[key];
    const hidden = new Set(options.hidden?.[key] ?? []);
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: definition.fields.map((field) => ({
          fieldCode: field.code,
          view: !hidden.has(field.code),
          edit: !field.system && !hidden.has(field.code),
        })),
        buttons: definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level })),
      },
      definition.code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  const user = await addMember(world, `ql-op-${randomUUID().slice(0, 4)}`);
  expect((await grant(world, user.id, profile.id)).status).toBe(201);
  const as = { user: user.id, tenant: world.tenant.id };
  if (options.mouId) {
    const response = await world.api.request('PUT', `${BASE}/scopes/${user.id}/${QL_APP}`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: options.mouId },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const request = (method: string, path: string, extra: Parameters<typeof world.api.request>[2] = {}) =>
    world.api.request(method, `${QL_BASE}${path}`, { ...as, ...extra });
  return { request };
}

describe('任职资格配置的数据范围与向下公开', () => {
  let world: PermissionWorld;
  let data: Data;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock: () => QL_NOW }) };
    data = await seed(world);
  });

  it('数据范围缺省为空：列表为空、详情 404、新建 403 NO_MANAGEMENT_UNIT', async () => {
    const op = await operator(world, {});
    const list = await op.request('GET', '/categories');
    expect(await list.json()).toMatchObject({ items: [], hasDataPermission: false });
    expect((await op.request('GET', `/categories/${data.open.id}`)).status).toBe(404);
    const create = await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: 'KX', name: '分类' } });
    expect(create.status).toBe(403);
    expect(((await create.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'NO_MANAGEMENT_UNIT',
    );
  });

  it('下级单元管理员：上级向下公开的对象可读不可写（403），不公开的与范围外的同一个 404', async () => {
    const op = await operator(world, { mouId: data.childMou });
    const list = (await (await op.request('GET', '/categories')).json()) as { items: { id: string }[] };
    expect(list.items.map((c) => c.id)).toEqual([data.open.id]);
    expect((await op.request('GET', `/categories/${data.open.id}`)).status).toBe(200);
    const notFound = [data.closed.id, data.foreign.id, randomUUID()];
    const bodies = new Set<string>();
    for (const id of notFound) {
      const response = await op.request('GET', `/categories/${id}`);
      expect(response.status).toBe(404);
      bodies.add(JSON.stringify(((await response.json()) as { error: { message: string } }).error.message));
    }
    expect(bodies.size).toBe(1);
    const write = await op.request('PATCH', `/categories/${data.open.id}`, {
      ifMatch: data.open.revision,
      body: { name: '改名' },
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'QL_PUBLIC_DOWN_READONLY',
    );
    const remove = await op.request('DELETE', `/categories/${data.open.id}`, { ifMatch: data.open.revision });
    expect(remove.status).toBe(403);
    // 标准锚在类别上：公开类别的标准可读
    expect((await op.request('GET', `/standards/${data.standardId}`)).status).toBe(200);
    // 新建的向下公开缺省 false，资源集合 = 本人的授权管理单元
    const own = await op.request('POST', '/category-classes', { ifMatch: 0, body: { code: 'KOWN', name: '自建' } });
    expect(own.status, await own.clone().text()).toBe(201);
    expect(await own.json()).toMatchObject({ ownerOrgId: data.child, publicDown: false });
  });

  it('带出值 #1：看不到指标说明时，新建标准不复制，能力标准留空；看得到时复制', async () => {
    const hiddenOp = await operator(world, { mouId: data.childMou, hidden: { target: ['description'] } });
    const visibleOp = await operator(world, { mouId: data.childMou });
    const results: string[] = [];
    for (const op of [hiddenOp, visibleOp]) {
      const klass = (await (
        await op.request('POST', '/category-classes', {
          ifMatch: 0,
          body: { code: `K${randomUUID().slice(0, 5)}`, name: '分类' },
        })
      ).json()) as { id: string };
      const category = (await (
        await op.request('POST', '/categories', {
          ifMatch: 0,
          body: { code: `C${randomUUID().slice(0, 5)}`, name: '类别', classId: klass.id },
        })
      ).json()) as { id: string };
      const response = await op.request('POST', '/standards', {
        ifMatch: 0,
        body: {
          categoryId: category.id,
          name: '标准',
          levelIds: [data.levelId],
          details: [{ levelId: data.levelId, targetId: data.plainTarget }],
        },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const standard = (await response.json()) as StandardView;
      results.push(standard.details[0]!.abilities[0]!.content ?? '');
    }
    expect(results).toEqual(['', '保密说明']);
  });

  it('带出值 #2：通用指标覆盖写入的能力标准，看不到指标说明时只给标记、不给值', async () => {
    const hiddenOp = await operator(world, { mouId: data.childMou, hidden: { target: ['description'] } });
    const standard = (await (await hiddenOp.request('GET', `/standards/${data.standardId}`)).json()) as StandardView;
    const ability = standard.details[0]!.abilities[0]!;
    expect(ability).toMatchObject({ source: 'common_overwrite', projectionHidden: true });
    expect(ability).not.toHaveProperty('content');
    const visibleOp = await operator(world, { mouId: data.childMou });
    const shown = (await (await visibleOp.request('GET', `/standards/${data.standardId}`)).json()) as StandardView;
    expect(shown.details[0]!.abilities[0]).toMatchObject({ content: '通用保密说明', source: 'common_overwrite' });
  });
});
