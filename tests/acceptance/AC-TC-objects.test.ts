/**
 * DEC-281③④（docs/02_业务建模/23 §7 #3、#4）：
 * - 指标库内分类是独立对象 Category：名称必填（≤50）、顺序为必填整数、挂在库下、无编码与层级；指标以查找字段引用，
 *   只能引用同一指标库的分类；分类被指标引用、库里还有分类时不能删除（🟡 原站未取证，按不留孤儿处理）；
 * - 发展建议是指标下的子表：类型为必填下拉（数据源 DescriptionType，可配置；样本“行动建议”🟡）、描述必填、呈现顺序必填；
 *   停用的类型不能新选用（已有行保留），被引用的类型不能删除。
 * 负向用例断言具体响应码，并前后各读一次比对。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type DimensionCategoryView, type DimensionView, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();

async function reason(response: Response) {
  return ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;
}

describe('DEC-281③ 指标库内分类（Category）', () => {
  it('分类挂在指标库下：名称必填 ≤50、顺序必填整数；不收编码与上级', async () => {
    const w = await talentWorld(testDb().db, 'tccat');
    const library = await w.library('ability');
    const created = await w.dimensionCategory(library.id, { name: '专业能力', displayOrder: 2 });
    expect(created).toMatchObject({
      libraryId: library.id,
      name: '专业能力',
      displayOrder: 2,
      ownerOrgId: library.ownerOrgId,
      revision: 1,
    });
    const listBefore = await w.read('/dimension-categories');
    for (const body of [
      { libraryId: library.id, displayOrder: 1 },
      { libraryId: library.id, name: '', displayOrder: 1 },
      { libraryId: library.id, name: '甲'.repeat(51), displayOrder: 1 },
      { libraryId: library.id, name: '缺顺序' },
      { libraryId: library.id, name: '小数顺序', displayOrder: 1.5 },
      { libraryId: library.id, name: '带编码', displayOrder: 1, code: 'C1' },
      { libraryId: library.id, name: '带上级', displayOrder: 1, parentId: created.id },
    ]) {
      const response = await w.request('POST', '/dimension-categories', { ifMatch: 0, body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await w.read('/dimension-categories')).toEqual(listBefore);
    const listed = await w.read<{ items: DimensionCategoryView[] }>(`/dimension-categories?libraryId=${library.id}`);
    expect(listed.items.map((item) => item.id)).toEqual([created.id]);
    // 所属指标库建后不可改
    const other = await w.library('ability', { name: '另一个库' });
    const moved = await w.request('PATCH', `/dimension-categories/${created.id}`, {
      ifMatch: created.revision,
      body: { libraryId: other.id },
    });
    expect(moved.status).toBe(400);
    const renamed = await w.request('PATCH', `/dimension-categories/${created.id}`, {
      ifMatch: created.revision,
      body: { name: '专业技能', displayOrder: 3 },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: '专业技能', displayOrder: 3, revision: 2 });
  });

  it('指标以查找字段引用分类，显示分类名称；只能引用同一指标库的分类', async () => {
    const w = await talentWorld(testDb().db, 'tccatref');
    const library = await w.library('ability');
    const other = await w.library('ability', { name: '另一个库' });
    const mine = await w.dimensionCategory(library.id, { name: '通用能力' });
    const foreign = await w.dimensionCategory(other.id, { name: '外库分类' });
    const dimension = await w.dimension(library.id, { categoryId: mine.id });
    expect(dimension).toMatchObject({ categoryId: mine.id, categoryName: '通用能力' });

    const listBefore = await w.read('/dimensions');
    const crossed = await w.request('POST', '/dimensions', {
      ifMatch: 0,
      body: { libraryId: library.id, code: 'CROSS', name: '跨库分类', categoryId: foreign.id },
    });
    expect(crossed.status).toBe(400);
    expect(await reason(crossed)).toBe('CATEGORY_LIBRARY_MISMATCH');
    const missing = await w.request('POST', '/dimensions', {
      ifMatch: 0,
      body: {
        libraryId: library.id,
        code: 'MISS',
        name: '分类不存在',
        categoryId: '00000000-0000-4000-8000-0000000000aa',
      },
    });
    expect(missing.status).toBe(404);
    expect(await w.read('/dimensions')).toEqual(listBefore);

    const before = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    const moved = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: before.revision,
      body: { categoryId: foreign.id },
    });
    expect(moved.status).toBe(400);
    expect(await w.read(`/dimensions/${dimension.id}`)).toEqual(before);
    const cleared = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: before.revision,
      body: { categoryId: null },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(await cleared.json()).toMatchObject({ categoryId: null, categoryName: null });
  });

  it('分类被指标引用时不能删除；库里还有分类时不能删除指标库（409，数据不变）', async () => {
    const w = await talentWorld(testDb().db, 'tccatdel');
    const library = await w.library('ability');
    const category = await w.dimensionCategory(library.id);
    const dimension = await w.dimension(library.id, { categoryId: category.id });
    const before = await w.read(`/dimension-categories/${category.id}`);
    const denied = await w.request('DELETE', `/dimension-categories/${category.id}`, { ifMatch: category.revision });
    expect(denied.status).toBe(409);
    expect(await reason(denied)).toBe('DIMENSION_CATEGORY_IN_USE');
    expect(await w.read(`/dimension-categories/${category.id}`)).toEqual(before);

    expect((await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: dimension.revision })).status).toBe(
      200,
    );
    const libraryBefore = await w.read(`/libraries/${library.id}`);
    const libraryDenied = await w.request('DELETE', `/libraries/${library.id}`, { ifMatch: library.revision });
    expect(libraryDenied.status).toBe(409);
    expect(await reason(libraryDenied)).toBe('LIBRARY_HAS_CATEGORIES');
    expect(await w.read(`/libraries/${library.id}`)).toEqual(libraryBefore);

    const removed = await w.request('DELETE', `/dimension-categories/${category.id}`, { ifMatch: category.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.request('GET', `/dimension-categories/${category.id}`)).status).toBe(404);
    expect((await w.request('DELETE', `/libraries/${library.id}`, { ifMatch: library.revision })).status).toBe(200);
  });
});

describe('DEC-281④ 发展建议子表与类型数据源（DescriptionType）', () => {
  it('类型必填且取自数据源，描述必填，呈现顺序必填；按呈现顺序返回并带类型名称', async () => {
    const w = await talentWorld(testDb().db, 'tcsug');
    const library = await w.library('ability');
    const action = await w.descriptionType('行动建议');
    const course = await w.descriptionType('课程学习', { displayOrder: 2 });
    const dimension = await w.dimension(library.id);
    const bad = [
      [{ description: '缺类型', displayOrder: 1 }],
      [{ typeId: action.id, displayOrder: 1 }],
      [{ typeId: action.id, description: '', displayOrder: 1 }],
      [{ typeId: action.id, description: '缺顺序' }],
      [{ suggestionType: '自由文本', description: '旧写法', displayOrder: 1 }],
    ];
    for (const suggestions of bad) {
      const response = await w.request('PATCH', `/dimensions/${dimension.id}`, {
        ifMatch: dimension.revision,
        body: { suggestions },
      });
      expect(response.status, JSON.stringify(suggestions)).toBe(400);
    }
    const unknown = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: dimension.revision,
      body: {
        suggestions: [{ typeId: '00000000-0000-4000-8000-0000000000bb', description: '未知类型', displayOrder: 1 }],
      },
    });
    expect(unknown.status).toBe(400);
    expect(await reason(unknown)).toBe('DESCRIPTION_TYPE_INVALID');
    expect(await w.read(`/dimensions/${dimension.id}`)).toEqual(dimension);

    const saved = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: dimension.revision,
      body: {
        suggestions: [
          { typeId: course.id, description: '参加管理课程', displayOrder: 2 },
          { typeId: action.id, description: '承担跨部门项目', displayOrder: 1 },
        ],
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(((await saved.json()) as DimensionView).suggestions).toEqual([
      { typeId: action.id, typeName: '行动建议', description: '承担跨部门项目', displayOrder: 1 },
      { typeId: course.id, typeName: '课程学习', description: '参加管理课程', displayOrder: 2 },
    ]);
  });

  it('停用的类型不能新选用，已有行保留并可改描述；被引用的类型不能删除', async () => {
    const w = await talentWorld(testDb().db, 'tcsugtype');
    const library = await w.library('ability');
    const action = await w.descriptionType('行动建议');
    const spare = await w.descriptionType('备用类型');
    const dimension = await w.dimension(library.id, {
      suggestions: [{ typeId: action.id, description: '原描述', displayOrder: 1 }],
    });
    for (const type of [action, spare]) {
      const disabled = await w.request('PATCH', `/description-types/${type.id}`, {
        ifMatch: type.revision,
        body: { enabled: false },
      });
      expect(disabled.status, await disabled.clone().text()).toBe(200);
    }
    const before = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    const fresh = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: before.revision,
      body: {
        suggestions: [
          { typeId: action.id, description: '原描述', displayOrder: 1 },
          { typeId: spare.id, description: '新选停用类型', displayOrder: 2 },
        ],
      },
    });
    expect(fresh.status).toBe(400);
    expect(await reason(fresh)).toBe('DESCRIPTION_TYPE_INVALID');
    expect(await w.read(`/dimensions/${dimension.id}`)).toEqual(before);
    const kept = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: before.revision,
      body: { suggestions: [{ typeId: action.id, description: '改过的描述', displayOrder: 1 }] },
    });
    expect(kept.status, await kept.clone().text()).toBe(200);

    // 候选只列启用的类型
    const candidates = await w.read<{ items: { id: string }[] }>('/candidates/description-types');
    expect(candidates.items.map((item) => item.id)).not.toContain(spare.id);

    const typeBefore = await w.read<{ revision: number }>(`/description-types/${action.id}`);
    const denied = await w.request('DELETE', `/description-types/${action.id}`, { ifMatch: typeBefore.revision });
    expect(denied.status).toBe(409);
    expect(await reason(denied)).toBe('DESCRIPTION_TYPE_IN_USE');
    expect(await w.read(`/description-types/${action.id}`)).toEqual(typeBefore);
    // 类型名称在租户内唯一
    const typesBefore = await w.read('/description-types');
    const duplicate = await w.request('POST', '/description-types', { ifMatch: 0, body: { name: '行动建议' } });
    expect(duplicate.status).toBe(409);
    expect(await reason(duplicate)).toBe('DESCRIPTION_TYPE_NAME_TAKEN');
    expect(await w.read('/description-types')).toEqual(typesBefore);
    const spareNow = await w.read<{ revision: number }>(`/description-types/${spare.id}`);
    expect((await w.request('DELETE', `/description-types/${spare.id}`, { ifMatch: spareNow.revision })).status).toBe(
      200,
    );
  });
});
