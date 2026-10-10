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
import {
  auditCount,
  legacyRule,
  rawItemOf,
  type RebindWorld,
  rebindWorld,
  refsFor,
  REBIND_ACTION,
} from './AC-TR-F082-rebind-support.js';
import { lockFieldCatalog } from '../../apps/api/src/modules/talent-review/field-catalog.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';

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

pg('AC-22 两遍规划之间新增同名字段（真 PG，F082-5 第 1 轮 P3）', () => {
  it('第一遍规划之后、版本行共享锁之前提交了同名新字段：409 CALC_FIELD_CHANGED、没有引用写入；换命令 ID 重试转 unresolved', async () => {
    const db = testDb().db;
    const w = await rebindWorld(db, 'f082-pg22-twopass');
    const [target, source] = [await w.numberField(), await w.field('number', { name: '双遍乙' })];
    const { rule, itemOf } = await legacyRule(w, [{ target, formula: '盘点对象.双遍乙 + 1' }]);

    // 持有字段目录版本行（V FOR UPDATE），让“新建同名字段”与“改绑”都排在它后面，且新建先于改绑
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = withTenant(db, w.tenantId, async (tx) => {
      await lockFieldCatalog(tx, w.tenantId);
      held();
      await gate;
    });
    await holding;
    const creating = w.field('number', { name: '双遍乙' });
    await waitForBlocked(db, 1);
    // 改绑的第一遍规划读到的字段目录里还没有新字段（新建未提交），随后在版本行共享锁处排队
    const rebinding = w.rebind();
    await waitForBlocked(db, 2);
    release();
    await holder;
    const fresh = await creating;
    const refused = await rebinding;

    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).details['reason']).toBe('CALC_FIELD_CHANGED');
    expect((await rawItemOf(w, itemOf(target))).formula_binding).toBe('legacy');
    expect(await refsFor(w, itemOf(target))).toEqual([]);
    expect(await auditCount(w, REBIND_ACTION, rule.id)).toBe(0);

    // 换命令 ID 重试：同名字段有两个 → AMBIGUOUS_FIELD，候选是两个同名字段
    const retried = await w.runRebind();
    expect(retried.unresolved).toEqual([{ ruleId: rule.id, targetFieldId: target.id, reason: 'AMBIGUOUS_FIELD' }]);
    expect((await refsFor(w, itemOf(target))).map((ref) => `${ref.kind}:${ref.field_id}`).sort()).toEqual(
      [`candidate:${source.id}`, `candidate:${fresh.id}`].sort(),
    );
    await expectConsistent(db, w);
  });
});
