/**
 * R3-T01 权限接入（真实授权器；AGENTS §2 / §10，DEC-080 / DEC-121）：
 * - 人才标准是独立应用 TalentCenter（`16` §52：独立菜单组、独立配置应用、独立身份），对象权限只能挂在带该应用的身份上；
 * - 指标库 / 指标 / 标准分类 / 人才标准都没有组织字段：数据范围默认空，只认“看全部”或“使用用户（创建人）”；
 * - 响应每一层（列表、详情、标准里嵌套的指标内容、候选）都按字段权限裁剪，嵌套指标另按指标对象的查看权与范围；
 * - 写入（含显式清空）逐字段校验编辑权；撤权后原命令重放也拒绝。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_APP, TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import type { Authorizer } from '@italent/api';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  type ProfileBody,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { TC_BASE, TC_NOW, type CriterionView, type DimensionView, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();
const clock = () => TC_NOW;
type ObjectKey = keyof typeof TALENT_OBJECTS;

interface OperatorOptions {
  readonly objects?: readonly ObjectKey[];
  readonly hidden?: Partial<Record<ObjectKey, readonly string[]>>;
  readonly readonly?: Partial<Record<ObjectKey, readonly string[]>>;
  readonly seeAll?: boolean;
  /** 是否授予对象登记的全部按钮（缺省授予）。 */
  readonly buttons?: boolean;
}

describe('R3-T01 人才标准权限（真实授权器）', () => {
  let world: PermissionWorld;
  let data: Awaited<ReturnType<typeof seed>>;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seed();
  });

  /** 建数据用“全部允许”的授权钩子，操作人是租户管理员（创建人）。 */
  async function seed() {
    const setup = tenantApi(world.db, { clock });
    const create = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await setup.request('POST', `${TC_BASE}${path}`, { ...world.asAdmin, ifMatch: 0, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as T;
    };
    const library = await create<{ id: string; revision: number }>('/libraries', { name: '能力库', type: 'ability' });
    const dimension = await create<DimensionView>('/dimensions', {
      libraryId: library.id,
      code: `P${randomUUID().slice(0, 8)}`,
      name: '战略思维',
      definition: '保密定义',
      category: '通用',
      grades: [{ gradeOrder: 1, alias: '初级', description: '保密等级说明' }],
    });
    const category = await create<{ id: string }>('/criterion-categories', { name: '管理序列' });
    const criterion = await create<CriterionView>('/criteria', {
      categoryId: category.id,
      name: '总监标准',
      abilityNote: '能力说明',
      dimensions: [{ dimensionId: dimension.id, weight: 50, target: 3 }],
    });
    return { setup, library, dimension, category, criterion };
  }

  async function operator(options: OperatorOptions = {}) {
    const profile: ProfileBody = await createProfile(world, `tc-${randomUUID().slice(0, 8)}`, { apps: [TALENT_APP] });
    const setPermissions = async (buttons: boolean) => {
      for (const key of options.objects ?? (Object.keys(TALENT_OBJECTS) as ObjectKey[])) {
        const definition = TALENT_OBJECTS[key];
        const hidden = new Set(options.hidden?.[key] ?? []);
        const locked = new Set(options.readonly?.[key] ?? []);
        const response = await setObjectPermission(
          world,
          profile,
          {
            dataOperations: { create: true, update: true, delete: true },
            fields: definition.fields.map((field) => ({
              fieldCode: field.code,
              view: !hidden.has(field.code),
              edit: !field.system && !hidden.has(field.code) && !locked.has(field.code),
            })),
            buttons: buttons
              ? definition.buttons.map((button) => ({ buttonCode: button.code, level: button.level }))
              : [],
          },
          definition.code,
        );
        expect(response.status, await response.clone().text()).toBe(200);
      }
    };
    await setPermissions(options.buttons ?? true);
    await makeGrantable(world, [profile.id]);
    const user = await addMember(world, `tc-operator-${randomUUID().slice(0, 4)}`);
    expect((await grant(world, user.id, profile.id)).status).toBe(201);
    const as = { user: user.id, tenant: world.tenant.id };
    let scopeRevision = 0;
    const setSeeAll = async (seeAll: boolean) => {
      const response = await world.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/${TALENT_APP}`,
        { ...world.asAdmin, ifMatch: scopeRevision, body: { targetKind: 'app', targetCode: '', seeAll } },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      scopeRevision = ((await response.json()) as { revision: number }).revision;
    };
    if (options.seeAll) await setSeeAll(true);
    const request = (method: string, path: string, extra: Parameters<typeof world.api.request>[2] = {}) =>
      world.api.request(method, `${TC_BASE}${path}`, { ...as, ...extra });
    return { profile, user, as, request, setSeeAll, setButtons: setPermissions };
  }

  const adminRead = async <T>(path: string): Promise<T> => {
    const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };

  it('数据范围默认空：列表为空、详情与写入 404，数据不变', async () => {
    const op = await operator();
    for (const path of ['/libraries', '/dimensions', '/criteria', '/criterion-categories', '/candidates/dimensions']) {
      const response = await op.request('GET', path);
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toMatchObject({ items: [], hasDataPermission: false });
    }
    expect((await op.request('GET', `/dimensions/${data.dimension.id}`)).status).toBe(404);
    expect((await op.request('GET', `/criteria/${data.criterion.id}`)).status).toBe(404);
    const before = await adminRead<DimensionView>(`/dimensions/${data.dimension.id}`);
    const patched = await op.request('PATCH', `/dimensions/${data.dimension.id}`, {
      ifMatch: before.revision,
      body: { name: '范围外改名' },
    });
    expect(patched.status).toBe(404);
    const removed = await op.request('DELETE', `/criteria/${data.criterion.id}`, { ifMatch: data.criterion.revision });
    expect(removed.status).toBe(404);
    expect(await adminRead(`/dimensions/${data.dimension.id}`)).toEqual(before);
    expect((await adminRead<CriterionView>(`/criteria/${data.criterion.id}`)).id).toBe(data.criterion.id);
    // 新建的对象自己也看不到（未配置“使用用户”维度），按范围外拒绝，不落库
    const categories = await adminRead('/criterion-categories');
    const created = await op.request('POST', '/criterion-categories', { ifMatch: 0, body: { name: '自建分类' } });
    expect(created.status).toBe(404);
    expect(await adminRead('/criterion-categories')).toEqual(categories);
  });

  it('看全部 + 字段权限：列表、详情、标准里嵌套的指标内容都裁剪隐藏字段', async () => {
    const op = await operator({
      seeAll: true,
      hidden: { dimension: ['definition', 'grades'], criterion: ['abilityNote'] },
    });
    const list = (await (await op.request('GET', '/dimensions')).json()) as { items: Record<string, unknown>[] };
    const listed = list.items.find((item) => item.id === data.dimension.id)!;
    expect(listed).toMatchObject({ name: '战略思维', category: '通用' });
    expect(listed).not.toHaveProperty('definition');
    expect(listed).not.toHaveProperty('grades');

    const detail = (await (await op.request('GET', `/dimensions/${data.dimension.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(detail).toMatchObject({ name: '战略思维', code: data.dimension.code });
    expect(detail).not.toHaveProperty('definition');
    expect(JSON.stringify(detail)).not.toContain('保密');

    const criterion = (await (await op.request('GET', `/criteria/${data.criterion.id}`)).json()) as CriterionView;
    expect(criterion).toMatchObject({ name: '总监标准' });
    expect(criterion).not.toHaveProperty('abilityNote');
    expect(criterion.dimensions[0]).toMatchObject({ dimensionId: data.dimension.id, weight: 50, target: 3 });
    expect(criterion.dimensions[0]!.dimension).toMatchObject({ name: '战略思维' });
    expect(criterion.dimensions[0]!.dimension).not.toHaveProperty('definition');
    expect(JSON.stringify(criterion)).not.toContain('保密');
    expect(JSON.stringify(criterion)).not.toContain('能力说明');

    const candidates = (await (await op.request('GET', '/candidates/dimensions')).json()) as {
      items: Record<string, unknown>[];
    };
    const candidate = candidates.items.find((item) => item.id === data.dimension.id)!;
    expect(candidate).toMatchObject({ name: '战略思维' });
    expect(candidate).not.toHaveProperty('definition');
  });

  it('没有指标对象权限：标准详情只保留引用与权重，不带指标内容', async () => {
    const op = await operator({ seeAll: true, objects: ['criterion', 'criterionCategory'] });
    const response = await op.request('GET', `/criteria/${data.criterion.id}`);
    expect(response.status).toBe(200);
    const criterion = (await response.json()) as CriterionView;
    expect(criterion.dimensions[0]).toMatchObject({ dimensionId: data.dimension.id, weight: 50, target: 3 });
    expect(criterion.dimensions[0]).not.toHaveProperty('dimension');
    expect(JSON.stringify(criterion)).not.toContain('战略思维');
    expect((await op.request('GET', `/dimensions/${data.dimension.id}`)).status).toBe(403);
  });

  it('字段不可编辑：修改与显式清空都 403，数据不变', async () => {
    const op = await operator({ seeAll: true, readonly: { dimension: ['definition', 'grades'] } });
    const before = await adminRead<DimensionView>(`/dimensions/${data.dimension.id}`);
    for (const body of [{ definition: '改定义' }, { definition: null }, { grades: [] }]) {
      const response = await op.request('PATCH', `/dimensions/${data.dimension.id}`, {
        ifMatch: before.revision,
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(`/dimensions/${data.dimension.id}`)).toEqual(before);
    const allowed = await op.request('PATCH', `/dimensions/${data.dimension.id}`, {
      ifMatch: before.revision,
      body: { category: '领导力' },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  it('撤销看全部后，原命令按原 ID 重放返回 404', async () => {
    const op = await operator({ seeAll: true });
    const command = {
      ifMatch: 0,
      idempotencyKey: `tc-replay-${randomUUID().slice(0, 8)}`,
      body: { name: '重放分类' },
    };
    const first = await op.request('POST', '/criterion-categories', command);
    expect(first.status, await first.clone().text()).toBe(201);
    await op.setSeeAll(false);
    const replay = await op.request('POST', '/criterion-categories', command);
    expect(replay.status).toBe(404);
  });

  it('按钮权限（REQ-PRM-001 R6）：有数据操作权、字段权与看全部但没有按钮，四对象新增 / 修改 / 删除都 403，数据不变', async () => {
    const op = await operator({ seeAll: true, buttons: false });
    const snapshot = async () =>
      Promise.all(
        [
          '/libraries',
          '/dimensions',
          '/criterion-categories',
          '/criteria',
          `/libraries/${data.library.id}`,
          `/dimensions/${data.dimension.id}`,
          `/criterion-categories/${data.category.id}`,
          `/criteria/${data.criterion.id}`,
        ].map((path) => adminRead(path)),
      );
    const before = await snapshot();
    const targets = [
      ['libraries', data.library.id, { name: '无按钮新建库', type: 'ability' }, { name: '无按钮改名' }],
      [
        'dimensions',
        data.dimension.id,
        { libraryId: data.library.id, code: `NB${randomUUID().slice(0, 6)}`, name: '无按钮指标' },
        { name: '无按钮改名' },
      ],
      ['criterion-categories', data.category.id, { name: '无按钮分类' }, { name: '无按钮改名' }],
      ['criteria', data.criterion.id, { categoryId: data.category.id, name: '无按钮标准' }, { name: '无按钮改名' }],
    ] as const;
    for (const [path, id, created, patch] of targets) {
      const current = await adminRead<{ revision: number }>(`/${path}/${id}`);
      const posted = await op.request('POST', `/${path}`, { ifMatch: 0, body: created });
      expect(posted.status, `POST ${path}`).toBe(403);
      const patched = await op.request('PATCH', `/${path}/${id}`, { ifMatch: current.revision, body: patch });
      expect(patched.status, `PATCH ${path}`).toBe(403);
      const removed = await op.request('DELETE', `/${path}/${id}`, { ifMatch: current.revision });
      expect(removed.status, `DELETE ${path}`).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('首次成功后撤掉按钮，原命令按原 ID 重放 403，不再返回首次结果', async () => {
    const op = await operator({ seeAll: true });
    const categories = await adminRead<{ items: unknown[] }>('/criterion-categories');
    const command = {
      ifMatch: 0,
      idempotencyKey: `tc-button-replay-${randomUUID().slice(0, 8)}`,
      body: { name: '按钮重放分类' },
    };
    const first = await op.request('POST', '/criterion-categories', command);
    expect(first.status, await first.clone().text()).toBe(201);
    const created = (await first.json()) as { id: string; revision: number };
    await op.setButtons(false);
    const replay = await op.request('POST', '/criterion-categories', command);
    expect(replay.status).toBe(403);
    const after = await adminRead<{ items: { id: string }[] }>('/criterion-categories');
    expect(after.items).toHaveLength(categories.items.length + 1);
    expect(await adminRead(`/criterion-categories/${created.id}`)).toMatchObject({ revision: 1 });
  });

  it('应用边界：只带组织员工应用的身份不能配置人才标准对象', async () => {
    const profile = await createProfile(world, `tc-core-${randomUUID().slice(0, 6)}`, { apps: ['TenantBase'] });
    const definition = TALENT_OBJECTS.dimension;
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: true, update: true, delete: true },
        fields: definition.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
        buttons: [],
      },
      definition.code,
    );
    expect(response.status).toBe(400);
  });
});

describe('R3-T01 “使用用户”维度：只看到、只能引用自己创建的对象', () => {
  it('创建人范围：列表与详情只含本人创建的对象；引用他人创建的指标按不存在处理', async () => {
    const w = await talentWorld(testDb().db, 'tccreator');
    const other = await addMemberTo(w);
    const mine = await w.library('ability', { name: '我的库' });
    const mineDimension = await w.dimension(mine.id, { name: '我的指标' });
    const theirsResponse = await w.request(
      'POST',
      '/libraries',
      { ifMatch: 0, body: { name: '他人的库', type: 'ability' } },
      other,
    );
    expect(theirsResponse.status).toBe(201);
    const theirs = (await theirsResponse.json()) as { id: string };
    const theirDimensionResponse = await w.request(
      'POST',
      '/dimensions',
      { ifMatch: 0, body: { libraryId: theirs.id, code: 'THEIRS', name: '他人的指标' } },
      other,
    );
    expect(theirDimensionResponse.status).toBe(201);
    const theirDimension = (await theirDimensionResponse.json()) as { id: string };

    const authorize: Authorizer = (request) => request.action !== 'data.scope.all';
    const allFields = new Set(Object.values(TALENT_OBJECTS).flatMap((o) => o.fields.map((field) => field.code)));
    registerScopeProvider(authorize, {
      scope: async (query) => ({
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        terms: [{ dimension: 'using_user', creatorId: query.userId, orgIds: [], personIds: [] }],
      }),
      authorize: async (request) => Boolean(await authorize(request)),
      fields: async () => allFields,
    });
    const api = tenantApi(testDb().db, { authorize, clock });
    const call = (method: string, path: string, extra: Parameters<typeof api.request>[2] = {}) =>
      api.request(method, `${TC_BASE}${path}`, { ...w.as, ...extra });
    const list = await call('GET', '/libraries');
    const items = ((await list.json()) as { items: { id: string; name: string }[] }).items;
    expect(items.map((item) => item.id)).toEqual([mine.id]);
    expect(items[0]!.name).toBe('我的库');
    expect((await call('GET', `/libraries/${theirs.id}`)).status).toBe(404);
    expect((await call('GET', `/libraries/${mine.id}`)).status).toBe(200);
    const candidates = (await (await call('GET', '/candidates/dimensions')).json()) as { items: { id: string }[] };
    expect(candidates.items.map((item) => item.id)).toEqual([mineDimension.id]);

    const category = await call('POST', '/criterion-categories', { ifMatch: 0, body: { name: '自建分类' } });
    expect(category.status, await category.clone().text()).toBe(201);
    const { id: categoryId } = (await category.json()) as { id: string };
    const before = (await (await call('GET', '/criteria')).json()) as unknown;
    const denied = await call('POST', '/criteria', {
      ifMatch: 0,
      body: { categoryId, name: '引用他人指标', dimensions: [{ dimensionId: theirDimension.id, weight: 10 }] },
    });
    expect(denied.status).toBe(404);
    expect(await (await call('GET', '/criteria')).json()).toEqual(before);
    const accepted = await call('POST', '/criteria', {
      ifMatch: 0,
      body: { categoryId, name: '引用自己指标', dimensions: [{ dimensionId: mineDimension.id, weight: 10 }] },
    });
    expect(accepted.status, await accepted.clone().text()).toBe(201);
  });
});

async function addMemberTo(w: Awaited<ReturnType<typeof talentWorld>>) {
  const { createUser, grantMembership } = await import('@italent/db');
  const { cmd } = await import('./support/tenant-api.js');
  const user = await createUser(
    testDb().db,
    { email: `tc-other-${randomUUID().slice(0, 6)}@example.com`, displayName: '另一成员' },
    cmd(),
  );
  await grantMembership(testDb().db, { tenantId: w.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
  return { user: user.id, tenant: w.tenant.id };
}
