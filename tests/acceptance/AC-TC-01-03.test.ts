/**
 * AC-TC-01～03（docs/02_业务建模/23 §2.2、§6、§7；REQ-TC-001；DEC-281）与引用约束负向用例：
 * - TC-R2 引用而非复制：指标库改了指标，人才标准详情立即显示最新内容；
 * - TC-R3 只有能力指标可以设置权重和目标（DEC-281①②：1 位小数、可空、可为负、不限范围，新增默认权重 1）；
 * - TC-R4 只有已启用的指标和指标库才能被新引用（已有引用不受影响，DEC-281⑧）；
 * - TC-R5 被引用的指标不能删除；还有指标的指标库不能删除。
 * 负向用例断言具体响应码，并前后各读一次比对，证明业务数据未被改动。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { errorCode } from './support/tenant-api.js';
import {
  type CriterionView,
  type DimensionView,
  DUPLICATE_MESSAGE,
  talentWorld,
  type TalentWorld,
} from './AC-TC-support.js';

const testDb = useTestDb();

async function details(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;
}

async function standardWithAbility(w: TalentWorld) {
  const library = await w.library('ability');
  const action = await w.descriptionType('行动建议');
  const dimension = await w.dimension(library.id, {
    name: '客户导向',
    grades: [
      { gradeOrder: 1, alias: '初级', description: '能完成基本工作' },
      { gradeOrder: 2, alias: '熟练', description: '能独立完成' },
    ],
    behaviors: [{ description: '主动回访客户', keyPoints: '频次', displayOrder: 1 }],
    suggestions: [{ typeId: action.id, description: '参与客户项目', displayOrder: 1 }],
    questions: [{ question: '讲一次处理客户投诉的经历', keyPoints: '结果', displayOrder: 1 }],
  });
  const category = await w.category();
  const criterion = await w.criterion(category.id, [{ dimensionId: dimension.id, weight: 40, target: 3 }]);
  return { library, action, dimension, category, criterion };
}

describe('AC-TC-01 引用而非复制（TC-R2）', () => {
  it('AC-TC-01 指标库中修改已被引用指标的名称与定义，人才标准详情立即显示新内容', async () => {
    const w = await talentWorld(testDb().db, 'tc01');
    const { dimension, criterion } = await standardWithAbility(w);
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    expect(before.dimensions).toHaveLength(1);
    expect(before.dimensions[0]).toMatchObject({
      dimensionId: dimension.id,
      type: 'ability',
      weight: 40,
      target: 3,
      dimension: { name: '客户导向', definition: '以客户为中心', categoryName: null },
    });

    const patched = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: dimension.revision,
      body: { name: '客户第一', definition: '始终把客户放在第一位' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const after = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    expect(after.revision).toBe(before.revision);
    expect(after.dimensions[0]!.dimension).toEqual({
      name: '客户第一',
      definition: '始终把客户放在第一位',
      categoryName: null,
    });
  });

  it('AC-TC-01 人才标准里的指标只存引用：关系表没有指标内容列', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tc01cols');
    const columns = await withTenant(db, w.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'talent_criterion_dimensions' ORDER BY column_name`);
      const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        column_name: string;
      }[];
      return rows.map((row) => row.column_name);
    });
    expect(columns).toContain('dimension_id');
    for (const copied of ['name', 'code', 'definition', 'category_id']) expect(columns).not.toContain(copied);
  });

  it('指标的等级 / 行为 / 发展建议 / 面试问题按顺序保存并整组替换', async () => {
    const w = await talentWorld(testDb().db, 'tc01desc');
    const { dimension, action } = await standardWithAbility(w);
    const loaded = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    expect(loaded).toMatchObject({
      type: 'ability',
      enabled: true,
      grades: [
        { gradeOrder: 1, alias: '初级' },
        { gradeOrder: 2, alias: '熟练' },
      ],
      behaviors: [{ description: '主动回访客户', keyPoints: '频次', displayOrder: 1 }],
      suggestions: [{ typeId: action.id, typeName: '行动建议', description: '参与客户项目', displayOrder: 1 }],
      questions: [{ question: '讲一次处理客户投诉的经历', keyPoints: '结果', displayOrder: 1 }],
    });
    // DEC-281⑪ / Q5：指标视图不再投影指标库名称与状态
    expect(loaded).not.toHaveProperty('libraryName');
    expect(loaded).not.toHaveProperty('libraryEnabled');
    const patched = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: loaded.revision,
      body: { behaviors: [], questions: [{ question: '新问题', displayOrder: 2 }] },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const after = (await patched.json()) as DimensionView;
    expect(after.behaviors).toEqual([]);
    expect(after.questions).toEqual([{ question: '新问题', keyPoints: null, displayOrder: 2 }]);
    // 未提交的子表保持原样
    expect(after.grades).toHaveLength(2);
    expect(after.suggestions).toHaveLength(1);
  });

  it('等级顺序重复被拒绝且指标不变', async () => {
    const w = await talentWorld(testDb().db, 'tc01dup');
    const { dimension } = await standardWithAbility(w);
    const before = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    const response = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: before.revision,
      body: { grades: [{ gradeOrder: 1 }, { gradeOrder: 1 }] },
    });
    expect(response.status).toBe(400);
    expect(await w.read<DimensionView>(`/dimensions/${dimension.id}`)).toEqual(before);
  });
});

describe('AC-TC-02 被引用的指标不能删除（TC-R5）', () => {
  it('AC-TC-02 删除被人才标准引用的指标：409 且指标与标准都不变；解除引用后可删除', async () => {
    const w = await talentWorld(testDb().db, 'tc02');
    const { library, dimension, criterion } = await standardWithAbility(w);
    const dimensionBefore = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    const criterionBefore = await w.read<CriterionView>(`/criteria/${criterion.id}`);

    const denied = await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: dimension.revision });
    expect(denied.status).toBe(409);
    const error = await details(denied);
    expect(error.code).toBe('CONFLICT');
    expect(error.details?.reason).toBe('DIMENSION_REFERENCED');

    expect(await w.read<DimensionView>(`/dimensions/${dimension.id}`)).toEqual(dimensionBefore);
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(criterionBefore);

    // 指标库里还有指标：不能删除指标库
    const libraryBefore = await w.read(`/libraries/${library.id}`);
    const libraryDenied = await w.request('DELETE', `/libraries/${library.id}`, { ifMatch: library.revision });
    expect(libraryDenied.status).toBe(409);
    expect((await details(libraryDenied)).details?.reason).toBe('LIBRARY_HAS_DIMENSIONS');
    expect(await w.read(`/libraries/${library.id}`)).toEqual(libraryBefore);

    const released = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: criterionBefore.revision,
      body: { dimensions: [] },
    });
    expect(released.status, await released.clone().text()).toBe(200);
    const removed = await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: dimension.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.request('GET', `/dimensions/${dimension.id}`)).status).toBe(404);
    const libraryRemoved = await w.request('DELETE', `/libraries/${library.id}`, { ifMatch: library.revision });
    expect(libraryRemoved.status, await libraryRemoved.clone().text()).toBe(200);
  });

  it('DEC-281⑧ 被引用的指标可以停用：标准详情照常显示、不带停用标记，仍可改目标 / 权重，只拦新引用', async () => {
    const w = await talentWorld(testDb().db, 'tc02keep');
    const { dimension, criterion, category } = await standardWithAbility(w);
    const disabled = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: dimension.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const current = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    expect(current.dimensions[0]).toEqual({
      dimensionId: dimension.id,
      type: 'ability',
      weight: 40,
      target: 3,
      displayOrder: 1,
      dimension: { name: '客户导向', definition: '以客户为中心', categoryName: null },
    });
    expect(JSON.stringify(current)).not.toMatch(/enabled":false|libraryEnabled/);
    const kept = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: current.revision,
      body: { name: '改名后的标准', dimensions: [{ dimensionId: dimension.id, weight: 60.5, target: -1.5 }] },
    });
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect(((await kept.json()) as CriterionView).dimensions[0]).toMatchObject({ weight: 60.5, target: -1.5 });

    const listBefore = await w.read('/criteria');
    const fresh = await w.request('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId: category.id,
        name: '新标准',
        ownerOrgId: w.orgId,
        dimensions: [{ dimensionId: dimension.id }],
      },
    });
    expect(fresh.status).toBe(400);
    expect((await details(fresh)).details?.reason).toBe('DIMENSION_NOT_ENABLED');
    expect(await w.read('/criteria')).toEqual(listBefore);

    // 停用不改变删除判定：仍被引用就不能删
    const disabledView = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    const removed = await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: disabledView.revision });
    expect(removed.status).toBe(409);
    expect((await details(removed)).details?.reason).toBe('DIMENSION_REFERENCED');
    expect(await w.read(`/dimensions/${dimension.id}`)).toEqual(disabledView);
  });

  it('停用指标库后：已有引用照常保留、可改权重 / 目标，库下有指标仍不能删除', async () => {
    const w = await talentWorld(testDb().db, 'tc02libkeep');
    const { library, dimension, criterion } = await standardWithAbility(w);
    const disabled = await w.request('PATCH', `/libraries/${library.id}`, {
      ifMatch: library.revision,
      body: { enabled: false },
    });
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    const libraryView = (await disabled.json()) as { revision: number };
    const current = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    expect(current.dimensions[0]).toMatchObject({ dimensionId: dimension.id, weight: 40, target: 3 });
    const kept = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: current.revision,
      body: { dimensions: [{ dimensionId: dimension.id, weight: 2.5, target: 4 }] },
    });
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect(((await kept.json()) as CriterionView).dimensions[0]).toMatchObject({ weight: 2.5, target: 4 });
    const before = await w.read(`/libraries/${library.id}`);
    const removed = await w.request('DELETE', `/libraries/${library.id}`, { ifMatch: libraryView.revision });
    expect(removed.status).toBe(409);
    expect((await details(removed)).details?.reason).toBe('LIBRARY_HAS_DIMENSIONS');
    expect(await w.read(`/libraries/${library.id}`)).toEqual(before);
  });

  it('DEC-281⑦ 人才标准分类下还有人才标准时不能删除分类（原站未实测 🟡，维持）', async () => {
    const w = await talentWorld(testDb().db, 'tc02cat');
    const { category } = await standardWithAbility(w);
    const before = await w.read(`/criterion-categories/${category.id}`);
    const denied = await w.request('DELETE', `/criterion-categories/${category.id}`, { ifMatch: category.revision });
    expect(denied.status).toBe(409);
    expect((await details(denied)).details?.reason).toBe('CATEGORY_HAS_CRITERIA');
    expect(await w.read(`/criterion-categories/${category.id}`)).toEqual(before);
  });

  it('删除人才标准后其引用一并解除，指标可以删除', async () => {
    const w = await talentWorld(testDb().db, 'tc02crit');
    const { dimension, criterion } = await standardWithAbility(w);
    const removed = await w.request('DELETE', `/criteria/${criterion.id}`, { ifMatch: criterion.revision });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await w.request('GET', `/criteria/${criterion.id}`)).status).toBe(404);
    expect((await w.request('DELETE', `/dimensions/${dimension.id}`, { ifMatch: dimension.revision })).status).toBe(
      200,
    );
  });
});

describe('AC-TC-03 只有能力指标可以设置权重与目标（TC-R3）', () => {
  it.each(['potential', 'experience'] as const)('AC-TC-03 给%s指标设置权重或目标被拒绝，数据不变', async (type) => {
    const w = await talentWorld(testDb().db, `tc03${type}`);
    const { criterion } = await standardWithAbility(w);
    const library = await w.library(type);
    const other = await w.dimension(library.id, { name: `${type}指标` });
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const listBefore = await w.read<{ items: unknown[] }>('/criteria');

    for (const extra of [{ weight: 10 }, { target: 2 }, { weight: 0 }, { target: -1 }]) {
      const updated = await w.request('PATCH', `/criteria/${criterion.id}`, {
        ifMatch: before.revision,
        body: {
          dimensions: [
            ...before.dimensions.map(({ dimensionId }) => ({ dimensionId })),
            { dimensionId: other.id, ...extra },
          ],
        },
      });
      expect(updated.status).toBe(400);
      const error = await details(updated);
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details?.reason).toBe('WEIGHT_TARGET_ABILITY_ONLY');

      const createdDenied = await w.request('POST', '/criteria', {
        ifMatch: 0,
        body: {
          categoryId: before.categoryId,
          name: '新标准',
          ownerOrgId: w.orgId,
          dimensions: [{ dimensionId: other.id, ...extra }],
        },
      });
      expect(createdDenied.status).toBe(400);
      expect((await details(createdDenied)).details?.reason).toBe('WEIGHT_TARGET_ABILITY_ONLY');
    }
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);
    expect(await w.read('/criteria')).toEqual(listBefore);

    // 不带权重与目标的潜力 / 经历指标可以引用，也不套用“新增默认权重 1”
    const ok = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ dimensionId: before.dimensions[0]!.dimensionId, weight: 40 }, { dimensionId: other.id }] },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as CriterionView).dimensions[1]).toMatchObject({
      type,
      weight: null,
      target: null,
    });
  });

  it('DEC-281①② 能力指标的权重与目标：1 位小数、可空、可为负、不限 0～100、不要求合计', async () => {
    const w = await talentWorld(testDb().db, 'tc03value');
    const { criterion, dimension, library } = await standardWithAbility(w);
    const second = await w.dimension(library.id, { name: '第二能力' });
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const accepted = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: {
        dimensions: [
          { dimensionId: dimension.id, weight: 150.5, target: -2.5 },
          { dimensionId: second.id, weight: -3, target: null },
        ],
      },
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const saved = (await accepted.json()) as CriterionView;
    expect(saved.dimensions.map(({ weight, target }) => ({ weight, target }))).toEqual([
      { weight: 150.5, target: -2.5 },
      { weight: -3, target: null },
    ]);
    for (const value of [{ weight: 1.25 }, { target: 0.05 }, { weight: '1' }]) {
      const rejected = await w.request('PATCH', `/criteria/${criterion.id}`, {
        ifMatch: saved.revision,
        body: { dimensions: [{ dimensionId: dimension.id, ...value }] },
      });
      expect(rejected.status, JSON.stringify(value)).toBe(400);
    }
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(saved);
  });

  it('DEC-281② 新增能力指标引用时权重缺省为 1；已有引用不传权重时保持原值，显式 null 清空', async () => {
    const w = await talentWorld(testDb().db, 'tc03default');
    const { criterion, dimension, library } = await standardWithAbility(w);
    const second = await w.dimension(library.id, { name: '默认权重' });
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const added = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ dimensionId: dimension.id }, { dimensionId: second.id }] },
    });
    expect(added.status, await added.clone().text()).toBe(200);
    const saved = (await added.json()) as CriterionView;
    expect(saved.dimensions.map(({ weight, target }) => ({ weight, target }))).toEqual([
      { weight: 40, target: 3 },
      { weight: 1, target: null },
    ]);
    const cleared = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: saved.revision,
      body: { dimensions: [{ dimensionId: dimension.id, weight: null, target: null }, { dimensionId: second.id }] },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    expect(((await cleared.json()) as CriterionView).dimensions.map(({ weight }) => weight)).toEqual([null, 1]);

    const created = await w.criterion(before.categoryId, [{ dimensionId: second.id }], { name: '默认权重标准' });
    expect(created.dimensions[0]).toMatchObject({ weight: 1, target: null });
  });
});

describe('TC-R4 只有已启用的指标与指标库能被新引用', () => {
  it('停用的指标不能新引用：400 且标准不变；重新启用后可以引用', async () => {
    const w = await talentWorld(testDb().db, 'tcr4dim');
    const { library, criterion } = await standardWithAbility(w);
    const extra = await w.dimension(library.id, { name: '团队协作' });
    const disabled = await w.request('PATCH', `/dimensions/${extra.id}`, {
      ifMatch: extra.revision,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    const disabledView = (await disabled.json()) as DimensionView;
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const dimensions = [...before.dimensions.map(({ dimensionId }) => ({ dimensionId })), { dimensionId: extra.id }];

    const denied = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions },
    });
    expect(denied.status).toBe(400);
    expect((await details(denied)).details?.reason).toBe('DIMENSION_NOT_ENABLED');
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);

    const createDenied = await w.request('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId: before.categoryId,
        name: '另一标准',
        ownerOrgId: w.orgId,
        dimensions: [{ dimensionId: extra.id }],
      },
    });
    expect(createDenied.status).toBe(400);
    expect((await details(createDenied)).details?.reason).toBe('DIMENSION_NOT_ENABLED');

    // 候选只列已启用的指标
    const candidates = await w.read<{ items: { id: string }[] }>('/candidates/dimensions?type=ability');
    expect(candidates.items.map((item) => item.id)).not.toContain(extra.id);

    const enabled = await w.request('PATCH', `/dimensions/${extra.id}`, {
      ifMatch: disabledView.revision,
      body: { enabled: true },
    });
    expect(enabled.status).toBe(200);
    const accepted = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions },
    });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
  });

  it('停用的指标库下的指标不能新引用', async () => {
    const w = await talentWorld(testDb().db, 'tcr4lib');
    const { criterion } = await standardWithAbility(w);
    const library = await w.library('ability', { name: '第二能力库' });
    const inside = await w.dimension(library.id);
    const disabled = await w.request('PATCH', `/libraries/${library.id}`, {
      ifMatch: library.revision,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const denied = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ dimensionId: inside.id, weight: 10 }] },
    });
    expect(denied.status).toBe(400);
    expect((await details(denied)).details?.reason).toBe('DIMENSION_NOT_ENABLED');
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);
    const candidates = await w.read<{ items: { id: string }[] }>('/candidates/dimensions');
    expect(candidates.items.map((item) => item.id)).not.toContain(inside.id);

    // 新建路径同样拒绝，不落库
    const listBefore = await w.read('/criteria');
    const created = await w.request('POST', '/criteria', {
      ifMatch: 0,
      body: {
        categoryId: before.categoryId,
        name: '引用停用库的指标',
        ownerOrgId: w.orgId,
        dimensions: [{ dimensionId: inside.id }],
      },
    });
    expect(created.status).toBe(400);
    expect((await details(created)).details?.reason).toBe('DIMENSION_NOT_ENABLED');
    expect(await w.read('/criteria')).toEqual(listBefore);
  });

  it('同一指标在一个标准里重复引用、引用不存在的指标被拒绝', async () => {
    const w = await talentWorld(testDb().db, 'tcr4dup');
    const { dimension, criterion } = await standardWithAbility(w);
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const duplicate = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ dimensionId: dimension.id }, { dimensionId: dimension.id }] },
    });
    expect(duplicate.status).toBe(400);
    const missing = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ dimensionId: '00000000-0000-4000-8000-000000000001' }] },
    });
    expect(missing.status).toBe(404);
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);
  });
});

describe('DEC-281⑥ 建后不可改的字段', () => {
  it('指标所属的指标库、指标库类型、指标编码、所属管理单元编辑时都不能改（400，数据不变）', async () => {
    const w = await talentWorld(testDb().db, 'tcr4imm');
    const { library, dimension, category, criterion } = await standardWithAbility(w);
    const other = await w.library('potential');
    const attempts = [
      [`/dimensions/${dimension.id}`, dimension.revision, { libraryId: other.id }],
      [`/dimensions/${dimension.id}`, dimension.revision, { code: 'CHANGED' }],
      [`/dimensions/${dimension.id}`, dimension.revision, { ownerOrgId: w.orgId }],
      [`/libraries/${library.id}`, library.revision, { type: 'potential' }],
      [`/libraries/${library.id}`, library.revision, { ownerOrgId: w.orgId }],
      [`/criterion-categories/${category.id}`, category.revision, { ownerOrgId: w.orgId }],
      [`/criteria/${criterion.id}`, criterion.revision, { ownerOrgId: w.orgId }],
    ] as const;
    for (const [path, revision, body] of attempts) {
      const before = await w.read(path);
      const response = await w.request('PATCH', path, { ifMatch: revision, body });
      expect(response.status, `${path} ${JSON.stringify(body)}`).toBe(400);
      expect(await w.read(path)).toEqual(before);
    }
    expect(await w.read<DimensionView>(`/dimensions/${dimension.id}`)).toMatchObject({
      libraryId: library.id,
      type: 'ability',
      code: dimension.code,
    });
  });

  it('标准引用行以指标为键，编辑时不能“换指标”：换成别的指标即删旧行加新行，新行按 TC-R4 重新校验', async () => {
    const w = await talentWorld(testDb().db, 'tcswap');
    const { library, dimension, criterion } = await standardWithAbility(w);
    const replacement = await w.dimension(library.id, { name: '替换指标' });
    const disabled = await w.request('PATCH', `/dimensions/${replacement.id}`, {
      ifMatch: replacement.revision,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);
    const swapped = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ dimensionId: replacement.id, weight: 40, target: 3 }] },
    });
    expect(swapped.status).toBe(400);
    expect((await details(swapped)).details?.reason).toBe('DIMENSION_NOT_ENABLED');
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);
    // 引用行没有“指标”之外可写的行标识：多传键（如 id）被结构校验拒绝
    const keyed = await w.request('PATCH', `/criteria/${criterion.id}`, {
      ifMatch: before.revision,
      body: { dimensions: [{ id: before.dimensions[0]!.dimensionId, dimensionId: dimension.id, weight: 1 }] },
    });
    expect(keyed.status).toBe(400);
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);
  });
});

describe('DEC-281⑤ 指标编码与名称', () => {
  it('编码必填、≤50、首字符为字母且只含字母数字下划线', async () => {
    const w = await talentWorld(testDb().db, 'tccodefmt');
    const library = await w.library('ability');
    const listBefore = await w.read('/dimensions');
    for (const code of [undefined, '', '1ABC', '_A', 'A-B', 'A.B', '编码', 'A'.repeat(51)]) {
      const response = await w.request('POST', '/dimensions', {
        ifMatch: 0,
        body: { libraryId: library.id, name: `格式${String(code)}`, ...(code === undefined ? {} : { code }) },
      });
      expect(response.status, String(code)).toBe(400);
    }
    expect(await w.read('/dimensions')).toEqual(listBefore);
    await w.dimension(library.id, { code: `A${'b'.repeat(49)}` });
    await w.dimension(library.id, { code: 'a_1' });
  });

  it('编码与名称在库内唯一（原站提示原文），跨库可以重复', async () => {
    const w = await talentWorld(testDb().db, 'tccode');
    const library = await w.library('ability');
    const second = await w.library('ability', { name: '第二能力库' });
    await w.dimension(library.id, { code: 'SAME', name: '同名指标' });
    const listBefore = await w.read('/dimensions');
    for (const body of [
      { code: 'SAME', name: '另一个名称' },
      { code: 'OTHER', name: '同名指标' },
    ]) {
      const duplicate = await w.request('POST', '/dimensions', {
        ifMatch: 0,
        body: { libraryId: library.id, ...body },
      });
      expect(duplicate.status, JSON.stringify(body)).toBe(409);
      const error = await details(duplicate);
      expect(error.message).toBe(DUPLICATE_MESSAGE);
      expect(error.details?.reason).toBe('NAME_OR_CODE_DUPLICATE');
    }
    expect(await w.read('/dimensions')).toEqual(listBefore);
    // 跨库同编码、同名称都可以保存（W-577）
    const crossed = await w.dimension(second.id, { code: 'SAME', name: '同名指标' });
    expect(crossed).toMatchObject({ code: 'SAME', libraryId: second.id });
    // 改名撞上库内已有名称同样拒绝
    const sibling = await w.dimension(second.id, { code: 'SIBLING', name: '兄弟指标' });
    const clash = await w.request('PATCH', `/dimensions/${sibling.id}`, {
      ifMatch: sibling.revision,
      body: { name: '同名指标' },
    });
    expect(clash.status).toBe(409);
    expect((await details(clash)).message).toBe(DUPLICATE_MESSAGE);
    expect(await w.read(`/dimensions/${sibling.id}`)).toEqual(sibling);
  });
});

describe('并发与幂等（AGENTS §10）', () => {
  it('revision 不一致返回 409，数据不变', async () => {
    const w = await talentWorld(testDb().db, 'tcrev');
    const { dimension } = await standardWithAbility(w);
    const before = await w.read<DimensionView>(`/dimensions/${dimension.id}`);
    const stale = await w.request('PATCH', `/dimensions/${dimension.id}`, {
      ifMatch: before.revision + 5,
      body: { name: '过期写入' },
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('REVISION_CONFLICT');
    expect(await w.read<DimensionView>(`/dimensions/${dimension.id}`)).toEqual(before);
  });

  it('同一命令 ID 重放返回首次结果，不重复创建', async () => {
    const w = await talentWorld(testDb().db, 'tcidem');
    const library = await w.library('ability');
    const command = {
      ifMatch: 0,
      idempotencyKey: 'tc-replay-1',
      body: { libraryId: library.id, code: 'R1', name: '重放' },
    };
    const first = await w.request('POST', '/dimensions', command);
    const second = await w.request('POST', '/dimensions', command);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    const list = await w.read<{ items: unknown[] }>(`/dimensions?libraryId=${library.id}`);
    expect(list.items).toHaveLength(1);
  });
});
