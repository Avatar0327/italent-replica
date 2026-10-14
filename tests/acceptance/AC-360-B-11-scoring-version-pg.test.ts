/**
 * PR #125 第 3 轮 P2-3（真实 PG 确定性交错）：修改已使用套卷权重的请求先开始、在套卷锁上等待；其间另一请求停用活动、
 * 按旧权重计分并生成报告；编辑最后取得锁合法提交。报告必须失效（列表“已过期”、查看 409），不能按等锁之前的时间
 * 判定“计分口径未变”而继续给出旧分数。门事务只持有套卷的共享锁：挡住编辑的行锁，不挡停用计分对套卷的共享读锁。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { world360 } from './AC-360-support.js';
import { edit, editContent, enable, questionnaireOf, signal, waitLockWaiters } from './AC-360-F053-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('PR #125 第 3 轮 P2-3 真实 PG：套卷改权重 × 停用计分', () => {
  it('编辑等锁期间活动停用、计分并生成报告；编辑提交后报告失效', async () => {
    const w = await world360(testDb().db, 'b11-version');
    const f = await questionnaireOf(w, true);
    await w.ok(await enable(w, f.activity.id));
    const reached = signal();
    const release = signal();
    const gate = withTenant(w.db, w.tenantId, async (tx) => {
      await tx.execute(sql`SELECT id FROM survey360_questionnaires WHERE id = ${f.q.id}::uuid FOR SHARE`);
      reached.resolve();
      await release.promise;
    });
    let editing: Promise<Response> | undefined;
    try {
      await reached.promise;
      editing = edit(w, f.q.id, editContent(w, 3)); // 编辑先开始，等套卷行锁
      await waitLockWaiters(w.db, 1);
      w.setNow('2026-10-01T02:00:00Z'); // 停用计分、生成报告都在编辑开始之后
      await w.transition(f.activity.id, 'disable');
      const path = `/activities/${f.activity.id}/reports`;
      await w.ok(w.request('POST', `${path}/generate`, { idempotencyKey: crypto.randomUUID(), body: {} }));
      release.resolve();
      const edited = await editing;
      expect(edited.status, await edited.clone().text()).toBe(200);
      const [row] = (await w.ok<{ items: { id: string; status: string }[] }>(w.request('GET', path))).items;
      expect(row!.status).toBe('outdated');
      const view = await w.request('GET', `${path}/${row!.id}`);
      expect(view.status).toBe(409);
    } finally {
      release.resolve();
      await Promise.allSettled([gate, ...(editing ? [editing] : [])]);
    }
  });
});
