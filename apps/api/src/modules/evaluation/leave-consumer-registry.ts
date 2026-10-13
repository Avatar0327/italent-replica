/**
 * DEC-447：独立离职消费者注册协议。生产登记在 leave-consumer.ts，server.ts 无需再次改动。
 * kind 对应 ev_sync_queue.handler；启动前完成注册，启动时取快照；未注册的 kind 原样留在队列。
 */
import type { Db } from '@italent/db';
import { startEmploymentOutboxConsumer, type EmploymentOutboxConsumer } from '../employment/outbox-consumer.js';

const consumers = new Map<string, EmploymentOutboxConsumer>();

export function registerLeaveConsumer(consumer: EmploymentOutboxConsumer): () => void {
  if (consumer.kind === 'qualification_sync') throw new Error('资格同步使用独立的原有启动入口');
  if (consumers.has(consumer.kind)) throw new Error(`离职消费者 kind 重复登记：${consumer.kind}`);
  consumers.set(consumer.kind, consumer);
  return () => {
    consumers.delete(consumer.kind);
  };
}

/** 与资格同步同风格：默认开启，off 关闭，默认间隔 5000ms；无处理器时不建定时器。 */
export function maybeStartLeaveConsumerScheduler(db: Db, env: Readonly<Record<string, string | undefined>>) {
  if (env.LEAVE_CONSUMER_SCHEDULER === 'off' || consumers.size === 0) return null;
  // 每个 kind 独立计时与防重入，慢处理器、失败或积压不占用其他 kind 的轮次 / 批量名额。
  const schedulers = [...consumers.values()].map((consumer) =>
    startEmploymentOutboxConsumer(db, consumer, Number(env.LEAVE_CONSUMER_INTERVAL_MS || 5000)),
  );
  return {
    async stop() {
      await Promise.all(schedulers.map((scheduler) => scheduler.stop()));
    },
  };
}
