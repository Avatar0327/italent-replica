/**
 * F-326-S7a 第 3 轮 P2-1（审查 rf326s7a_2，同类第 2 次 → DEC-385③ 改结构）：重新启用与并发保存交错，不得 SHARE→UPDATE 升级死锁。
 * 场景：流程 A、B 的草稿都引用已发布自动变量 X；管理员已停用 X，随后“重新启用”（持 X 的行锁、尚未提交）。
 *   两个保存的候选筛选都发生在启用提交之前（看到旧的 disabled）→ 旧实现只给 X 取 FOR SHARE，
 *   启用提交后两边都握着 SHARE，收尾再重新筛选（此时 X 已启用）并对 X 申请 FOR UPDATE，互相等待成环。
 * 设计（主设计 §5.5 ③④、F-326-L §3.3）：候选上界与变量当前状态无关，保存开始时一次确定、按 id 升序一批取够；
 *   收尾只在已持锁的集合里重读状态，事务中段对任何变量都不升级。
 * 三方屏障：管理员持锁停在“启用提交前” → 两个保存都已排在 X 的行锁后面（候选筛选已完成）→ 放行；
 *   放行后再让两个保存在“引用校验之后、收尾之前”互相等（最长 1.5 秒），保证旧实现里双方同时握着 SHARE，红是确定的。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { ApproverSource } from '@italent/domain';
import type * as SourceReference from '../../apps/api/src/modules/approval/source-reference.js';
import {
  autoAt,
  counter,
  create,
  newVersion,
  publicVar,
  s4World,
  saveDraft,
  specified,
  varRow,
} from './AC-APV-F326-S7a-support.js';
import { waitForBlocked, withHeldLock, withRelease } from './support/pg-interleave.js';

const barrier = vi.hoisted(() => ({
  target: '',
  arrived: 0,
  both: Promise.resolve(),
  open: (): void => undefined,
}));

vi.mock('../../apps/api/src/modules/approval/source-reference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SourceReference>();
  return {
    ...actual,
    assertSourceReferences: async (...args: Parameters<typeof actual.assertSourceReferences>) => {
      await actual.assertSourceReferences(...args);
      const sources = args[2] as readonly ApproverSource[];
      const mine = barrier.target && barrier.arrived < 2 && sources.some((s) => s.value === barrier.target);
      if (!mine) return;
      barrier.arrived += 1;
      if (barrier.arrived === 2) barrier.open();
      await Promise.race([barrier.both, new Promise((resolve) => setTimeout(resolve, 1500))]);
    },
  };
});

const database = useTestDb();
const realPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe.runIf(realPostgres)('AC-APV-F326-S7a-r3 P2-1 重新启用与并发保存交错不升级锁', () => {
  it('X 被停用后“重新启用”未提交时，A、B 两个保存都排在 X 后面；启用提交后两个都 200，无死锁', async () => {
    const w = await s4World(database().db, 's7a-lock-toggle');
    const a = await w.publish(
      await create(w, [{ key: 'n1', name: '节点n1', approver: specified(w.near.userId) }], { name: 'A流程' }),
    );
    const x = await autoAt(w, a.id, 'n1');
    const b = await w.publish(
      await create(w, [counter([publicVar(x.id)], { key: 'b1' })], { approvalType: 'personnel_change', name: 'B流程' }),
    );
    const draftA = await newVersion(w, a);
    const draftB = await newVersion(w, b);
    // 两份草稿都直接引用 X（“原样保存”）：引用来源在请求里，保存开始就要锁 X
    const nodesA = [{ key: 'n1', name: '节点n1', approver: publicVar(x.id) }];
    const nodesB = [counter([publicVar(x.id)], { key: 'b1' })];

    const touchX = (status: 'disabled' | 'enabled') => (tx: Tx) =>
      tx.execute(sql`UPDATE approval_variables SET status=${status}, revision=revision+1
        WHERE tenant_id=${w.tenant.id}::uuid AND id=${x.id}::uuid`);
    await withTenant(w.db, w.tenant.id, touchX('disabled')); // 管理员已停用（已提交）
    expect((await varRow(w, x.id)).status).toBe('disabled');

    barrier.target = x.id;
    barrier.arrived = 0;
    barrier.both = new Promise<void>((resolve) => (barrier.open = resolve));
    const { savedA, savedB } = await withRelease(
      () => barrier.open(),
      () =>
        withHeldLock(
          {
            run: (fn) => withTenant(w.db, w.tenant.id, fn),
            take: touchX('enabled'), // 重新启用：持 X 的行锁，不提交
          },
          async (admin) => {
            const first = admin.track(saveDraft(w, draftA, nodesA));
            const second = admin.track(saveDraft(w, draftB, nodesB));
            await waitForBlocked(w.db, 2); // 两个保存的候选筛选都已完成，都排在管理员的行锁后面
            await admin.release(); // 启用提交
            return { savedA: await first, savedB: await second };
          },
        ),
    );
    barrier.target = '';

    expect(savedA.status, await savedA.clone().text()).toBe(200);
    expect(savedB.status, await savedB.clone().text()).toBe(200);
    // 两份草稿仍引用 X，所以 X 保持启用（收尾没有误停）
    expect((await varRow(w, x.id)).status).toBe('enabled');
  });
});
