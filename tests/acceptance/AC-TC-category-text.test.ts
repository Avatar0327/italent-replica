/**
 * DEC-294⑤（`23` §8 ⑤，第 5 轮清单 4）：人才标准指标列表里的“指标类别”是关联记录（RelationTalentCriterionDimension）
 * 自己的文本字段 DimensionCategory：
 * - 选入指标时默认复制该指标的库内分类名称（没有分类为空）；之后可以按标准单独修改；
 * - 复制后与库内分类各自独立：库内分类改名不影响已复制的值（🟡 原站未写入实测，按 DEC-294 口径）；
 * - 「设置指标类别」批量入口：勾选标准里的指标后给它们统一填一个类别。批量入口同样校验数据操作权、按钮、
 *   标准的 dimensions 字段编辑权与数据范围，带 If-Match / 幂等键，并写审计（e0a68da）。
 */
import { randomUUID } from 'node:crypto';
import { TALENT_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditApi } from './AC-AUD-support.js';
import { seedPermissionWorld, type PermissionWorld } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { clock, seedTalentData, talentOperator, type TalentPermissionData } from './AC-TC-permission-support.js';
import { TC_BASE, TC_NOW, type CriterionView, talentWorld, type TalentWorld } from './AC-TC-support.js';

const testDb = useTestDb();
const BATCH = 'dimension-category';

async function reason(response: Response) {
  return ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
}

const categoryOf = (view: CriterionView, dimensionId: string) =>
  view.dimensions.find((row) => row.dimensionId === dimensionId)?.dimensionCategory;

async function setup(w: TalentWorld) {
  const library = await w.library('ability');
  const general = await w.dimensionCategory(library.id, { name: '通用能力' });
  const withCategory = await w.dimension(library.id, { categoryId: general.id });
  const plain = await w.dimension(library.id);
  const category = await w.category();
  const criterion = await w.criterion(category.id, [
    { dimensionId: withCategory.id, weight: 30, target: 2 },
    { dimensionId: plain.id },
  ]);
  return { library, general, withCategory, plain, category, criterion };
}

describe('DEC-294⑤ 关联记录上的“指标类别”', () => {
  it('选入时默认复制库内分类（没有分类为空），之后可按标准单独修改；未提交的行保持原值', async () => {
    const w = await talentWorld(testDb().db, 'tcdc');
    const { withCategory, plain, category, criterion } = await setup(w);
    expect(categoryOf(criterion, withCategory.id)).toBe('通用能力');
    expect(categoryOf(criterion, plain.id)).toBeNull();

    const edited = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: {
        dimensions: [{ dimensionId: withCategory.id, dimensionCategory: '核心能力' }, { dimensionId: plain.id }],
      },
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const after = (await edited.json()) as CriterionView;
    expect(categoryOf(after, withCategory.id)).toBe('核心能力');
    expect(categoryOf(after, plain.id)).toBeNull();
    // 权重、目标未提交仍保持（DEC-281②）
    expect(after.dimensions.find((row) => row.dimensionId === withCategory.id)).toMatchObject({
      weight: 30,
      target: 2,
    });

    const untouched = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: after.revision,
      body: { dimensions: [{ dimensionId: withCategory.id }, { dimensionId: plain.id }] },
    });
    expect(untouched.status).toBe(200);
    expect(categoryOf((await untouched.json()) as CriterionView, withCategory.id)).toBe('核心能力');

    // 新标准选入时可直接给类别；超过 50 字 400
    const own = await w.criterion(category.id, [{ dimensionId: plain.id, dimensionCategory: '自定类别' }], {
      name: '自定类别的标准',
    });
    expect(categoryOf(own, plain.id)).toBe('自定类别');
    const before = await w.read('/criteria');
    const tooLong = await w.request('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId: category.id,
        name: '超长',
        dimensions: [{ dimensionId: plain.id, dimensionCategory: '类'.repeat(51) }],
      },
    });
    expect(tooLong.status).toBe(400);
    expect(await w.read('/criteria')).toEqual(before);
  });

  it('复制后各自独立：库内分类改名不影响已复制的值，之后新选入的取改名后的名称', async () => {
    const w = await talentWorld(testDb().db, 'tcdcind');
    const { general, withCategory, category, criterion } = await setup(w);
    const renamed = await w.request('PATCH', `/dimension-categories/${general.id}`, {
      ifMatch: general.revision,
      body: { name: '通用素质' },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const current = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    expect(categoryOf(current, withCategory.id)).toBe('通用能力');
    expect(current.revision).toBe(criterion.revision);

    const later = await w.criterion(category.id, [{ dimensionId: withCategory.id }], { name: '改名后选入' });
    expect(categoryOf(later, withCategory.id)).toBe('通用素质');
    // 指标改选另一个分类同样不影响
    const other = await w.dimensionCategory(withCategory.libraryId, { name: '专业能力' });
    const moved = await w.request('PATCH', `/dimensions/${withCategory.id}`, {
      ifMatch: (await w.read<{ revision: number }>(`/dimensions/${withCategory.id}`)).revision,
      body: { categoryId: other.id },
    });
    expect(moved.status).toBe(200);
    expect(categoryOf(await w.read<CriterionView>(`/criteria/${later.id}`), withCategory.id)).toBe('通用素质');
  });

  it('「设置指标类别」批量入口：给勾选的指标统一填写；可清空；未勾选的不变；revision + 1 并写审计', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tcdcbatch');
    const audit = auditApi(db, TC_NOW.toISOString());
    const { withCategory, plain, criterion } = await setup(w);
    const third = await w.dimension(withCategory.libraryId);
    const edited = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterion.revision,
      body: {
        dimensions: [{ dimensionId: withCategory.id }, { dimensionId: plain.id }, { dimensionId: third.id }],
      },
    });
    const start = (await edited.json()) as CriterionView;

    const batch = await w.request('POST', `/criteria/${criterion.id}/${BATCH}`, {
      ifMatch: start.revision,
      idempotencyKey: `tc-dc-${randomUUID().slice(0, 8)}`,
      body: { dimensionIds: [withCategory.id, plain.id], dimensionCategory: '批量类别' },
    });
    expect(batch.status, await batch.clone().text()).toBe(200);
    const after = (await batch.json()) as CriterionView;
    expect(after.revision).toBe(start.revision + 1);
    expect(categoryOf(after, withCategory.id)).toBe('批量类别');
    expect(categoryOf(after, plain.id)).toBe('批量类别');
    expect(categoryOf(after, third.id)).toBeNull();
    const {
      dimensions: _a,
      revision: _r,
      updatedAt: _u,
      ...restAfter
    } = after as CriterionView & { updatedAt: string };
    const {
      dimensions: _b,
      revision: _s,
      updatedAt: _v,
      ...restStart
    } = start as CriterionView & { updatedAt: string };
    expect(restAfter).toEqual(restStart);
    expect(after.dimensions.map(({ dimensionCategory: _c, ...row }) => row)).toEqual(
      start.dimensions.map(({ dimensionCategory: _c, ...row }) => row),
    );

    const cleared = await w.request('POST', `/criteria/${criterion.id}/${BATCH}`, {
      ifMatch: after.revision,
      body: { dimensionIds: [plain.id], dimensionCategory: null },
    });
    expect(cleared.status).toBe(200);
    expect(categoryOf((await cleared.json()) as CriterionView, plain.id)).toBeNull();

    const { items } = await audit.dataChanges(w.as, { objectType: TALENT_OBJECTS.criterion.code, limit: '50' });
    const updates = items.filter((entry) => entry.objectId === criterion.id && entry.operation === 'update');
    expect(updates).toHaveLength(3);
    for (const entry of updates) expect(entry.changes.map((change) => change.field)).toEqual(['dimensions']);
  });

  it('批量入口的负例：未引用的指标、空列表、重复、超长、revision 不符一律拒绝，数据不变', async () => {
    const w = await talentWorld(testDb().db, 'tcdcneg');
    const { withCategory, plain, library, criterion } = await setup(w);
    const outsider = await w.dimension(library.id);
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const cases = [
      [{ dimensionIds: [outsider.id], dimensionCategory: '甲' }, 400, 'DIMENSION_NOT_REFERENCED'],
      [{ dimensionIds: [], dimensionCategory: '甲' }, 400, undefined],
      [{ dimensionIds: [plain.id, plain.id], dimensionCategory: '甲' }, 400, undefined],
      [{ dimensionIds: [plain.id], dimensionCategory: '类'.repeat(51) }, 400, undefined],
      [{ dimensionIds: [plain.id] }, 400, undefined],
      [{ dimensionIds: [plain.id], dimensionCategory: '甲', weight: 1 }, 400, undefined],
    ] as const;
    for (const [body, status, expected] of cases) {
      const response = await w.request('POST', `/criteria/${criterion.id}/${BATCH}`, {
        ifMatch: before.revision,
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(status);
      if (expected) expect(await reason(response)).toBe(expected);
    }
    const stale = await w.request('POST', `/criteria/${criterion.id}/${BATCH}`, {
      ifMatch: before.revision + 5,
      body: { dimensionIds: [withCategory.id], dimensionCategory: '甲' },
    });
    expect(stale.status).toBe(409);
    expect(await w.read(`/criteria/${criterion.id}`)).toEqual(before);
  });
});

describe('DEC-294⑤ 批量入口的权限（e0a68da：按钮、字段编辑权、数据范围）', () => {
  let world: PermissionWorld;
  let data: TalentPermissionData;
  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    world = { ...world, api: tenantApi(world.db, { authorize: undefined, clock }) };
    data = await seedTalentData(world);
  });
  const adminRead = async (path: string) => {
    const response = await data.setup.request('GET', `${TC_BASE}${path}`, world.asAdmin);
    expect(response.status).toBe(200);
    return response.json();
  };
  const call = (op: Awaited<ReturnType<typeof talentOperator>>, criterion: CriterionView) =>
    op.request('POST', `/criteria/${criterion.id}/${BATCH}`, {
      ifMatch: criterion.revision,
      body: { dimensionIds: [data.inside.dimension.id], dimensionCategory: '权限用例' },
    });

  it('没有“设置指标类别”按钮 403；dimensions 字段不可编辑 403；范围外的标准 404；数据不变', async () => {
    const before = await adminRead(`/criteria/${data.inside.criterion.id}`);
    const noButton = await talentOperator(world, { mouId: data.mouId, buttons: false });
    expect((await call(noButton, data.inside.criterion)).status).toBe(403);
    const readonly = await talentOperator(world, { mouId: data.mouId, readonly: { criterion: ['dimensions'] } });
    expect((await call(readonly, data.inside.criterion)).status).toBe(403);
    const scoped = await talentOperator(world, { mouId: data.mouId });
    const outside = await call(scoped, data.outside.criterion);
    expect(outside.status).toBe(404);
    expect(await adminRead(`/criteria/${data.inside.criterion.id}`)).toEqual(before);

    const allowed = await call(scoped, data.inside.criterion);
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(categoryOf((await allowed.json()) as CriterionView, data.inside.dimension.id)).toBe('权限用例');
  });
});
