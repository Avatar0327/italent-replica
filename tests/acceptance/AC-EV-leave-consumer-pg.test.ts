/** DEC-447：多实例判重、不同 kind 的慢处理器不阻塞其他员工，必须在真实 PG 上交错。 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { runEmploymentOutboxConsumer } from '../../apps/api/src/modules/employment/outbox-consumer.js';
import {
  maybeStartLeaveConsumerScheduler,
  registerLeaveConsumer,
} from '../../apps/api/src/modules/evaluation/leave-consumer.js';
import { leaveConsumerWorld, signal, testConsumer } from './AC-EV-leave-consumer-support.js';
import { rowsOf } from './AC-EMP-F055-support.js';
import { withRelease } from './support/pg-interleave.js';

const database = useTestDb();
describe.skipIf(!process.env.TEST_DATABASE_URL)('AC-EV-leave-consumer 真 PG', () => {
  it('同 kind 两个实例竞争同一事件，只回调一次', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-pg-dedupe');
    const consumer = testConsumer();
    await w.enqueue(consumer.kind);
    const entered = signal();
    const release = signal();
    const handle = vi.fn<typeof consumer.handle>(async () => {
      entered.resolve();
      await release.promise;
      return { state: 'done', reason: null };
    });
    const run = () => runEmploymentOutboxConsumer(w.db, w.tenantId, { ...consumer, handle });
    const first = run();
    await entered.promise;
    const second = run();
    await withRelease(
      () => release.resolve(),
      async (cleanup) => {
        [first, second].forEach((request) => cleanup.track<unknown>(request));
        await vi.waitFor(
          async () => {
            const [waiting] = rowsOf<{ n: number }>(
              await w.db.execute(sql`SELECT count(*)::int AS n
          FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`),
            );
            expect(waiting!.n).toBeGreaterThan(0);
          },
          { timeout: 8000 },
        );
        release.resolve();
        const results = await Promise.all([first, second]);
        expect(results.reduce((sum, result) => sum + result.done, 0)).toBe(1);
        expect(handle).toHaveBeenCalledTimes(1);
        expect(await w.queue(consumer.kind)).toMatchObject([{ state: 'done', attempts: 1 }]);
      },
      [first, second],
    );
  });

  it('慢 kind 持锁期间，另一个 kind 的其他员工继续处理且后续 tick 不重入', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-pg-independent');
    const slow = testConsumer();
    const healthy = testConsumer();
    const person = await w.hired('独立处理员工');
    const next = await w.leave('2026-10-05', person.employee.id);
    await w.enqueue(slow.kind);
    await w.enqueue(healthy.kind, next);
    const entered = signal();
    const release = signal();
    const slowHandle = vi.fn<typeof slow.handle>(async () => {
      entered.resolve();
      await release.promise;
      return { state: 'done', reason: null };
    });
    const unregister = [registerLeaveConsumer({ ...slow, handle: slowHandle }), registerLeaveConsumer(healthy)];
    const scheduler = maybeStartLeaveConsumerScheduler(w.db, { LEAVE_CONSUMER_INTERVAL_MS: '20' });
    try {
      await entered.promise;
      await vi.waitFor(async () => expect(await w.queue(healthy.kind)).toMatchObject([{ state: 'done' }]));
      await new Promise((done) => setTimeout(done, 60));
      expect(slowHandle).toHaveBeenCalledTimes(1);
      expect(healthy.handle).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await scheduler!.stop();
      for (const dispose of unregister) dispose();
    }
  });
});
