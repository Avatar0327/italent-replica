/**
 * PR #125 第 2 轮自检（F-053 锁顺序 活动 → 套卷）：已使用套卷改权重要让用到它的活动的报告失效（第 2 轮 P2-7）。
 * 若在套卷编辑里（已持有套卷行锁）再去写活动 / 评价对象行，顺序变成 套卷 → 活动，与活动启用（活动 → 套卷）反向
 * 等待 → PG 死锁，一个合法命令被回滚。确定性交错：门事务先持有套卷，编辑先排队，再让启用排队，释放门后两边都应成功。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { world360 } from './AC-360-support.js';
import {
  edit,
  editContent,
  enable,
  holdQuestionnaire,
  questionnaireOf,
  waitLockWaiters,
} from './AC-360-F053-support.js';

const testDb = useTestDb();

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'PR #125 第 2 轮 P2-7 / F-053 真实 PG：套卷编辑 × 活动启用',
  () => {
    it('已使用套卷改权重与重新启用用到它的活动交错：都成功，没有死锁牺牲者', async () => {
      const w = await world360(testDb().db, 'b09-lock');
      const f = await questionnaireOf(w, true);
      const gate = holdQuestionnaire(w, f.q.id);
      let editing: Promise<Response> | undefined;
      let enabling: Promise<Response> | undefined;
      try {
        await gate.reached.promise;
        editing = edit(w, f.q.id, editContent(w, 3)); // 编辑先排队：等套卷锁
        await waitLockWaiters(w.db, 1);
        enabling = enable(w, f.activity.id); // 启用随后：先锁活动，再等套卷锁
        await waitLockWaiters(w.db, 2);
        gate.release.resolve();
        const [edited, started] = await Promise.all([editing, enabling]);
        expect(edited.status, '编辑被当成死锁牺牲者回滚：' + (await edited.clone().text())).toBe(200);
        expect(started.status, '启用被当成死锁牺牲者回滚：' + (await started.clone().text())).toBe(200);
      } finally {
        gate.release.resolve();
        await Promise.allSettled([gate.promise, ...(editing ? [editing] : []), ...(enabling ? [enabling] : [])]);
      }
    });
  },
);
