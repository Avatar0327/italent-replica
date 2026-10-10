/**
 * F-082 AC-22 并发（F082-5 改绑部分，真 PostgreSQL 16；PGlite 单连接无法并发）：
 * 改绑 × 保存 / 改名 / 删除 / 新建字段交错：无 500、无死锁（40P01）、无悬挂引用，最终状态只落在契约列出的几种，
 * 且引用表与项目状态一致（bound 的引用恰等于规范文本里的句柄 ID；unresolved 只有候选引用）。
 */
import { type Db, sql, withTenant } from '@italent/db';
import { formulaFieldIds } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { calcItem, catalogVersion, errorOf, fieldRevision, renameField } from './AC-TR-F082-support.js';
import { legacyRule, rawItemOf, type RebindWorld, rebindWorld, refsFor } from './AC-TR-F082-rebind-support.js';
import { rowsOf } from './support/f048.js';

const testDb = useTestDb();
const pg = describe.runIf(Boolean(process.env.TEST_DATABASE_URL));
const ROUNDS = 4;

/** 不变式：bound 项目的 bound 引用 = 规范文本句柄集合且无候选；非 bound 项目只有候选；没有悬挂引用。 */
async function expectConsistent(db: Db, w: RebindWorld) {
  const found = await withTenant(db, w.tenantId, (tx) =>
    tx.execute(sql`SELECT i.id, i.formula, i.formula_binding,
        COALESCE((SELECT array_agg(r.field_id::text ORDER BY r.field_id) FROM talent_review_calc_item_refs r
                   WHERE r.item_id = i.id AND r.kind = 'bound'), '{}') AS bound_refs,
        (SELECT count(*)::int FROM talent_review_calc_item_refs r
          WHERE r.item_id = i.id AND r.kind = 'candidate') AS candidates
      FROM talent_review_calc_rule_items i`),
  );
  for (const row of rowsOf<{
    id: string;
    formula: string;
    formula_binding: string;
    bound_refs: string[];
    candidates: number;
  }>(found)) {
    if (row.formula_binding === 'bound') {
      expect([...row.bound_refs].sort(), row.id).toEqual([...formulaFieldIds(row.formula)].sort());
      expect(row.candidates, `${row.id} bound 不留候选`).toBe(0);
    } else {
      expect(row.bound_refs, `${row.id} 非 bound 不该有 bound 引用`).toEqual([]);
    }
  }
}

const settle = async (response: Response) =>
  response.status < 300 ? 'ok' : `${response.status}:${String((await errorOf(response)).details['reason'])}`;

pg('AC-22 改绑 × 改名（真 PG）', () => {
  it('改绑与改名交错：最终要么 bound（改名后仍可原样渲染），要么 unresolved 且候选保护该字段；删除始终 409', async () => {
    const db = testDb().db;
    for (let round = 0; round < ROUNDS; round += 1) {
      const w = await rebindWorld(db, `f082-pg22r-${round}`);
      const [target, source] = [await w.numberField(), await w.field('number', { name: '交错源' })];
      const { itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.交错源 + 1' }]);
      const revision = await fieldRevision(w, source.id);
      const [rebound, renamed] = await Promise.all([
        w.rebind(),
        w.request('PATCH', `/fields/${source.id}`, { ifMatch: revision, body: { name: '交错源新名' } }),
      ]);
      expect(rebound.status, await rebound.clone().text()).toBe(200);
      expect(await settle(renamed)).toBe('ok');
      const raw = await rawItemOf(w, itemOf(target));
      expect(['bound', 'unresolved']).toContain(raw.formula_binding);
      const refs = await refsFor(w, itemOf(target));
      expect(refs.map((ref) => ref.field_id)).toContain(source.id);
      await expectConsistent(db, w);
      const removal = await w.request('DELETE', `/fields/${source.id}`, { ifMatch: await fieldRevision(w, source.id) });
      expect(removal.status).toBe(409);
    }
  });
});

pg('AC-22 改绑 × 保存（真 PG）', () => {
  it('改绑与同一规则的保存交错：规则行锁串行，最终都是 bound 且引用一致，无 500', async () => {
    const db = testDb().db;
    for (let round = 0; round < ROUNDS; round += 1) {
      const w = await rebindWorld(db, `f082-pg22s-${round}`);
      const [target, source] = [await w.numberField(), await w.field('number', { name: '保存源' })];
      const { rule, itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.保存源 + 1' }]);
      const [rebound, saved] = await Promise.all([
        w.rebind(),
        w.requestOn('PATCH', `/calc-rules/${rule.id}`, {
          ifMatch: rule.revision,
          body: {
            items: [calcItem(target, '盘点对象.保存源 + 2')],
            fieldCatalogVersion: await catalogVersion(db, w),
          },
        }),
      ]);
      expect(rebound.status, await rebound.clone().text()).toBe(200);
      expect(await settle(saved)).toBe('ok');
      expect((await rawItemOf(w, itemOf(target))).formula_binding).toBe('bound');
      expect((await refsFor(w, itemOf(target))).map((ref) => `${ref.kind}:${ref.field_id}`)).toEqual([
        `bound:${source.id}`,
      ]);
      await expectConsistent(db, w);
    }
  });
});

pg('AC-22 改绑 × 新建字段 / 删除字段 / 改名（真 PG）', () => {
  it('改绑期间同时新建字段、改名另一个字段、删除一个无关字段：无死锁，状态一致', async () => {
    const db = testDb().db;
    for (let round = 0; round < ROUNDS; round += 1) {
      const w = await rebindWorld(db, `f082-pg22f-${round}`);
      const [target, source, other, spare] = [
        await w.numberField(),
        await w.field('number', { name: '多路源' }),
        await w.field('number', { name: '无关甲' }),
        await w.field('number', { name: '无关乙' }),
      ];
      const { itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.多路源 + 1' }]);
      const results = await Promise.all([
        w.rebind(),
        w.field('number', { name: `新建${round}` }),
        renameField(w, other, `无关甲改${round}`),
        w.request('DELETE', `/fields/${spare.id}`, { ifMatch: await fieldRevision(w, spare.id) }),
      ]);
      expect(results[0].status, await results[0].clone().text()).toBe(200);
      expect(await settle(results[2])).toBe('ok');
      expect(await settle(results[3])).toBe('ok');
      const raw = await rawItemOf(w, itemOf(target));
      expect(['bound', 'unresolved']).toContain(raw.formula_binding);
      expect((await refsFor(w, itemOf(target))).map((ref) => ref.field_id)).toContain(source.id);
      await expectConsistent(db, w);
    }
  });
});
