/**
 * F-326-L AC-54 ②（S7e1）：发起与发布互斥（第 6 轮 P2-1，真 PG 强制交错，PGlite 跳过）。
 * 甲在 `lockBoundProcess` 之后、`insertInstance` 之前暂停，乙发布 v2 须阻塞在流程头上；放行后实例绑定 v1，
 * 乙随后完成，X 仍启用（v1 有 1 个在途），推进该实例 → 节点 2 派给 A1。
 * ①（匹配后、加锁前暂停 → 409）与 ③（作废代替发布）要系统停用检测，随 S7e2。
 * 暂停点只由 Vitest 包装已有跨模块函数注入，产品没有钩子状态或默认路径开销（复用 AC-42 的做法）。
 */
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import type * as Lifecycle from '../../apps/api/src/modules/approval/auto-variable-lifecycle.js';
import type { NodeInput } from './AC-APV-support.js';
import { instanceRow } from './AC-APV-F326-S4-support.js';
import {
  autoAt,
  create,
  draftOk,
  manager,
  newVersion,
  publishWith,
  readProcess,
  s4World,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { idleInTransaction, lockWaiters, settledOrBlocked, withRelease } from './support/pg-interleave.js';

const hook = vi.hoisted(() => ({
  step: '',
  id: '',
  reached: Promise.resolve(),
  release: (): void => undefined,
  pause: async (): Promise<void> => undefined,
}));
vi.mock('../../apps/api/src/modules/approval/auto-variable-lifecycle.js', async (original) => {
  const actual = await original<typeof Lifecycle>();
  return {
    ...actual,
    lockBoundProcess: async (...args: Parameters<typeof actual.lockBoundProcess>) => {
      await actual.lockBoundProcess(...args);
      if (hook.step === 'bound' && args[2].processId === hook.id) await hook.pause();
    },
  };
});
const database = useTestDb();
function arm(step: string, id: string) {
  let reached!: () => void;
  hook.step = step;
  hook.id = id;
  hook.reached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    hook.release = resolve;
  });
  hook.pause = async () => {
    hook.step = '';
    reached();
    await gate;
  };
}
const single = (key: string, userId: string): NodeInput => ({ key, name: `节点${key}`, approver: specified(userId) });

async function waitingQuery(db: Db, expected: RegExp) {
  const rows = rowsOf<{ query: string; blockers: number }>(
    await db.execute(sql`SELECT query,cardinality(pg_blocking_pids(pid)) AS blockers FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'`),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.query).toMatch(expected);
  expect(rows[0]!.blockers).toBeGreaterThan(0);
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'AC-APV-F326-54 发起与发布互斥（真 PG 强制交错，PGlite 跳过）',
  () => {
    it('② 甲在 lockBoundProcess 之后暂停：乙发布阻塞在流程头上；放行后实例绑定 v1，乙随后完成，X 仍启用，节点 2 派给 A1', async () => {
      const w = await s4World(database().db, 's7e1-bound-lock');
      const a = await w.publish(await create(w, [single('n1', w.head.userId), single('n2', w.near.userId)]));
      const x = await autoAt(w, a.id, 'n2');
      const v1 = a.currentVersion!.id;
      const draft = await newVersion(w, a);
      const saved = await draftOk(w, draft, [
        single('n1', w.head.userId),
        { key: 'n2', name: '节点n2', approver: manager },
      ]);
      const business = await w.application(w.subject.employeeId, { departmentId: w.staff });

      arm('bound', a.id);
      await withRelease(
        () => hook.release(),
        async (lock) => {
          const first = lock.track(w.submitRaw(business));
          await Promise.race([
            hook.reached,
            first.then(() => {
              throw new Error('lockBoundProcess 暂停点未到达');
            }),
          ]);
          const second = lock.track(publishWith(w, saved));
          expect(await settledOrBlocked(w.db, second, 1)).toBe('blocked');
          await waitingQuery(w.db, /select.*approval_processes.*for update/is);
          hook.release();
          expect((await first).status).toBe(200);
          expect((await second).status).toBe(200);
        },
      );

      const instance = await w.instanceOf(business.id);
      expect((await instanceRow(w, instance.id)).version_id).toBe(v1);
      const after = await readProcess(w, a.id);
      expect(after.currentVersion!.versionNo).toBe(2);
      expect((await varRow(w, x.id)).status).toBe('enabled');
      const task = w.pending(instance)[0]!;
      const done = await w.taskAction(w.head.userId, task.id, 'approve', instance.revision, {});
      expect(done.status, await done.clone().text()).toBe(200);
      const next = w.pending(await w.detail(instance.id));
      expect(next.map((item) => [item.nodeKey, item.assigneeUserId])).toEqual([['n2', w.near.userId]]);
      expect(await lockWaiters(w.db)).toBe(0);
      expect(await idleInTransaction(w.db)).toBe(0);
    });
  },
);
