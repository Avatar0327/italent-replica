/** DEC-431① / F-261：按实际事务登记后续任务，保存点不等于提交，消费不能重入原事务的锁。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './client.js';
import type { Tx } from './tenant-context.js';

type Effect = () => Promise<void>;
type BeforeCommitBatch = { payloads: unknown[]; flush: (tx: Tx, payloads: unknown[]) => Promise<void> };
type Frame = {
  db: Db;
  effects: Map<string, Effect>;
  beforeCommit: Map<string, BeforeCommitBatch>;
  open: boolean;
};
const frames = new WeakMap<Tx, Frame>();
const draining = new AsyncLocalStorage<Map<string, Effect>[]>();

function appendBeforeCommit(frame: Frame, key: string, batch: BeforeCommitBatch) {
  const previous = frame.beforeCommit.get(key);
  frame.beforeCommit.set(key, {
    payloads: previous ? previous.payloads.concat(batch.payloads) : batch.payloads,
    flush: batch.flush,
  });
}

/** F-326-L §2.3：同键负载汇总到根事务提交前；同一 key 的调用方使用相同的负载类型与处理器。 */
export function beforeTransactionCommit<T>(
  tx: Tx,
  key: string,
  payload: T,
  flush: (tx: Tx, payloads: T[]) => Promise<void>,
) {
  const frame = frames.get(tx);
  if (!frame?.open) throw new Error('提交前任务必须登记在当前有效事务内');
  appendBeforeCommit(frame, key, {
    payloads: [payload],
    flush: (current, payloads) => flush(current, payloads as T[]),
  });
}

/** 必须登记在受管理的事务上；新入口遗漏事务包装时直接拒绝写入，不能静默留下未消费任务。 */
export function afterTransactionCommit(tx: Tx, key: string, effect: (db: Db) => Promise<void>) {
  const frame = frames.get(tx);
  if (!frame?.open) throw new Error('提交后任务必须登记在当前有效事务内');
  frame.effects.set(key, () => effect(frame.db));
}

async function consume(effects: Map<string, Effect>) {
  if (!effects.size) return;
  const current = draining.getStore();
  if (current) {
    // 后续全局停用也可能产生接管任务：排在当前消费者之后，避免递归/重入。
    current.push(effects);
    return;
  }
  const batches = [effects];
  await draining.run(batches, async () => {
    for (let index = 0; index < batches.length; index++)
      for (const [key, effect] of batches[index]!) {
        try {
          await effect();
        } catch {
          // 业务与持久任务已经提交。失败留给持久队列回查，不改写已提交命令的结果。
          console.error(JSON.stringify({ type: 'transaction.after-commit.pending-recovery', key }));
        }
      }
  });
}

/** 同时覆盖驱动根事务与任意深度保存点；根驱动确认提交并释放锁以后才调用消费者。 */
export function trackTransactionCommits(db: Db, root: Db = db, parent?: Frame): Db {
  const transaction = db.transaction.bind(db);
  db.transaction = async (fn, config) => {
    const frame: Frame = { db: root, effects: new Map(), beforeCommit: new Map(), open: true };
    const result = await transaction(async (tx) => {
      frames.set(tx, frame);
      trackTransactionCommits(tx, root, frame);
      try {
        const result = await fn(tx);
        // F-326-L §2.3：flush 仍在驱动事务内，抛错交给驱动回滚主体及所有提交前写入。
        if (!parent) {
          for (const batch of frame.beforeCommit.values()) await batch.flush(tx, batch.payloads);
        }
        return result;
      } finally {
        frame.open = false;
        frames.delete(tx);
      }
    }, config);
    // 抛错/ROLLBACK（含保存点回滚）不会到达这里；成功保存点只向外层传递登记。
    if (parent) {
      for (const [key, batch] of frame.beforeCommit) appendBeforeCommit(parent, key, batch);
      for (const [key, effect] of frame.effects) parent.effects.set(key, effect);
    } else await consume(frame.effects);
    return result;
  };
  return db;
}
