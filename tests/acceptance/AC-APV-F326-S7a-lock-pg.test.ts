/**
 * F-326-S7a 第 2 轮 P2-1（审查 rf326s7a_1）：两个流程的草稿保存都引用同一条已发布自动变量 X，并发保存不得互等。
 * 旧实现先对被引用变量取 FOR SHARE（assertSourceReferences），保存收尾再对同一行升级为 FOR UPDATE
 * （retireUnreferencedAutoVariables），两个事务各持 SHARE 又互等 UPDATE，PG 检测到死锁后其中一个 500。
 * 设计（主设计 §5.5 ③④、F-326-L §3.3）：涉及的变量行与被引用的变量行合成一批，按 id 升序一次取，事务中段不升级。
 * 交错：在 assertSourceReferences 返回后（SHARE 已到手）让两个保存互相等待，最长等 1.5 秒；
 *   新实现里第二个保存在“一批取锁”处就被第一个挡住，等不到对方、超时后各自成功；旧实现两边都到场，随即成环。
 * PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行。
 */
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
} from './AC-APV-F326-S7a-support.js';
import { withRelease } from './support/pg-interleave.js';

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

describe.runIf(realPostgres)('AC-APV-F326-S7a-r2 P2-1 并发保存引用同一自动变量不互等', () => {
  it('流程 A、B 的草稿同时保存（都引用已发布的 X，内容不变）→ 两个都 200，无死锁', async () => {
    const w = await s4World(database().db, 's7a-lock');
    const a = await w.publish(
      await create(w, [{ key: 'n1', name: '节点n1', approver: specified(w.near.userId) }], { name: 'A流程' }),
    );
    const x = await autoAt(w, a.id, 'n1');
    const b = await w.publish(
      await create(w, [counter([publicVar(x.id)], { key: 'b1' })], { approvalType: 'personnel_change', name: 'B流程' }),
    );
    const draftA = await newVersion(w, a);
    const draftB = await newVersion(w, b);
    const nodesA = [{ key: 'n1', name: '节点n1', approver: specified(w.near.userId) }];
    const nodesB = [counter([publicVar(x.id)], { key: 'b1' })];

    barrier.target = x.id;
    barrier.arrived = 0;
    barrier.both = new Promise<void>((resolve) => (barrier.open = resolve));
    const { savedA, savedB } = await withRelease(
      () => barrier.open(),
      async (lock) => {
        const first = lock.track(saveDraft(w, draftA, nodesA));
        const second = lock.track(saveDraft(w, draftB, nodesB));
        return { savedA: await first, savedB: await second };
      },
    );
    barrier.target = '';

    expect(savedA.status, await savedA.clone().text()).toBe(200);
    expect(savedB.status, await savedB.clone().text()).toBe(200);
  });
});
