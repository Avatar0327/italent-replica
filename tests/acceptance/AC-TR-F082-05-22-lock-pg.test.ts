/**
 * F-082 AC-05（锁内映射，P2-1③）与 AC-22（并发保存）——F082-3，开关打开，真 PostgreSQL 16（PGlite 单连接无法并发）：
 * - 05：第一遍绑定之后、取字段共享锁之前互换两个字段的名称：保存得到受控 409，错误码属于
 *   {CALC_BINDING_STALE, FIELD_CATALOG_CHANGED, CALC_FIELD_CHANGED}，什么都没有写入，不会静默换绑；
 * - 22：保存同时改名 / 删除被引用的字段：无 500、无悬挂引用，结果只落在契约列出的几种；引用表与规范文本一致。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { formulaFieldIds } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  boundWorld,
  calcBody,
  calcItem,
  catalogVersion,
  errorOf,
  fieldRevision,
  renameField,
  type F082World,
} from './AC-TR-F082-support.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
const CONTROLLED = ['CALC_BINDING_STALE', 'FIELD_CATALOG_CHANGED', 'CALC_FIELD_CHANGED'];

async function ruleCount(db: Db, w: F082World) {
  const found = await withTenant(db, w.as.tenant, (tx) =>
    tx.execute(sql`SELECT count(*)::int AS n FROM talent_review_calc_rules`),
  );
  return Number(rowsOf<{ n: number }>(found)[0]!.n);
}

/** 不变式：每个 bound 项目的引用表恰好等于规范文本里的句柄 ID，且没有悬挂引用。 */
async function expectConsistent(db: Db, w: F082World) {
  const found = await withTenant(db, w.as.tenant, (tx) =>
    tx.execute(sql`SELECT i.id, i.formula,
        COALESCE((SELECT array_agg(r.field_id::text ORDER BY r.field_id) FROM talent_review_calc_item_refs r
                   WHERE r.item_id = i.id AND r.kind = 'bound'), '{}') AS refs
      FROM talent_review_calc_rule_items i WHERE i.formula_binding = 'bound'`),
  );
  for (const row of rowsOf<{ id: string; formula: string; refs: string[] }>(found)) {
    expect([...row.refs].sort(), row.id).toEqual([...formulaFieldIds(row.formula)].sort());
  }
}

pg('AC-05 锁内映射（真 PG）', () => {
  async function swapDuringSave(label: string, proofs: boolean) {
    const db = testDb().db;
    const w = await boundWorld(db, label);
    const [target, a, b] = [
      await w.numberField(),
      await w.field('number', { name: '互换甲' }),
      await w.field('number', { name: '互换乙' }),
    ];
    const before = await ruleCount(db, w);
    const version = await catalogVersion(db, w);
    const item = calcItem(target, '盘点对象.互换甲 + 盘点对象.互换乙', proofs ? { formulaBindings: [a.id, b.id] } : {});
    let pending: Promise<Response> | undefined;
    await withTenant(db, w.as.tenant, async (tx) => {
      // 测试事务先锁住两个来源字段行：保存的第一遍绑定读已提交数据后，在取字段共享锁处排队
      await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id IN (${a.id}, ${b.id}) ORDER BY id FOR UPDATE`);
      pending = w.post(calcBody([item], { fieldCatalogVersion: version }));
      await waitForBlocked(db, 1);
      // 在加锁前互换名称（等价于两次改名），并推进目录版本
      await tx.execute(sql`UPDATE talent_review_fields SET name = CASE id WHEN ${a.id}::uuid THEN '互换乙'
        ELSE '互换甲' END WHERE id IN (${a.id}, ${b.id})`);
      await tx.execute(sql`UPDATE talent_review_field_catalog_versions SET version = version + 1`);
    });
    const response = await pending!;
    const error = await errorOf(response);
    expect(response.status).toBe(409);
    expect(CONTROLLED).toContain(error.details['reason']);
    expect(await ruleCount(db, w)).toBe(before);
    await expectConsistent(db, w);
    return error.details['reason'];
  }

  it('带绑定证明：名称互换 → 409（受控错误码），无写入', async () => {
    expect(await swapDuringSave('f082-pg05a', true)).toBe('CALC_BINDING_STALE');
  });

  it('不带绑定（新输入）：目录版本已变 → 409，无写入，不绑到互换后的字段', async () => {
    expect(await swapDuringSave('f082-pg05b', false)).toBe('FIELD_CATALOG_CHANGED');
  });
});

pg('AC-22 并发保存（真 PG）', () => {
  it('保存引用字段 × 同时改名：无 500；改名成功时规则仍引用同一个 ID；引用表与规范文本一致', async () => {
    const db = testDb().db;
    for (let round = 0; round < 4; round += 1) {
      const w = await boundWorld(db, `f082-pg22a-${round}`);
      const [target, source] = [await w.numberField(), await w.field('number', { name: '并发源' })];
      const version = await catalogVersion(db, w);
      const outcomes = await Promise.all([
        w.post(calcBody([calcItem(target, '盘点对象.并发源 + 1')], { fieldCatalogVersion: version })),
        renameField(w, source, `并发新名${round}`),
      ]);
      const [save, rename] = outcomes;
      expect([201, 400, 409], `save ${save.status}`).toContain(save.status);
      expect([200, 409], `rename ${rename.status}`).toContain(rename.status);
      if (save.status === 409) expect(CONTROLLED).toContain((await errorOf(save)).details['reason']);
      await expectConsistent(db, w);
    }
  });

  it('保存引用字段 × 同时删除该字段：要么保存成功删除 409 FIELD_IN_USE，要么删除成功保存被拒；无悬挂引用', async () => {
    const db = testDb().db;
    for (let round = 0; round < 4; round += 1) {
      const w = await boundWorld(db, `f082-pg22b-${round}`);
      const [target, source] = [await w.numberField(), await w.field('number', { name: '待删源' })];
      const version = await catalogVersion(db, w);
      const revision = await fieldRevision(w, source.id);
      const [save, removal] = await Promise.all([
        w.post(calcBody([calcItem(target, '盘点对象.待删源 + 1')], { fieldCatalogVersion: version })),
        w.request('DELETE', `/fields/${source.id}`, { ifMatch: revision }),
      ]);
      if (save.status === 201) {
        expect(removal.status).toBe(409);
        expect((await errorOf(removal)).details['reason']).toBe('FIELD_IN_USE');
      } else {
        expect([400, 404, 409]).toContain(save.status);
        expect([200, 409]).toContain(removal.status);
      }
      await expectConsistent(db, w);
    }
  });
});
