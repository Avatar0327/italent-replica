/**
 * F-082 AC-24 + 表结构（F082-1，契约 §1.3）：
 * - 优先级库检查 0～1000000（越界直写被库约束拒绝）；
 * - 计算项目新增 formula_binding / binding_issue / 复合唯一键；
 * - 引用表 talent_review_calc_item_refs：复合外键（项目 cascade、字段 restrict）、kind 检查、租户隔离；
 * - 字段目录版本表 talent_review_field_catalog_versions：租户主键、默认 0、租户隔离。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';

const testDb = useTestDb();
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

interface World {
  readonly tenantId: string;
  readonly fieldA: string;
  readonly fieldB: string;
  readonly ruleId: string;
  readonly itemId: string;
}

let tenantNo = 0;
async function world(): Promise<World> {
  const { db } = testDb();
  const tenantId = randomUUID();
  tenantNo += 1;
  await db.execute(sql`INSERT INTO tenants (id, code, name) VALUES (${tenantId}, ${`f082-${tenantNo}`}, 'f082')`);
  const [fieldA, fieldB, ruleId, itemId, actor] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  await withTenant(db, tenantId, async (tx) => {
    for (const [id, code, name] of [
      [fieldA, 'score_a', '得分A'],
      [fieldB, 'score_b', '得分B'],
    ] as const) {
      await tx.execute(sql`INSERT INTO talent_review_fields (id, tenant_id, code, name, kind, field_group, precision)
        VALUES (${id}, ${tenantId}, ${code}, ${name}, 'number', 'result', 2)`);
    }
    await tx.execute(sql`INSERT INTO talent_review_calc_rules (id, tenant_id, name, created_by, updated_by)
      VALUES (${ruleId}, ${tenantId}, '规则', ${actor}, ${actor})`);
    await tx.execute(sql`INSERT INTO talent_review_calc_rule_items (id, tenant_id, rule_id, target_field_id, formula)
      VALUES (${itemId}, ${tenantId}, ${ruleId}, ${fieldA}, '1')`);
  });
  return { tenantId, fieldA, fieldB, ruleId, itemId };
}

const insertItem = (w: World, targetFieldId: string, priority: number) =>
  withTenant(testDb().db, w.tenantId, (tx) =>
    tx.execute(sql`INSERT INTO talent_review_calc_rule_items (tenant_id, rule_id, target_field_id, priority, formula)
      VALUES (${w.tenantId}, ${w.ruleId}, ${targetFieldId}, ${priority}, '1')`),
  );

describe('AC-24 优先级：库检查 0～1000000', () => {
  it('1000000 与 0 可以写入；1000001 与 -1 被库约束拒绝（23514），数据不变', async () => {
    const w = await world();
    const extra = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await withTenant(testDb().db, w.tenantId, async (tx) => {
      for (const [index, id] of extra.entries()) {
        await tx.execute(sql`INSERT INTO talent_review_fields (id, tenant_id, code, name, kind, field_group, precision)
          VALUES (${id}, ${w.tenantId}, ${`extra_${index}`}, ${`额外${index}`}, 'number', 'result', 2)`);
      }
    });
    await insertItem(w, extra[0]!, 1_000_000);
    await insertItem(w, extra[1]!, 0);
    for (const [target, priority] of [
      [extra[2]!, 1_000_001],
      [extra[3]!, -1],
    ] as const) {
      const error = await insertItem(w, target, priority).catch((e: unknown) => e);
      expect(pgErrorCode(error), String(priority)).toBe('23514');
    }
    const count = await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM talent_review_calc_rule_items`),
    );
    expect(rows<{ n: number }>(count)[0]!.n).toBe(3);
  });
});

describe('计算项目：绑定状态列与复合唯一键', () => {
  it('formula_binding 默认 legacy、binding_issue 默认空；取值只允许 bound / legacy / unresolved', async () => {
    const w = await world();
    const read = await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`SELECT formula_binding, binding_issue FROM talent_review_calc_rule_items WHERE id = ${w.itemId}`),
    );
    expect(rows(read)).toEqual([{ formula_binding: 'legacy', binding_issue: null }]);
    for (const state of ['bound', 'unresolved', 'legacy']) {
      await withTenant(testDb().db, w.tenantId, (tx) =>
        tx.execute(sql`UPDATE talent_review_calc_rule_items SET formula_binding = ${state} WHERE id = ${w.itemId}`),
      );
    }
    const bad = await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`UPDATE talent_review_calc_rule_items SET formula_binding = 'other' WHERE id = ${w.itemId}`),
    ).catch((e: unknown) => e);
    expect(pgErrorCode(bad)).toBe('23514');
  });

  it('(tenant_id, id) 复合唯一键存在，供引用表复合外键引用', async () => {
    const found = await testDb().db.execute(sql`
      SELECT 1 AS ok FROM pg_constraint c
       WHERE c.conrelid = 'talent_review_calc_rule_items'::regclass AND c.contype = 'u'
         AND (SELECT array_agg(a.attname::text ORDER BY k.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) = ARRAY['tenant_id', 'id']`);
    expect(rows(found)).toHaveLength(1);
  });
});

describe('引用表 talent_review_calc_item_refs', () => {
  const insertRef = (w: World, fieldId: string, kind: string, itemId = w.itemId) =>
    withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_calc_item_refs (tenant_id, item_id, field_id, kind)
        VALUES (${w.tenantId}, ${itemId}, ${fieldId}, ${kind})`),
    );
  const refCount = async (w: World) =>
    rows<{ n: number }>(
      await withTenant(testDb().db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM talent_review_calc_item_refs`),
      ),
    )[0]!.n;

  it('主键 (租户, 项目, 字段)；kind 只允许 bound / candidate', async () => {
    const w = await world();
    await insertRef(w, w.fieldB, 'bound');
    expect(pgErrorCode(await insertRef(w, w.fieldB, 'candidate').catch((e: unknown) => e))).toBe('23505');
    expect(pgErrorCode(await insertRef(w, w.fieldA, 'other').catch((e: unknown) => e))).toBe('23514');
    expect(await refCount(w)).toBe(1);
  });

  it('被引用的字段删除被库外键拒绝（restrict）；字段在引用表里不可悬挂', async () => {
    const w = await world();
    await insertRef(w, w.fieldB, 'candidate');
    const error = await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`DELETE FROM talent_review_fields WHERE id = ${w.fieldB}`),
    ).catch((e: unknown) => e);
    // restrict 在 PGlite 报 23001，真 PG 报 23503，都是外键拒绝
    expect(['23001', '23503']).toContain(pgErrorCode(error));
    const dangling = await insertRef(w, randomUUID(), 'bound').catch((e: unknown) => e);
    expect(pgErrorCode(dangling)).toBe('23503');
    expect(await refCount(w)).toBe(1);
  });

  it('删除计算项目或整条规则时引用随之级联删除（候选引用一并清除）', async () => {
    const w = await world();
    await insertRef(w, w.fieldB, 'candidate');
    await withTenant(testDb().db, w.tenantId, (tx) =>
      tx.execute(sql`DELETE FROM talent_review_calc_rules WHERE id = ${w.ruleId}`),
    );
    expect(await refCount(w)).toBe(0);
  });

  it('跨租户引用被复合外键拒绝；其他租户读不到引用表（RLS）', async () => {
    const [a, b] = [await world(), await world()];
    await insertRef(a, a.fieldB, 'bound');
    // 租户 b 的项目引用租户 a 的字段：复合外键 (tenant_id, field_id) 找不到
    const cross = await insertRef(b, a.fieldB, 'bound', b.itemId).catch((e: unknown) => e);
    expect(pgErrorCode(cross)).toBe('23503');
    expect(await refCount(b)).toBe(0);
    expect(await refCount(a)).toBe(1);
  });
});

describe('字段目录版本表 talent_review_field_catalog_versions', () => {
  it('租户主键、版本默认 0；一个租户只能有一行；其他租户读不到（RLS）', async () => {
    const [a, b] = [await world(), await world()];
    await withTenant(testDb().db, a.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_field_catalog_versions (tenant_id) VALUES (${a.tenantId})`),
    );
    const read = (w: World) =>
      withTenant(testDb().db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT tenant_id, version::text AS version FROM talent_review_field_catalog_versions`),
      );
    expect(rows(await read(a))).toEqual([{ tenant_id: a.tenantId, version: '0' }]);
    expect(rows(await read(b))).toEqual([]);
    const dup = await withTenant(testDb().db, a.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_field_catalog_versions (tenant_id) VALUES (${a.tenantId})`),
    ).catch((e: unknown) => e);
    expect(pgErrorCode(dup)).toBe('23505');
    // 不能为别的租户写版本行
    const foreign = await withTenant(testDb().db, a.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO talent_review_field_catalog_versions (tenant_id) VALUES (${b.tenantId})`),
    ).catch((e: unknown) => e);
    expect(pgErrorCode(foreign)).toBe('42501');
  });
});
