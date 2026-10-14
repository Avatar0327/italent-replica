/**
 * AC-TR-calc-rule-lock-pg · PR #184 第 1 轮 P2-07：引用校验与写入之间没有锁，校验后、插入计算项目前另一请求删除 / 改名 /
 * 停用字段 → 外键错误 500。保存先按排序后的字段 id 取被引用字段行的共享锁，锁内重新分析，只得到受控的 404 / 400 / 409。
 * 用测试事务持有字段行锁做屏障（真 PG；PGlite 单连接无法并发）。
 */
import { type Db, eq, sql, talentReviewFields, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { CALC_RULES, calcBody, calcItem, calcWorld, pathOf } from './AC-TR-calc-rule-support.js';
import { rowsOf } from './support/f048.js';
import { waitForBlocked } from './support/pg-interleave.js';
import './support/b5-path.js';

const testDb = useTestDb();
const reasonOf = async (response: Response) =>
  ((await response.json()) as { error: { details?: { reason?: string } } }).error.details?.reason;

async function waitingQueries(db: Db) {
  const rows = rowsOf<{ query: string; wait_event: string }>(
    await db.execute(sql`SELECT query, wait_event FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`),
  );
  return rows.map((row) => ({ query: row.query, waitEvent: row.wait_event }));
}
async function ruleCount(db: Db) {
  const [row] = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM talent_review_calc_rules`));
  return Number(row?.n);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('计算规则保存与字段变更 · PostgreSQL 16 锁序', () => {
  /** 测试事务先锁住字段行并改动，保存请求在共享锁处阻塞，事务提交后继续。 */
  async function interleave(
    w: Awaited<ReturnType<typeof calcWorld>>,
    fieldId: string,
    mutate: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<void>,
    request: () => Promise<Response>,
  ) {
    const { pending } = await withTenant(testDb().db, w.as.tenant, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id = ${fieldId}::uuid FOR UPDATE`);
      const pending = request();
      await waitForBlocked(testDb().db, 1);
      // 确实停在“校验之后、写入之前”：等的是被引用字段行上的共享锁（FOR SHARE），此时还没有任何规则落库
      const waiting = await waitingQueries(testDb().db);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]!.query.toLowerCase()).toContain('talent_review_fields');
      expect(waiting[0]!.query.toLowerCase()).toContain('for share');
      expect(waiting[0]!.waitEvent).toMatch(/transactionid|tuple/);
      expect(await ruleCount(testDb().db)).toBe(0);
      await mutate(tx);
      return { pending };
    });
    return pending;
  }

  it('目标字段在校验后被删除：受控 404，不落库、无 500', async () => {
    const w = await calcWorld(testDb().db, 'trk-lock-delete');
    const target = await w.numberField();
    const response = await interleave(
      w,
      target.id,
      async (tx) => void (await tx.delete(talentReviewFields).where(eq(talentReviewFields.id, target.id))),
      () => w.post(calcBody([calcItem(target, '1')])),
    );
    expect(response.status, await response.clone().text()).toBe(404);
    expect((await w.list()).items).toEqual([]);
  });

  it('来源字段在校验后被改名：公式变成未知字段，受控 400，不落库', async () => {
    const w = await calcWorld(testDb().db, 'trk-lock-rename');
    const [target, source] = [await w.numberField(), await w.numberField()];
    const response = await interleave(
      w,
      source.id,
      async (tx) =>
        void (await tx
          .update(talentReviewFields)
          .set({ name: '改过的名称' })
          .where(eq(talentReviewFields.id, source.id))),
      () => w.post(calcBody([calcItem(target, `${pathOf(source)} + 1`)])),
    );
    expect(response.status).toBe(400);
    expect(await reasonOf(response)).toBe('FORMULA_INVALID');
    expect((await w.list()).items).toEqual([]);
  });

  it('目标字段在校验后被停用：受控 400 CALC_TARGET_DISABLED', async () => {
    const w = await calcWorld(testDb().db, 'trk-lock-disable');
    const target = await w.numberField();
    const response = await interleave(
      w,
      target.id,
      async (tx) =>
        void (await tx.update(talentReviewFields).set({ enabled: false }).where(eq(talentReviewFields.id, target.id))),
      () => w.post(calcBody([calcItem(target, '1')])),
    );
    expect([response.status, await reasonOf(response)]).toEqual([400, 'CALC_TARGET_DISABLED']);
  });

  it('保存与真实的字段删除 / 改名并发（各 5 轮）：只有受控结果，没有 500，不留悬空引用', async () => {
    const w = await calcWorld(testDb().db, 'trk-lock-race');
    for (let round = 0; round < 5; round += 1) {
      const [target, source] = [await w.numberField(), await w.numberField()];
      const save = w.post(calcBody([calcItem(target, `${pathOf(source)} + 1`)]));
      const remove = w.request('DELETE', `/fields/${round % 2 === 0 ? source.id : target.id}`, { ifMatch: 1 });
      const rename = w.request('PATCH', `/fields/${source.id}`, { ifMatch: 1, body: { name: `新名称${round}` } });
      const [saved, removed, renamed] = await Promise.all([save, remove, rename]);
      for (const response of [saved, removed, renamed]) {
        expect(response.status, await response.clone().text()).toBeLessThan(500);
      }
      if (saved.status === 201) {
        expect([removed.status, renamed.status].every((status) => status === 409 || status === 200)).toBe(true);
        const fields = (await (await w.request('GET', '/fields?pageSize=200')).json()) as { items: { id: string }[] };
        const rule = (await saved.clone().json()) as { items: { targetFieldId: string }[] };
        expect(fields.items.map((f) => f.id)).toContain(rule.items[0]!.targetFieldId);
      }
    }
    expect(CALC_RULES).toBeTruthy();
  });
});
