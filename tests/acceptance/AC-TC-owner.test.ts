/**
 * DEC-294③ 及补充（`23` §8 ①，第 5 轮清单 3）：指标库、指标、人才标准、标准内指标关联（以及标准分类）的所属人 /
 * 所属管理单元由系统填写——所属人 = 创建人，所属管理单元 = 创建人在人才标准应用里的授权管理单元（复刻以组织表达，
 * DEC-281⑨；用户 × TalentCenter 只有一份范围，DEC-043，管理单元里的每个组织范围即一个可选的授权管理单元）：
 * - 只有一个：自动填写，表单不显示；
 * - 没有：拒绝新建，提示“无可用的管理单元，请联系管理员授权”；
 * - 多个：新建表单显示下拉、必须选一个；服务端校验选中的值属于创建人的授权管理单元（不属于时，存在与否同一个 404）。
 * 编辑不提供修改与转移；请求里带 ownerId 一律 400（严格结构），ownerOrgId 只在新建时作为“所选的授权管理单元”。
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedPermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { clock, seedTalentData, talentOperator } from './AC-TC-permission-support.js';
import {
  createMou,
  createOrg,
  type CriterionView,
  type DimensionView,
  type LibraryView,
  NO_UNIT_MESSAGE,
  talentWorld,
  type TalentWorld,
} from './AC-TC-support.js';

const testDb = useTestDb();

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react') as { createElement: (component: unknown, props: unknown) => unknown };
const { renderToStaticMarkup } = webRequire('react-dom/server') as {
  renderToStaticMarkup: (element: unknown) => string;
};

async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;
}

/** 当前所有人才标准对象（新建被拒时比对用）。 */
async function snapshot(w: TalentWorld) {
  return Promise.all(
    ['/libraries', '/dimension-categories', '/dimensions', '/criterion-categories', '/criteria'].map((path) =>
      w.read(path),
    ),
  );
}

describe('DEC-294③ 所属人 / 所属管理单元由系统填写', () => {
  it('只有一个授权管理单元：四类对象与关联记录自动填写所属人 = 创建人、所属管理单元 = 该单元', async () => {
    const w = await talentWorld(testDb().db, 'tcown1');
    const library = await w.library('ability');
    expect(library).toMatchObject({ ownerId: w.as.user, ownerOrgId: w.orgId });
    const dimension = await w.dimension(library.id);
    expect(dimension).toMatchObject({ ownerId: w.as.user, ownerOrgId: w.orgId });
    const category = await w.category();
    expect(category).toMatchObject({ ownerId: w.as.user, ownerOrgId: w.orgId });
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id }]);
    expect(criterion).toMatchObject({ ownerId: w.as.user, ownerOrgId: w.orgId });
    expect(criterion.dimensions[0]).toMatchObject({ ownerId: w.as.user, ownerOrgId: w.orgId });

    const options = (await w.read<{ items: { id: string }[] }>('/candidates/owner-orgs?object=dimension')).items;
    expect(options.map((item) => item.id)).toEqual([w.orgId]);
  });

  it('请求里带 ownerId 一律 400；编辑时不能改所属人与所属管理单元（400），数据不变', async () => {
    const w = await talentWorld(testDb().db, 'tcownin');
    const before = await snapshot(w);
    const bodies = [
      ['/libraries', { name: '带所属人', type: 'ability', ownerId: w.as.user }],
      ['/criterion-categories', { name: '带所属人', ownerId: w.as.user }],
    ] as const;
    for (const [path, body] of bodies) {
      const response = await w.request('POST', path, { ifMatch: 0, body });
      expect(response.status, path).toBe(400);
    }
    expect(await snapshot(w)).toEqual(before);

    const library = await w.library('ability');
    for (const body of [{ ownerId: w.as.user }, { ownerOrgId: w.orgId }]) {
      const response = await w.request('PATCH', `/libraries/${library.id}`, { ifMatch: library.revision, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await w.read(`/libraries/${library.id}`)).toEqual(library);
  });

  it('没有授权管理单元：四类对象（含标准分类）与新的指标关联都拒绝新建，提示原文，数据不变', async () => {
    const w = await talentWorld(testDb().db, 'tcown0');
    const library = await w.library('ability');
    const dimension = await w.dimension(library.id);
    const category = await w.category();
    const criterion = await w.criterion(category.id, []);
    await w.setUnits(null);
    expect((await w.read<{ items: unknown[] }>('/candidates/owner-orgs?object=library')).items).toEqual([]);

    const before = await snapshot(w);
    const posts = [
      ['/libraries', { name: '无单元库', type: 'ability' }],
      ['/dimensions', { libraryId: library.id, code: `N${randomUUID().slice(0, 6)}`, name: '无单元指标' }],
      ['/criterion-categories', { name: '无单元分类' }],
      ['/criteria', { categoryId: category.id, name: '无单元标准' }],
    ] as const;
    for (const [path, body] of posts) {
      const response = await w.request('POST', path, { ifMatch: 0, body });
      expect(response.status, path).toBe(403);
      const error = await errorOf(response);
      expect(error.message, path).toBe(NO_UNIT_MESSAGE);
      expect(error.details?.reason, path).toBe('NO_MANAGEMENT_UNIT');
    }
    // 在已有标准里新加指标关联同样是新建记录
    const appended = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: { dimensions: [{ dimensionId: dimension.id }] },
    });
    expect(appended.status).toBe(403);
    expect((await errorOf(appended)).message).toBe(NO_UNIT_MESSAGE);
    expect(await snapshot(w)).toEqual(before);
    // 改已有记录不受影响
    const renamed = await w.request('PATCH', `/libraries/${library.id}`, {
      ifMatch: library.revision,
      body: { name: '改名' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
  });

  it('多个授权管理单元：不选 400；选了不属于自己的（存在或不存在）同一个 404；选中的照填', async () => {
    const w = await talentWorld(testDb().db, 'tcown2');
    const second = await createOrg(w.api, w.as, 'tcown2第二单元');
    const stranger = await createOrg(w.api, w.as, 'tcown2未授权组织');
    await w.setUnits([w.orgId, second]);
    const options = (await w.read<{ items: { id: string }[] }>('/candidates/owner-orgs?object=library')).items;
    expect(options.map((item) => item.id).sort()).toEqual([w.orgId, second].sort());

    const before = await snapshot(w);
    const missing = await w.request('POST', '/libraries', { ifMatch: 0, body: { name: '未选单元', type: 'ability' } });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).details?.reason).toBe('MANAGEMENT_UNIT_REQUIRED');

    const outside = await w.request('POST', '/libraries', {
      ifMatch: 0,
      body: { name: '选了别人的单元', type: 'ability', ownerOrgId: stranger },
    });
    const ghost = await w.request('POST', '/libraries', {
      ifMatch: 0,
      body: { name: '选了别人的单元', type: 'ability', ownerOrgId: randomUUID() },
    });
    expect(outside.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(await outside.json()).toEqual(await ghost.json());
    expect(await snapshot(w)).toEqual(before);

    const library = await w.library('ability', { ownerOrgId: second });
    expect(library).toMatchObject({ ownerId: w.as.user, ownerOrgId: second });
    const dimension = await w.dimension(library.id, { ownerOrgId: w.orgId });
    expect(dimension).toMatchObject({ ownerOrgId: w.orgId });
    const category = await w.category('多单元分类', { ownerOrgId: second });
    const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id }], { ownerOrgId: second });
    // 关联记录随所在标准选中的授权管理单元
    expect(criterion.dimensions[0]).toMatchObject({ ownerId: w.as.user, ownerOrgId: second });
  });
});

describe('DEC-294③ 表单：所属管理单元只在“多个”时出现', () => {
  async function render(props: Record<string, unknown>) {
    const path = '../../apps/web/src/talent/OwnerOrgSelect.js';
    const { OwnerUnitField } = await import(path);
    return renderToStaticMarkup(createElement(OwnerUnitField, { value: '', onChange: () => {}, ...props }));
  }
  const unit = (id: string) => ({ id, code: id, name: `单元${id}` });

  it('一个：不显示；没有：提示原文；多个：显示必选下拉；编辑：一律不显示', async () => {
    expect(await render({ editing: false, options: [unit('a')] })).toBe('');
    expect(await render({ editing: false, options: [] })).toContain(NO_UNIT_MESSAGE);
    const many = await render({ editing: false, options: [unit('a'), unit('b')] });
    expect(many).toMatch(/<select[^>]*required/);
    expect(many).toContain('单元a');
    expect(many).toContain('单元b');
    for (const options of [[], [unit('a')], [unit('a'), unit('b')]]) {
      expect(await render({ editing: true, options })).toBe('');
    }
  });
});

describe('DEC-294③ 范围外仍拒绝：新建对象的所属管理单元必须在创建人的授权管理单元内', () => {
  it('看全部的成员也只能填自己的授权管理单元', async () => {
    const w = await talentWorld(testDb().db, 'tcownall');
    const other = await createOrg(w.api, w.as, 'tcownall其他组织');
    const before = await snapshot(w);
    const response = await w.request('POST', '/criterion-categories', {
      ifMatch: 0,
      body: { name: '填别人的单元', ownerOrgId: other },
    });
    expect(response.status).toBe(404);
    expect(await snapshot(w)).toEqual(before);
    const own = await w.request('POST', '/criterion-categories', {
      ifMatch: 0,
      body: { name: '填自己的单元', ownerOrgId: w.orgId },
    });
    expect(own.status, await own.clone().text()).toBe(201);
  });

  it('指标的所属管理单元取创建人自己的（不随所属指标库）', async () => {
    const w = await talentWorld(testDb().db, 'tcowndim');
    const second = await createOrg(w.api, w.as, 'tcowndim第二单元');
    await w.setUnits([second]);
    const library = await w.library('ability');
    await w.setUnits([w.orgId]);
    const dimension: DimensionView = await w.dimension(library.id);
    expect(library.ownerOrgId).toBe(second);
    expect(dimension.ownerOrgId).toBe(w.orgId);
    const criterion: CriterionView = await w.criterion((await w.category()).id, []);
    expect(criterion.ownerOrgId).toBe(w.orgId);
    const reread: LibraryView = await w.read(`/libraries/${library.id}`);
    expect(reread.ownerOrgId).toBe(second);
  });
});

describe('DEC-294 补充二：新增的关联记录跟添加人走（所属人 = 添加人，管理单元按添加人的授权管理单元）', () => {
  it('库内分类：管理单元取创建人的授权管理单元，不随所属指标库；多个时不选 400、选别人的 404、选中的照填', async () => {
    const w = await talentWorld(testDb().db, 'tcowncat');
    const second = await createOrg(w.api, w.as, 'tcowncat第二单元');
    const stranger = await createOrg(w.api, w.as, 'tcowncat未授权组织');
    await w.setUnits([second]);
    const library = await w.library('ability');
    await w.setUnits([w.orgId]);
    const category = await w.dimensionCategory(library.id);
    expect(library.ownerOrgId).toBe(second);
    expect(category).toMatchObject({ ownerId: w.as.user, ownerOrgId: w.orgId });

    await w.setUnits([w.orgId, second]);
    const options = (await w.read<{ items: { id: string }[] }>('/candidates/owner-orgs?object=dimensionCategory'))
      .items;
    expect(options.map((item) => item.id).sort()).toEqual([w.orgId, second].sort());
    const before = await snapshot(w);
    const body = { libraryId: library.id, name: '多单元分类', displayOrder: 2 };
    const missing = await w.request('POST', '/dimension-categories', { ifMatch: 0, body });
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).details?.reason).toBe('MANAGEMENT_UNIT_REQUIRED');
    const outside = await w.request('POST', '/dimension-categories', {
      ifMatch: 0,
      body: { ...body, ownerOrgId: stranger },
    });
    const ghost = await w.request('POST', '/dimension-categories', {
      ifMatch: 0,
      body: { ...body, ownerOrgId: randomUUID() },
    });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual(await ghost.json());
    expect(await snapshot(w)).toEqual(before);
    const chosen = await w.dimensionCategory(library.id, { ...body, ownerOrgId: second });
    expect(chosen).toMatchObject({ ownerId: w.as.user, ownerOrgId: second });
  });

  it('标准内指标关联：多个授权管理单元时编辑新加关联须选一个，不再取标准的单元；一个时自动填写', async () => {
    const w = await talentWorld(testDb().db, 'tcownrel');
    const second = await createOrg(w.api, w.as, 'tcownrel第二单元');
    const stranger = await createOrg(w.api, w.as, 'tcownrel未授权组织');
    await w.setUnits([w.orgId, second]);
    const library = await w.library('ability', { ownerOrgId: w.orgId });
    const [d1, d2, d3] = [
      await w.dimension(library.id, { ownerOrgId: w.orgId }),
      await w.dimension(library.id, { ownerOrgId: w.orgId }),
      await w.dimension(library.id, { ownerOrgId: w.orgId }),
    ];
    const category = await w.category('关联单元分类', { ownerOrgId: w.orgId });
    const criterion = await w.criterion(category.id, [{ dimensionId: d1!.id }], { ownerOrgId: w.orgId });
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const add = (extra: Record<string, unknown>) =>
      w.request('PATCH', `/criteria/${criterion.id}`, {
        ifMatch: before.revision,
        body: { dimensions: [{ dimensionId: d1!.id }, { dimensionId: d2!.id }], ...extra },
      });

    const missing = await add({});
    expect(missing.status).toBe(400);
    expect((await errorOf(missing)).details?.reason).toBe('MANAGEMENT_UNIT_REQUIRED');
    const outside = await add({ relationOwnerOrgId: stranger });
    const ghost = await add({ relationOwnerOrgId: randomUUID() });
    expect(outside.status).toBe(404);
    expect(await outside.json()).toEqual(await ghost.json());
    expect(await w.read(`/criteria/${criterion.id}`)).toEqual(before);

    const chosen = await add({ relationOwnerOrgId: second });
    expect(chosen.status, await chosen.clone().text()).toBe(200);
    const after = (await chosen.json()) as CriterionView;
    const row = (id: string) => after.dimensions.find((item) => item.dimensionId === id);
    expect(row(d2!.id)).toMatchObject({ ownerId: w.as.user, ownerOrgId: second });
    expect(row(d1!.id)).toMatchObject({ ownerOrgId: w.orgId });
    expect(after.ownerOrgId).toBe(w.orgId);

    // 只调整已有行（没有新加的关联）不要求选择
    const reordered = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: after.revision,
      body: { dimensions: [{ dimensionId: d2!.id }, { dimensionId: d1!.id }] },
    });
    expect(reordered.status, await reordered.clone().text()).toBe(200);
    // 只剩一个授权管理单元：自动填写
    await w.setUnits([second]);
    const single = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: ((await reordered.json()) as CriterionView).revision,
      body: { dimensions: [{ dimensionId: d2!.id }, { dimensionId: d1!.id }, { dimensionId: d3!.id }] },
    });
    expect(single.status, await single.clone().text()).toBe(200);
    const last = ((await single.json()) as CriterionView).dimensions.find((item) => item.dimensionId === d3!.id);
    expect(last).toMatchObject({ ownerId: w.as.user, ownerOrgId: second });
  });

  it('添加人与标准创建人不同、管理单元也不同：新关联记录的所属人与管理单元都跟添加人，已有行与标准不变', async () => {
    const db = testDb().db;
    let world = await seedPermissionWorld(db);
    world = { ...world, api: tenantApi(db, { authorize: undefined, clock }) };
    const data = await seedTalentData(world);
    const outsideMou = await createMou(data.setup, world.asAdmin, [data.outside.orgId], '只含外');
    const op = await talentOperator(world, { seeAll: true, mouId: outsideMou });
    const criterion = data.inside.criterion;
    const response = await op.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: { dimensions: [{ dimensionId: data.inside.dimension.id }, { dimensionId: data.outside.dimension.id }] },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const after = (await response.json()) as CriterionView;
    const row = (id: string) => after.dimensions.find((item) => item.dimensionId === id);
    expect(row(data.outside.dimension.id)).toMatchObject({ ownerId: op.user.id, ownerOrgId: data.outside.orgId });
    expect(row(data.inside.dimension.id)).toMatchObject({ ownerId: world.asAdmin.user, ownerOrgId: data.inside.orgId });
    expect(after).toMatchObject({ ownerId: world.asAdmin.user, ownerOrgId: data.inside.orgId });
  });

  it('真实授权器：多个授权管理单元的操作人选所属管理单元不按字段编辑权拦截（系统填写的字段也能选）', async () => {
    const db = testDb().db;
    let world = await seedPermissionWorld(db);
    world = { ...world, api: tenantApi(db, { authorize: undefined, clock }) };
    const data = await seedTalentData(world);
    const op = await talentOperator(world, { mouId: data.bothMouId });
    const created = async (path: string, body: Record<string, unknown>) => {
      const response = await op.request('POST', path, {
        ifMatch: 0,
        body: { ...body, ownerOrgId: data.outside.orgId },
      });
      expect(response.status, `${path} ${await response.clone().text()}`).toBe(201);
      return (await response.json()) as { ownerOrgId: string; ownerId: string };
    };
    const dimension = await created('/dimensions', {
      libraryId: data.inside.library.id,
      code: `R${randomUUID().slice(0, 6)}`,
      name: '多单元操作人的指标',
    });
    expect(dimension).toMatchObject({ ownerId: op.user.id, ownerOrgId: data.outside.orgId });
    const category = await created('/dimension-categories', {
      libraryId: data.inside.library.id,
      name: '多单元操作人的分类',
      displayOrder: 9,
    });
    expect(category).toMatchObject({ ownerId: op.user.id, ownerOrgId: data.outside.orgId });
    const criterion = data.inside.criterion;
    const added = await op.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: {
        dimensions: [{ dimensionId: data.inside.dimension.id }, { dimensionId: data.outside.dimension.id }],
        relationOwnerOrgId: data.outside.orgId,
      },
    });
    expect(added.status, await added.clone().text()).toBe(200);
  });
});

describe('DEC-294 补充二 表单：编辑标准时新加指标、且有多个授权管理单元才显示“新加指标的所属管理单元”', () => {
  const unit = (id: string) => ({ id, code: id, name: `单元${id}` });
  async function render(dimensionIds: string[], owners: unknown[]) {
    const path = '../../apps/web/src/talent/CriterionForm.js';
    const { CriterionForm } = await import(path);
    return renderToStaticMarkup(
      createElement(CriterionForm, {
        value: {
          relationOwnerOrgId: '',
          categoryId: '',
          name: '标准',
          enabled: true,
          abilityNote: null,
          potentialNote: null,
          experienceNote: null,
          achievementNote: null,
          dimensions: dimensionIds.map((dimensionId, index) => ({ dimensionId, displayOrder: index + 1 })),
        },
        existing: new Set(['a']),
        owners,
        categories: [],
        known: new Map(),
        candidates: [],
        busy: false,
        onChange: () => {},
        onSubmit: () => {},
        onCancel: () => {},
      }),
    );
  }

  it('有新加的行 + 多个单元：显示必选下拉；没有新加的行或只有一个单元：不显示', async () => {
    const label = '新加指标的所属管理单元';
    const many = await render(['a', 'b'], [unit('x'), unit('y')]);
    expect(many).toContain(label);
    expect(many).toMatch(/<select[^>]*required/);
    expect(await render(['a'], [unit('x'), unit('y')])).not.toContain(label);
    expect(await render(['a', 'b'], [unit('x')])).not.toContain(label);
  });

  it('看不到组织名称时（DEC-309 只返回 ID），下拉以 ID 显示', async () => {
    const path = '../../apps/web/src/talent/OwnerOrgSelect.js';
    const { OwnerUnitField } = await import(path);
    const markup = renderToStaticMarkup(
      createElement(OwnerUnitField, {
        editing: false,
        value: '',
        onChange: () => {},
        options: [{ id: 'x1' }, { id: 'y1' }],
      }),
    );
    expect(markup).toContain('x1');
    expect(markup).not.toContain('undefined');
  });
});
