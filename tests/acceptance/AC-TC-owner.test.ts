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
import {
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
