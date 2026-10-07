/**
 * R3-T01 权限接入（真实授权器；AGENTS §2 / §10，DEC-080 / DEC-281⑨）：
 * - 人才标准是独立应用 TalentCenter（`16` §52：独立菜单组、独立配置应用、独立身份），对象权限只能挂在带该应用的身份上；
 * - 功能权限：数据操作权 + 按钮权（REQ-PRM-001 R6），首次执行与幂等重放都校验；
 * - 响应每一层（列表、详情、标准里嵌套的指标内容、候选）都按字段权限裁剪，嵌套指标另按指标对象的查看权与范围；
 * - 写入（含显式清空）逐字段校验编辑权；撤权后原命令重放也拒绝。
 * 管理单元范围的负例见 AC-TC-mou.test.ts。负向用例断言具体响应码，并前后各读一次比对。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import type { Authorizer } from '@italent/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { createProfile, seedPermissionWorld, setObjectPermission, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { clock, seedTalentData, talentOperator, type TalentPermissionData } from './AC-TC-permission-support.js';
import { TC_BASE, type CriterionView, type DimensionView, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();

describe('R3-T01 人才标准权限（真实授权器）', () => {
  let world: PermissionWorld;
  let data: TalentPermissionData;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seedTalentData(world);
  });

  const adminRead = async <T>(path: string): Promise<T> => {
    const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };

  it('看全部 + 字段权限：列表、详情、标准里嵌套的指标内容都裁剪隐藏字段', async () => {
    const op = await talentOperator(world, {
      seeAll: true,
      hidden: { dimension: ['definition', 'grades', 'suggestions'], criterion: ['abilityNote'] },
    });
    const { dimension, criterion } = data.inside;
    const list = (await (await op.request('GET', '/dimensions')).json()) as { items: Record<string, unknown>[] };
    const listed = list.items.find((item) => item.id === dimension.id)!;
    expect(listed).toMatchObject({ name: '内战略思维', categoryName: '内通用' });
    expect(listed).not.toHaveProperty('definition');
    expect(listed).not.toHaveProperty('grades');

    const detail = (await (await op.request('GET', `/dimensions/${dimension.id}`)).json()) as Record<string, unknown>;
    expect(detail).toMatchObject({ name: '内战略思维', code: dimension.code });
    expect(detail).not.toHaveProperty('definition');
    expect(JSON.stringify(detail)).not.toContain('保密');

    const view = (await (await op.request('GET', `/criteria/${criterion.id}`)).json()) as CriterionView;
    expect(view).toMatchObject({ name: '内总监标准' });
    expect(view).not.toHaveProperty('abilityNote');
    expect(view.dimensions[0]).toMatchObject({ dimensionId: dimension.id, weight: 50, target: 3 });
    expect(view.dimensions[0]!.dimension).toEqual({ name: '内战略思维', categoryName: '内通用' });
    expect(JSON.stringify(view)).not.toContain('保密');
    expect(JSON.stringify(view)).not.toContain('能力说明');

    const candidates = (await (await op.request('GET', '/candidates/dimensions')).json()) as {
      items: Record<string, unknown>[];
    };
    const candidate = candidates.items.find((item) => item.id === dimension.id)!;
    expect(candidate).toMatchObject({ name: '内战略思维' });
    expect(candidate).not.toHaveProperty('definition');
  });

  it('没有指标对象权限：标准详情只保留引用与权重，不带指标内容；候选与类型下拉都 403', async () => {
    const op = await talentOperator(world, { seeAll: true, objects: ['criterion', 'criterionCategory'] });
    const response = await op.request('GET', `/criteria/${data.inside.criterion.id}`);
    expect(response.status).toBe(200);
    const criterion = (await response.json()) as CriterionView;
    expect(criterion.dimensions[0]).toMatchObject({ dimensionId: data.inside.dimension.id, weight: 50, target: 3 });
    expect(criterion.dimensions[0]).not.toHaveProperty('dimension');
    expect(JSON.stringify(criterion)).not.toContain('战略思维');
    expect((await op.request('GET', `/dimensions/${data.inside.dimension.id}`)).status).toBe(403);
    expect((await op.request('GET', '/candidates/dimensions')).status).toBe(403);
    expect((await op.request('GET', '/candidates/description-types')).status).toBe(403);
  });

  it('字段不可编辑：修改与显式清空都 403，数据不变', async () => {
    const op = await talentOperator(world, { seeAll: true, readonly: { dimension: ['definition', 'grades'] } });
    const path = `/dimensions/${data.inside.dimension.id}`;
    const before = await adminRead<DimensionView>(path);
    for (const body of [{ definition: '改定义' }, { definition: null }, { grades: [] }]) {
      const response = await op.request('PATCH', path, { ifMatch: before.revision, body });
      expect(response.status, JSON.stringify(body)).toBe(403);
    }
    expect(await adminRead(path)).toEqual(before);
    const allowed = await op.request('PATCH', path, { ifMatch: before.revision, body: { displayOrder: 7 } });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  it('撤销看全部后，原命令按原 ID 重放返回 404', async () => {
    const op = await talentOperator(world, { seeAll: true });
    const command = {
      ifMatch: 0,
      idempotencyKey: `tc-replay-${randomUUID().slice(0, 8)}`,
      body: { name: '重放分类', ownerOrgId: data.outside.orgId },
    };
    const first = await op.request('POST', '/criterion-categories', command);
    expect(first.status, await first.clone().text()).toBe(201);
    await op.setSeeAll(false);
    const replay = await op.request('POST', '/criterion-categories', command);
    expect(replay.status).toBe(404);
  });

  it('按钮权限（REQ-PRM-001 R6）：有数据操作权、字段权与看全部但没有按钮，六个对象新增 / 修改 / 删除都 403，数据不变', async () => {
    const op = await talentOperator(world, { seeAll: true, buttons: false });
    const { inside } = data;
    const reads = [
      '/libraries',
      '/dimension-categories',
      '/dimensions',
      '/description-types',
      '/criterion-categories',
      '/criteria',
      `/libraries/${inside.library.id}`,
      `/dimension-categories/${inside.dimensionCategory.id}`,
      `/dimensions/${inside.dimension.id}`,
      `/description-types/${data.type.id}`,
      `/criterion-categories/${inside.criterionCategory.id}`,
      `/criteria/${inside.criterion.id}`,
    ];
    const snapshot = () => Promise.all(reads.map((path) => adminRead(path)));
    const before = await snapshot();
    const targets = [
      ['libraries', inside.library.id, { name: '无按钮库', type: 'ability', ownerOrgId: inside.orgId }],
      [
        'dimension-categories',
        inside.dimensionCategory.id,
        { libraryId: inside.library.id, name: '无按钮', displayOrder: 1 },
      ],
      [
        'dimensions',
        inside.dimension.id,
        { libraryId: inside.library.id, code: `NB${randomUUID().slice(0, 6)}`, name: '无按钮' },
      ],
      ['description-types', data.type.id, { name: '无按钮类型' }],
      ['criterion-categories', inside.criterionCategory.id, { name: '无按钮分类', ownerOrgId: inside.orgId }],
      [
        'criteria',
        inside.criterion.id,
        { categoryId: inside.criterionCategory.id, name: '无按钮', ownerOrgId: inside.orgId },
      ],
    ] as const;
    expect(targets.map(([path]) => path)).toHaveLength(Object.keys(TALENT_OBJECTS).length);
    for (const [path, id, created] of targets) {
      const current = await adminRead<{ revision: number }>(`/${path}/${id}`);
      const posted = await op.request('POST', `/${path}`, { ifMatch: 0, body: created });
      expect(posted.status, `POST ${path}`).toBe(403);
      const patched = await op.request('PATCH', `/${path}/${id}`, {
        ifMatch: current.revision,
        body: { name: '改名' },
      });
      expect(patched.status, `PATCH ${path}`).toBe(403);
      const removed = await op.request('DELETE', `/${path}/${id}`, { ifMatch: current.revision });
      expect(removed.status, `DELETE ${path}`).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('首次成功后撤掉按钮，原命令按原 ID 重放 403，不再返回首次结果', async () => {
    const op = await talentOperator(world, { seeAll: true });
    const categories = await adminRead<{ items: unknown[] }>('/criterion-categories');
    const command = {
      ifMatch: 0,
      idempotencyKey: `tc-button-replay-${randomUUID().slice(0, 8)}`,
      body: { name: '按钮重放分类', ownerOrgId: data.inside.orgId },
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

  it('发展建议子表的增 / 改 / 删都走指标的修改入口：没有 suggestions 编辑权时整组 403', async () => {
    const op = await talentOperator(world, { seeAll: true, readonly: { dimension: ['suggestions'] } });
    const path = `/dimensions/${data.inside.dimension.id}`;
    const before = await adminRead<DimensionView>(path);
    const rows = [
      [...before.suggestions.map(({ typeId, description, displayOrder }) => ({ typeId, description, displayOrder }))],
      [],
      [{ typeId: data.type.id, description: '改过', displayOrder: 1 }],
    ];
    for (const suggestions of rows) {
      const response = await op.request('PATCH', path, { ifMatch: before.revision, body: { suggestions } });
      expect(response.status, JSON.stringify(suggestions)).toBe(403);
    }
    expect(await adminRead(path)).toEqual(before);
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

describe('R3-T01 配置了“使用用户”规则时：只看到、只能引用自己作为所属人的对象', () => {
  it('所属人范围：列表与详情只含本人的对象；引用他人的指标按不存在处理', async () => {
    const w = await talentWorld(testDb().db, 'tcowner');
    const other = await addMemberTo(w);
    const mine = await w.library('ability', { name: '我的库' });
    const mineDimension = await w.dimension(mine.id, { name: '我的指标' });
    const theirs = await w.created<{ id: string }>(
      '/libraries',
      { name: '他人的库', type: 'ability', ownerOrgId: w.orgId },
      other,
    );
    const theirDimension = await w.created<{ id: string }>(
      '/dimensions',
      { libraryId: theirs.id, code: 'THEIRS', name: '他人的指标' },
      other,
    );

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
    expect((await call('GET', `/libraries/${theirs.id}`)).status).toBe(404);
    expect((await call('GET', `/libraries/${mine.id}`)).status).toBe(200);
    const candidates = (await (await call('GET', '/candidates/dimensions')).json()) as { items: { id: string }[] };
    expect(candidates.items.map((item) => item.id)).toEqual([mineDimension.id]);

    const category = await call('POST', '/criterion-categories', {
      ifMatch: 0,
      body: { name: '自建分类', ownerOrgId: w.orgId },
    });
    expect(category.status, await category.clone().text()).toBe(201);
    const { id: categoryId } = (await category.json()) as { id: string };
    const before = (await (await call('GET', '/criteria')).json()) as unknown;
    const denied = await call('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId,
        name: '引用他人指标',
        ownerOrgId: w.orgId,
        dimensions: [{ dimensionId: theirDimension.id, weight: 10 }],
      },
    });
    expect(denied.status).toBe(404);
    expect(await (await call('GET', '/criteria')).json()).toEqual(before);
    const accepted = await call('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId,
        name: '引用自己指标',
        ownerOrgId: w.orgId,
        dimensions: [{ dimensionId: mineDimension.id, weight: 10 }],
      },
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
