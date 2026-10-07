/**
 * R3-T01 预留的只读端口（供 R3-T02 任职资格指标来源、R3-T04 盘点指标来源、职务「胜任力模型」引用读取）：
 * - 按人才标准取引用的指标（TC-R2：取指标库当前内容，不是快照），可按 能力 / 潜力 / 经历 过滤（TR-R14）；
 * - 列出可被新引用的指标（TC-R4：指标与指标库都已启用）；按 ID 批量取指标；
 * - 人才标准是否可被引用（启用、同租户；Q-M0-17）；
 * - 外部引用守卫：后续模块登记“是否被我引用”，删除人才标准时一并拦截（TC-R5 同口径）。
 * 端口是可信端口，不做权限判断：调用方按自己的业务权限决定能否读取（如盘点评估人不需要人才标准管理权限）。
 */
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type DimensionView, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();

// 动态路径：实现落地前用例因端口缺失而失败，而不是整个文件无法加载。
async function port() {
  const path = '../../apps/api/src/modules/talent/port.js';
  return (await import(path)) as typeof import('../../apps/api/src/modules/talent/port.js');
}

async function fixture(label: string) {
  const w = await talentWorld(testDb().db, label);
  const ability = await w.library('ability');
  const potential = await w.library('potential');
  const a1 = await w.dimension(ability.id, {
    name: '能力一',
    grades: [{ gradeOrder: 1, alias: '初级', description: '描述' }],
    displayOrder: 2,
  });
  const a2 = await w.dimension(ability.id, { name: '能力二', displayOrder: 1 });
  const p1 = await w.dimension(potential.id, { name: '潜力一' });
  const category = await w.category();
  const criterion = await w.criterion(category.id, [
    { dimensionId: a1.id, weight: 60, target: 3, displayOrder: 1 },
    { dimensionId: p1.id, displayOrder: 2 },
  ]);
  return { w, ability, potential, a1, a2, p1, category, criterion };
}

describe('R3-T01 只读端口', () => {
  it('按人才标准取引用指标的当前内容，可按类型过滤；跨租户读不到', async () => {
    const { db } = testDb();
    const f = await fixture('tcport');
    const { loadTalentCriterion } = await port();
    const patched = await f.w.request('PATCH', `/dimensions/${f.a1.id}`, {
      ifMatch: f.a1.revision,
      body: { definition: '端口读到的新定义' },
    });
    expect(patched.status).toBe(200);
    const snapshot = await withTenant(db, f.w.tenant.id, (tx) =>
      loadTalentCriterion(tx, f.w.tenant.id, f.criterion.id),
    );
    expect(snapshot).toMatchObject({
      id: f.criterion.id,
      enabled: true,
      dimensions: [
        {
          dimensionId: f.a1.id,
          type: 'ability',
          weight: 60,
          target: 3,
          dimension: { name: '能力一', definition: '端口读到的新定义', grades: [{ gradeOrder: 1, alias: '初级' }] },
        },
        { dimensionId: f.p1.id, type: 'potential', weight: null, target: null },
      ],
    });
    const abilityOnly = await withTenant(db, f.w.tenant.id, (tx) =>
      loadTalentCriterion(tx, f.w.tenant.id, f.criterion.id, { types: ['ability'] }),
    );
    expect(abilityOnly!.dimensions.map((item) => item.dimensionId)).toEqual([f.a1.id]);

    const other = await talentWorld(db, 'tcportother');
    expect(
      await withTenant(db, other.tenant.id, (tx) => loadTalentCriterion(tx, other.tenant.id, f.criterion.id)),
    ).toBe(null);
  });

  it('可引用指标只含已启用指标与已启用指标库，按顺序号；按 ID 批量取', async () => {
    const { db } = testDb();
    const f = await fixture('tcportlist');
    const { listReferenceableDimensions, loadTalentDimensions } = await port();
    const disabled = await f.w.request('PATCH', `/dimensions/${f.a2.id}`, {
      ifMatch: f.a2.revision,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    const list = await withTenant(db, f.w.tenant.id, (tx) =>
      listReferenceableDimensions(tx, f.w.tenant.id, { type: 'ability', limit: 50, offset: 0 }),
    );
    expect(list.map((item: DimensionView) => item.id)).toEqual([f.a1.id]);
    const libraryOff = await f.w.request('PATCH', `/libraries/${f.potential.id}`, {
      ifMatch: f.potential.revision,
      body: { enabled: false },
    });
    expect(libraryOff.status).toBe(200);
    const all = await withTenant(db, f.w.tenant.id, (tx) =>
      listReferenceableDimensions(tx, f.w.tenant.id, { limit: 50, offset: 0 }),
    );
    expect(all.map((item: DimensionView) => item.id)).toEqual([f.a1.id]);
    const loaded = await withTenant(db, f.w.tenant.id, (tx) =>
      loadTalentDimensions(tx, f.w.tenant.id, [f.p1.id, f.a2.id]),
    );
    expect(loaded.map((item: DimensionView) => [item.id, item.enabled, item.libraryEnabled])).toEqual([
      [f.a2.id, false, true],
      [f.p1.id, true, false],
    ]);
  });

  it('人才标准可被引用 = 存在、同租户且启用', async () => {
    const { db } = testDb();
    const f = await fixture('tcportref');
    const { isTalentCriterionReferenceable } = await port();
    const check = (id: string) =>
      withTenant(db, f.w.tenant.id, (tx) => isTalentCriterionReferenceable(tx, f.w.tenant.id, id));
    expect(await check(f.criterion.id)).toBe(true);
    const disabled = await f.w.request('PATCH', `/criteria/${f.criterion.id}`, {
      ifMatch: f.criterion.revision,
      body: { enabled: false },
    });
    expect(disabled.status).toBe(200);
    expect(await check(f.criterion.id)).toBe(false);
    expect(await check('00000000-0000-4000-8000-000000000009')).toBe(false);
  });

  it('外部引用守卫：被其他模块引用的人才标准不能删除，数据不变', async () => {
    const f = await fixture('tcportguard');
    const { registerTalentCriterionReferenceGuard } = await port();
    const guarded = f.criterion.id;
    registerTalentCriterionReferenceGuard(async (_tx, _tenantId, id) => (id === guarded ? 'TEST_REFERRER' : null));
    const before = await f.w.read(`/criteria/${guarded}`);
    const denied = await f.w.request('DELETE', `/criteria/${guarded}`, { ifMatch: f.criterion.revision });
    expect(denied.status).toBe(409);
    const error = ((await denied.json()) as { error: { code: string; details: { reason: string; referrer: string } } })
      .error;
    expect(error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'CRITERION_REFERENCED', referrer: 'TEST_REFERRER' },
    });
    expect(await f.w.read(`/criteria/${guarded}`)).toEqual(before);
  });
});
