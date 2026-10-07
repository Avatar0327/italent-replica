/**
 * R3-T01 引用约束在真实 PostgreSQL 16 上的强制交错（TC-R4 / TC-R5；AGENTS §10「并发」）：
 * 取锁顺序 人才标准 → 指标 → 指标库（talent/service.ts）：保存标准时对引用的指标与指标库加 FOR SHARE，停用 / 删除指标先 FOR UPDATE。
 * - 停用指标的事务先持锁，并发的“新引用该指标”等待后读到停用状态 → 400，不会引用到已停用指标；
 * - 引用该指标的事务先持锁（未提交），并发删除该指标等待后读到已提交的引用 → 409，不会删掉被引用指标；
 * - 库内分类、发展建议类型（DEC-281③④）同一模式：引用方共享锁未提交时，删除方等待后读到引用 → 409；
 * - 同库同编码并发新建（DEC-281⑤）：唯一约束兜底，一个 201、一个 409（原站提示原文）。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { type CriterionView, DUPLICATE_MESSAGE, talentWorld } from './AC-TC-support.js';

const testDb = useTestDb();

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function blocked(db: Db, expected: number) {
  for (let i = 0; i < 200; i++) {
    const [row] = rowsOf<{ count: number }>(
      await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
    );
    if (row?.count === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`未观测到 ${expected} 个被锁阻塞的并发操作`);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('R3-T01 PostgreSQL 16 强制交错', () => {
  it('停用指标与新引用并发：引用方等待后读到停用 → 400，标准不变', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tcpgdisable');
    const library = await w.library('ability');
    const first = await w.dimension(library.id, { name: '已引用' });
    const target = await w.dimension(library.id, { name: '将被停用' });
    const category = await w.category();
    const criterion = await w.criterion(category.id, [{ dimensionId: first.id }]);
    const before = await w.read<CriterionView>(`/criteria/${criterion.id}`);

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_dimensions WHERE id = ${target.id}::uuid FOR UPDATE`);
      pending = w.request('PATCH', `/criteria/${criterion.id}`, {
        ifMatch: before.revision,
        body: { dimensions: [{ dimensionId: first.id }, { dimensionId: target.id, weight: 10 }] },
      });
      await blocked(db, 1);
      await tx.execute(sql`UPDATE talent_dimensions SET enabled = false, revision = revision + 1
        WHERE id = ${target.id}::uuid`);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(400);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'DIMENSION_NOT_ENABLED',
    );
    expect(await w.read<CriterionView>(`/criteria/${criterion.id}`)).toEqual(before);
  });

  it('删除指标与新引用并发：删除方等待后读到已提交的引用 → 409，指标仍在', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tcpgdelete');
    const library = await w.library('ability');
    const target = await w.dimension(library.id, { name: '将被引用' });
    const category = await w.category();
    const criterion = await w.criterion(category.id, []);

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      // 模拟引用事务：先锁标准，再对指标加共享锁并写入引用，提交前删除请求到达
      await tx.execute(sql`SELECT id FROM talent_criteria WHERE id = ${criterion.id}::uuid FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM talent_dimensions WHERE id = ${target.id}::uuid FOR SHARE`);
      await tx.execute(sql`INSERT INTO talent_criterion_dimensions
        (tenant_id, criterion_id, dimension_id, display_order)
        VALUES (${w.tenant.id}::uuid, ${criterion.id}::uuid, ${target.id}::uuid, 1)`);
      pending = w.request('DELETE', `/dimensions/${target.id}`, { ifMatch: target.revision });
      await blocked(db, 1);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'DIMENSION_REFERENCED',
    );
    expect((await w.request('GET', `/dimensions/${target.id}`)).status).toBe(200);
  });

  it('删除库内分类与指标引用该分类并发：删除方等待后读到引用 → 409，分类仍在', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tcpgcat');
    const library = await w.library('ability');
    const category = await w.dimensionCategory(library.id);
    const dimension = await w.dimension(library.id);

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      // 模拟指标保存：先锁指标，再对分类加共享锁并改指标的分类，提交前删除请求到达
      await tx.execute(sql`SELECT id FROM talent_dimensions WHERE id = ${dimension.id}::uuid FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM talent_dimension_categories WHERE id = ${category.id}::uuid FOR SHARE`);
      await tx.execute(
        sql`UPDATE talent_dimensions SET category_id = ${category.id}::uuid WHERE id = ${dimension.id}::uuid`,
      );
      pending = w.request('DELETE', `/dimension-categories/${category.id}`, { ifMatch: category.revision });
      await blocked(db, 1);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'DIMENSION_CATEGORY_IN_USE',
    );
    expect((await w.request('GET', `/dimension-categories/${category.id}`)).status).toBe(200);
  });

  it('删除发展建议类型与指标选用该类型并发：删除方等待后读到引用 → 409，类型仍在', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tcpgtype');
    const library = await w.library('ability');
    const type = await w.descriptionType('并发类型');
    const dimension = await w.dimension(library.id);

    let pending: Promise<Response> | undefined;
    await withTenant(db, w.tenant.id, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_dimensions WHERE id = ${dimension.id}::uuid FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM talent_description_types WHERE id = ${type.id}::uuid FOR SHARE`);
      await tx.execute(sql`INSERT INTO talent_dimension_suggestions
        (tenant_id, dimension_id, type_id, description, display_order)
        VALUES (${w.tenant.id}::uuid, ${dimension.id}::uuid, ${type.id}::uuid, '并发建议', 1)`);
      pending = w.request('DELETE', `/description-types/${type.id}`, { ifMatch: type.revision });
      await blocked(db, 1);
    });
    const response = await pending!;
    expect(response.status, await response.clone().text()).toBe(409);
    expect(((await response.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'DESCRIPTION_TYPE_IN_USE',
    );
    expect((await w.request('GET', `/description-types/${type.id}`)).status).toBe(200);
  });

  it('同库同编码并发新建：唯一约束兜底，一个 201、一个 409（原站提示原文）', async () => {
    const { db } = testDb();
    const w = await talentWorld(db, 'tcpgcode');
    const library = await w.library('ability');
    const post = (name: string) =>
      w.request('POST', '/dimensions', { ifMatch: 0, body: { libraryId: library.id, code: 'RACE', name } });
    const responses = await Promise.all([post('并发甲'), post('并发乙')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const rejected = responses.find((response) => response.status === 409)!;
    expect(((await rejected.json()) as { error: { message: string } }).error.message).toBe(DUPLICATE_MESSAGE);
    const list = await w.read<{ items: { code: string }[] }>(`/dimensions?libraryId=${library.id}`);
    expect(list.items.map((item) => item.code)).toEqual(['RACE']);
  });
});
