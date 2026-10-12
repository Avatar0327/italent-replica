/** AC-EV-leave-consumer-bootstrap：DEC-447 启动登记与共享 outbox 协议契约。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maybeStartLeaveConsumerScheduler,
  registerLeaveConsumer,
} from '../../apps/api/src/modules/evaluation/leave-consumer-registry.js';
import { runEmploymentOutboxConsumer } from '../../apps/api/src/modules/employment/outbox-consumer.js';
import { runQualificationSync } from '../../apps/api/src/modules/qualification/sync-worker.js';
import { leaveConsumerWorld, testConsumer } from './AC-EV-leave-consumer-support.js';

const database = useTestDb();
const clock = () => new Date('2026-10-10T05:00:00Z');
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('AC-EV-leave-consumer-bootstrap 注册与独立开关', () => {
  it('未注册时不启动；同 kind 重复注册被拒绝；资格同步保留原入口', () => {
    expect(maybeStartLeaveConsumerScheduler(database().db, {})).toBeNull();
    const consumer = testConsumer();
    cleanups.push(registerLeaveConsumer(consumer));
    expect(() => registerLeaveConsumer(consumer)).toThrow('重复');
    expect(() => registerLeaveConsumer(testConsumer('qualification_sync'))).toThrow('资格同步');
  });

  it('off 不消费；默认开启且不依赖资格同步开关；停止后不再消费', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-start');
    const consumer = testConsumer();
    cleanups.push(registerLeaveConsumer(consumer));
    await w.enqueue(consumer.kind);
    const before = await w.queue(consumer.kind);
    expect(maybeStartLeaveConsumerScheduler(w.db, { LEAVE_CONSUMER_SCHEDULER: 'off' })).toBeNull();
    expect(await w.queue(consumer.kind)).toEqual(before);
    expect(consumer.handle).not.toHaveBeenCalled();

    const started = maybeStartLeaveConsumerScheduler(w.db, {
      QUALIFICATION_SYNC_SCHEDULER: 'off',
      LEAVE_CONSUMER_INTERVAL_MS: '20',
    });
    expect(started).not.toBeNull();
    try {
      await vi.waitFor(async () => expect(await w.queue(consumer.kind)).toMatchObject([{ state: 'done' }]));
    } finally {
      await started!.stop();
    }
    expect(consumer.handle).toHaveBeenCalledTimes(1);
    const person = await w.hired('停止后员工');
    const next = await w.leave('2026-10-05', person.employee.id);
    await w.enqueue(consumer.kind, next);
    await new Promise((done) => setTimeout(done, 80));
    expect(await w.queue(consumer.kind)).toContainEqual({
      state: 'pending',
      attempts: 0,
      reason: null,
      recordId: next,
    });
    expect(consumer.handle).toHaveBeenCalledTimes(1);
  });
});

describe('AC-EV-leave-consumer-bootstrap 按 kind 分派与协议复用', () => {
  it('各 kind 只处理自己的队列，未知 kind 保持原样；资格同步回执独立', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-kinds');
    // 生产 evaluation_leave 会为本文件其他租户自动入队；契约探针使用独立 kind 保持用例隔离。
    const consumers = [testConsumer('leave_test_evaluation'), testConsumer('leave_test_second')];
    for (const consumer of consumers) {
      cleanups.push(registerLeaveConsumer(consumer));
      await w.enqueue(consumer.kind);
    }
    await w.enqueue('unregistered_kind');
    const unknown = await w.queue('unregistered_kind');
    const qualification = await w.queue('qualification_sync');
    const started = maybeStartLeaveConsumerScheduler(w.db, {});
    try {
      await vi.waitFor(async () => {
        for (const consumer of consumers)
          expect(await w.queue(consumer.kind)).toEqual([
            { state: 'done', attempts: 1, reason: null, recordId: w.recordId },
          ]);
      });
    } finally {
      await started!.stop();
    }
    for (const consumer of consumers) {
      expect(consumer.handle).toHaveBeenCalledTimes(1);
      expect(consumer.handle).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: w.tenantId, commandId: expect.stringContaining(consumer.commandPrefix) }),
        expect.objectContaining({ recordId: w.recordId }),
        expect.objectContaining({ id: w.recordId, kind: 'leave', employeeId: w.subject.employee.id }),
      );
    }
    expect(await w.queue('unregistered_kind')).toEqual(unknown);
    expect(await w.queue('qualification_sync')).toEqual(qualification);
    await runQualificationSync(w.db, w.tenantId, { clock });
    expect(await w.queue('qualification_sync')).toContainEqual({
      state: 'skipped',
      attempts: 1,
      reason: 'KIND_NOT_SYNCED',
      recordId: w.recordId,
    });
    expect(await w.queue('leave_test_evaluation')).toMatchObject([{ state: 'done', attempts: 1 }]);
  });

  it('失败保存点回滚、错误码与退避重试；同一事件重复入队与重复消费不重复回调', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-retry');
    const consumer = testConsumer();
    await w.enqueue(consumer.kind);
    await w.enqueue(consumer.kind);
    const failedHandle = vi.fn<typeof consumer.handle>(async (tx) => {
      await tx.execute(sql`UPDATE ev_sync_queue SET reason='不应提交'
        WHERE tenant_id=${w.tenantId} AND handler='qualification_sync'`);
      throw new Error('测试处理器失败');
    });
    const qualification = await w.queue('qualification_sync');
    const result = await runEmploymentOutboxConsumer(
      w.db,
      w.tenantId,
      { ...consumer, handle: failedHandle },
      { clock },
    );
    expect(result).toMatchObject({ failed: 1 });
    expect(await w.queue('qualification_sync')).toEqual(qualification);
    expect(await w.queue(consumer.kind)).toMatchObject([{ state: 'failed', attempts: 1 }]);
    expect((await w.queue(consumer.kind))[0]!.reason).not.toContain('测试处理器失败');
    expect(await runEmploymentOutboxConsumer(w.db, w.tenantId, consumer, { clock })).toMatchObject({ picked: 0 });
    const retry = { clock: () => new Date('2026-10-10T05:01:01Z') };
    expect(await runEmploymentOutboxConsumer(w.db, w.tenantId, consumer, retry)).toMatchObject({ done: 1 });
    expect(await runEmploymentOutboxConsumer(w.db, w.tenantId, consumer, retry)).toMatchObject({ picked: 0 });
    expect(await w.queue(consumer.kind)).toMatchObject([{ state: 'done', attempts: 2, reason: null }]);
    expect(consumer.handle).toHaveBeenCalledTimes(1);
  });

  it('未来记录到期前不回调；删除后复核为 skipped；另一租户的队列保持 pending', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-due');
    const other = await leaveConsumerWorld(database().db, 'leaveboot-other');
    const consumer = testConsumer();
    await other.enqueue(consumer.kind);
    const person = await w.hired('未来离职员工');
    const future = await w.leave('2026-10-19', person.employee.id);
    await w.enqueue(consumer.kind, future);
    expect(await runEmploymentOutboxConsumer(w.db, w.tenantId, consumer, { clock })).toMatchObject({ picked: 0 });
    await w.remove(future);
    expect(await runEmploymentOutboxConsumer(w.db, w.tenantId, consumer, { clock })).toMatchObject({ skipped: 1 });
    expect(await w.queue(consumer.kind)).toMatchObject([{ state: 'skipped', reason: 'RECORD_NOT_EFFECTIVE' }]);
    expect(await other.queue(consumer.kind)).toMatchObject([{ state: 'pending', attempts: 0 }]);
    expect(consumer.handle).not.toHaveBeenCalled();
  });

  it('失败 kind 的积压不占另一个 kind 的批量名额', async () => {
    const w = await leaveConsumerWorld(database().db, 'leaveboot-fair');
    const failed = testConsumer('leave_test_failed');
    const healthy = testConsumer();
    await w.enqueue(failed.kind);
    await w.enqueue(healthy.kind);
    await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO ev_sync_queue
      (tenant_id, handler, dedupe_key, outbox_id, employee_id, record_id, next_attempt_at)
      SELECT tenant_id, handler, 'backlog-' || n::text, outbox_id, employee_id, record_id, next_attempt_at
      FROM ev_sync_queue CROSS JOIN generate_series(1, 101) n
      WHERE tenant_id=${w.tenantId} AND handler=${failed.kind}`),
    );
    cleanups.push(
      registerLeaveConsumer({
        ...failed,
        handle: async () => {
          throw new Error('测试失败');
        },
      }),
    );
    cleanups.push(registerLeaveConsumer(healthy));
    const started = maybeStartLeaveConsumerScheduler(w.db, {});
    try {
      await vi.waitFor(async () => expect(await w.queue(healthy.kind)).toMatchObject([{ state: 'done' }]));
    } finally {
      await started!.stop();
    }
    expect(healthy.handle).toHaveBeenCalledTimes(1);
    expect((await w.queue(failed.kind)).every((row) => row.state === 'failed')).toBe(true);
  });
});
