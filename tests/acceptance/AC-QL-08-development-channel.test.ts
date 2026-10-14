/**
 * R3-T02 C1-6（AC-QL-08）发展通道查看——管理入口（拆分方案 C1-6；设计 §5.2 #2、§5.3；规格 23 §6 QL-R13、§15）：
 * - GET /api/tenant/qualification/employees/:employeeId/development-channel：员工当前级别 + 纵向（本类别标准的级别按顺序号）
 *   + 横向（在当前级别及以下节点设置的通往其他类别的路径，QL-R13）；没有当前资格 / 当前类别没有标准是空态；
 * - GET …/development-channel/levels/:levelId：点级别看标准（默认当前类别的标准，?categoryId 可看横向目的地的标准）；
 * - 授权：DevelopmentChannel / QualificationStandard 的对象查看权 + 员工任职资格子集的查看权；通道与标准内容按查看人的字段权裁剪。
 */
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { QL_NOW } from './AC-QL-support.js';
import { channelWorld, MANAGEMENT } from './AC-QL-08-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const path = (employeeId: string, rest = '') => `${MANAGEMENT}/${employeeId}/development-channel${rest}`;

interface Card {
  employeeId: string;
  asOf: string;
  current: { categoryId: string; levelId: string; startDate: string } | null;
  standardId: string | null;
  vertical: { levelId: string; displayOrder?: number }[];
  horizontal: { levelId: string; targetCategoryId: string; targetLevelId: string }[];
}

describe('AC-QL-08 管理入口：当前级别、纵向、横向', () => {
  it('当前在 P2：纵向为标准的全部级别（按顺序号），横向只含当前级别及以下节点设置的路径（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-card');
    const { w, category, otherCategory, bareCategory, p1, p2, p3, standard } = cw;
    const id = await cw.employee();
    await cw.record(id, { levelId: p2.id, startDate: '2026-01-01' });
    const card = await w.ok<Card>(await w.api.request('GET', path(id), w.as));
    expect(card).toMatchObject({
      employeeId: id,
      standardId: standard.id,
      current: { categoryId: category.id, levelId: p2.id, startDate: '2026-01-01' },
    });
    expect(card.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(card.vertical.map((n) => [n.levelId, n.displayOrder])).toEqual([
      [p1.id, 10],
      [p2.id, 20],
      [p3.id, 30],
    ]);
    // P3 节点上的横向对 P2 员工不适用；P1 节点上的两条适用
    expect(card.horizontal.map((h) => [h.levelId, h.targetCategoryId, h.targetLevelId]).sort()).toEqual(
      [
        [p1.id, otherCategory.id, p2.id],
        [p1.id, bareCategory.id, p3.id],
      ].sort(),
    );
  });

  it('当前在 P3：P3 节点的横向也适用；P1 员工只有 P1 节点的（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-levels');
    const { w, p1, p3 } = cw;
    const top = await cw.employee();
    await cw.record(top, { levelId: p3.id });
    const bottom = await cw.employee();
    await cw.record(bottom, { levelId: p1.id });
    const topCard = await w.ok<Card>(await w.api.request('GET', path(top), w.as));
    const bottomCard = await w.ok<Card>(await w.api.request('GET', path(bottom), w.as));
    expect(topCard.horizontal).toHaveLength(3);
    expect(bottomCard.horizontal).toHaveLength(2);
    expect(bottomCard.horizontal.every((h) => h.levelId === p1.id)).toBe(true);
  });

  it('没有当前资格（无记录 / 记录都已结束 / 未来才开始）→ 200 空态（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-empty');
    const { w } = cw;
    const none = await cw.employee();
    const ended = await cw.employee();
    await cw.record(ended, { startDate: '2025-01-01', endDate: '2025-12-31' });
    const future = await cw.employee();
    await cw.record(future, { startDate: '2027-01-01' });
    for (const id of [none, ended, future]) {
      expect(await w.ok<Card>(await w.api.request('GET', path(id), w.as))).toMatchObject({
        employeeId: id,
        current: null,
        standardId: null,
        vertical: [],
        horizontal: [],
      });
    }
  });

  it('当前类别没有标准 → 有当前资格，纵向 / 横向为空（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-nostd');
    const { w, bareCategory, p1 } = cw;
    const id = await cw.employee();
    await cw.record(id, { categoryId: bareCategory.id, levelId: p1.id });
    expect(await w.ok<Card>(await w.api.request('GET', path(id), w.as))).toMatchObject({
      current: { categoryId: bareCategory.id, levelId: p1.id },
      standardId: null,
      vertical: [],
      horizontal: [],
    });
  });

  it('员工不存在 404；员工 ID 或级别 ID 不是 UUID 400（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-ids');
    const { w, p1 } = cw;
    expect((await w.api.request('GET', path(randomUUID()), w.as)).status).toBe(404);
    expect((await w.api.request('GET', path('not-a-uuid'), w.as)).status).toBe(400);
    const id = await cw.employee();
    expect((await w.api.request('GET', path(id, '/levels/not-a-uuid'), w.as)).status).toBe(400);
    expect((await w.api.request('GET', path(randomUUID(), `/levels/${p1.id}`), w.as)).status).toBe(404);
  });
});

describe('AC-QL-08 管理入口：点级别看标准', () => {
  interface LevelView {
    standardId: string;
    level: {
      levelId: string;
      displayOrder?: number;
      cells?: { targetId: string; abilities: { content?: string }[] }[];
    };
  }

  it('点本类别的级别：给出该级别的标准明细（指标 + 能力标准）；没有明细的级别 cells 为空（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-level');
    const { w, p1, p2, standard, ownTarget } = cw;
    const id = await cw.employee();
    await cw.record(id, { levelId: p2.id });
    const view = await w.ok<LevelView>(await w.api.request('GET', path(id, `/levels/${p2.id}`), w.as));
    expect(view.standardId).toBe(standard.id);
    expect(view.level).toMatchObject({ levelId: p2.id, displayOrder: 20 });
    expect(view.level.cells).toEqual([
      expect.objectContaining({
        targetId: ownTarget.id,
        abilities: [expect.objectContaining({ content: '本类二级能力' })],
      }),
    ]);
    const empty = await w.ok<LevelView>(await w.api.request('GET', path(id, `/levels/${p1.id}`), w.as));
    expect(empty.level).toMatchObject({ levelId: p1.id, cells: [] });
  });

  it('?categoryId 点横向目的地的级别看目的地类别的标准；目的地没有标准 404（AC-QL-08，规格 23 §15）', async () => {
    const cw = await channelWorld(database, 'ql08-dest');
    const { w, otherCategory, bareCategory, p2, otherStandard, otherTarget } = cw;
    const id = await cw.employee();
    await cw.record(id, { levelId: p2.id });
    const view = await w.ok<LevelView>(
      await w.api.request('GET', path(id, `/levels/${p2.id}?categoryId=${otherCategory.id}`), w.as),
    );
    expect(view.standardId).toBe(otherStandard.id);
    expect(view.level.cells).toEqual([
      expect.objectContaining({
        targetId: otherTarget.id,
        abilities: [expect.objectContaining({ content: '他类二级能力' })],
      }),
    ]);
    expect((await w.api.request('GET', path(id, `/levels/${p2.id}?categoryId=${bareCategory.id}`), w.as)).status).toBe(
      404,
    );
  });

  it('级别不在该标准的级别范围内 → 404；没有当前资格且没给 categoryId → 404（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-range');
    const { w, p2 } = cw;
    const outside = await w.level(99);
    const id = await cw.employee();
    await cw.record(id, { levelId: p2.id });
    expect((await w.api.request('GET', path(id, `/levels/${outside.id}`), w.as)).status).toBe(404);
    const none = await cw.employee();
    expect((await w.api.request('GET', path(none, `/levels/${p2.id}`), w.as)).status).toBe(404);
  });
});

describe('AC-QL-08 管理入口：授权（DevelopmentChannel / QualificationStandard 对象查看权 + 任职资格子集查看权）', () => {
  const denying = (cw: Awaited<ReturnType<typeof channelWorld>>, resource: string) =>
    tenantApi(cw.db, {
      clock: () => QL_NOW,
      authorize: async (request) => !(request.action === 'object.view' && request.resource === resource),
    });

  it('没有 DevelopmentChannel 查看权 → 卡片 403；没有 QualificationStandard 查看权 → 点级别 403（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-auth');
    const id = await cw.employee();
    await cw.record(id, {});
    const { w, p1 } = cw;
    const noChannel = denying(cw, 'Qualification.DevelopmentChannel');
    expect((await noChannel.request('GET', path(id), w.as)).status).toBe(403);
    const noStandard = denying(cw, 'Qualification.QualificationStandard');
    expect((await noStandard.request('GET', path(id, `/levels/${p1.id}`), w.as)).status).toBe(403);
    // 另一个对象的查看权不能代替
    expect((await noStandard.request('GET', path(id), w.as)).status).toBe(200);
    expect((await noChannel.request('GET', path(id, `/levels/${p1.id}`), w.as)).status).toBe(200);
  });

  it('没有员工任职资格子集（TenantBase.Qualification）的查看权 → 403，不靠通道权限旁路读本人当前资格（AC-QL-08）', async () => {
    const cw = await channelWorld(database, 'ql08-subset');
    const id = await cw.employee();
    await cw.record(id, {});
    const noSubset = denying(cw, 'TenantBase.Qualification');
    expect((await noSubset.request('GET', path(id), cw.w.as)).status).toBe(403);
    expect((await noSubset.request('GET', path(id, `/levels/${cw.p1.id}`), cw.w.as)).status).toBe(403);
  });
});
