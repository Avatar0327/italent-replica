/**
 * F-082 AC-21 迁移回滚（F082-5，契约 §6.5）：改绑一个租户是一个事务——中途注入异常，该租户无任何变化
 * （规范文本、引用、审计、平台命令台账的成功记录都没有）；之后用新的命令 ID 重试成功，已经 bound 的行下次被跳过。
 */
import { randomUUID } from 'node:crypto';
import { sql, withPlatform } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  auditCount,
  legacyRule,
  rawItemOf,
  rebindWorld,
  refsFor,
  REBIND_ACTION,
  rows,
} from './AC-TR-F082-rebind-support.js';

const testDb = useTestDb();

describe('AC-21 改绑中途失败：整个租户回滚', () => {
  it('第三个项目写入时注入异常：三个项目都仍是 legacy、没有引用与审计、台账无成功记录；换命令 ID 重试成功', async () => {
    const db = testDb().db;
    const w = await rebindWorld(db, 'f082-r21');
    const sources = [await w.field('number', { name: '回滚源甲' }), await w.field('number', { name: '回滚源乙' })];
    const targets = [await w.numberField(), await w.numberField(), await w.numberField()];
    const created = [];
    for (const [index, target] of targets.entries()) {
      created.push(await legacyRule(w, [{ target, formula: `盘点对象.${sources[index % 2]!.name} + ${index}` }]));
    }

    // 已有两个项目在本事务内变成 bound 之后，第三个变 bound 时抛错（触发器看得到本事务内的更新）
    await db.execute(sql`CREATE FUNCTION f082_reject_third_bind() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM talent_review_calc_rule_items WHERE formula_binding = 'bound') >= 2 THEN
          RAISE EXCEPTION 'synthetic rebind failure' USING ERRCODE = '53100';
        END IF;
        RETURN NEW;
      END $$`);
    await db.execute(sql`CREATE TRIGGER f082_reject_third_bind BEFORE UPDATE ON talent_review_calc_rule_items
      FOR EACH ROW WHEN (NEW.formula_binding = 'bound') EXECUTE FUNCTION f082_reject_third_bind()`);
    const key = randomUUID();
    try {
      const failed = await w.rebind({}, key);
      expect(failed.status).toBeGreaterThanOrEqual(500);

      for (const [index, entry] of created.entries()) {
        const itemId = entry.itemOf(targets[index]!);
        const raw = await rawItemOf(w, itemId);
        expect(raw.formula_binding).toBe('legacy');
        expect(raw.formula).toMatch(/^盘点对象\./);
        expect(await refsFor(w, itemId)).toEqual([]);
        expect(await auditCount(w, REBIND_ACTION, entry.rule.id)).toBe(0);
      }
      const ledger = await withPlatform(db, (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM platform_command_ledger WHERE command_id = ${key}`),
      );
      expect(Number(rows<{ n: number }>(ledger)[0]!.n)).toBe(0);
    } finally {
      await db.execute(sql`DROP TRIGGER f082_reject_third_bind ON talent_review_calc_rule_items`);
      await db.execute(sql`DROP FUNCTION f082_reject_third_bind()`);
    }

    // 新的命令 ID 重试：全部变为 bound
    const retried = await w.runRebind();
    expect(retried).toEqual({ rules: 3, bound: 3, unresolved: [] });
    for (const entry of created) {
      expect(await auditCount(w, REBIND_ACTION, entry.rule.id)).toBe(1);
    }
  });
});
