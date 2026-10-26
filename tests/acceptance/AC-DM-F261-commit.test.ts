/** F-261：事务提交出口的重入、故障隔离及保存点边界。 */
import { afterTransactionCommit, sql, withPlatform, type Tx } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it, vi } from 'vitest';

const database = useTestDb();
it('AC-DM-F261：消费者引出的已提交任务排在当前消费后，不递归重入', async () => {
  const db = database().db;
  const events: string[] = [];
  await withPlatform(db, async (tx) => {
    afterTransactionCommit(tx, 'first', async (root) => {
      expect(root).toBe(db);
      events.push('first-start');
      await withPlatform(root, async (next) => {
        afterTransactionCommit(next, 'second', async () => {
          events.push('second');
        });
        events.push('second-transaction');
      });
      expect(events).toEqual(['committing', 'first-start', 'second-transaction']);
      events.push('first-end');
    });
    await tx.execute(sql`SELECT 1`);
    events.push('committing');
  });
  expect(events).toEqual(['committing', 'first-start', 'second-transaction', 'first-end', 'second']);
});

it('AC-DM-F261：消费者故障保留已提交结果并继续其他任务，同事务同键只消费一次', async () => {
  const events: string[] = [];
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const receipt = await withPlatform(database().db, async (tx) => {
      afterTransactionCommit(tx, 'broken', async () => {
        throw new Error('合成消费者故障');
      });
      afterTransactionCommit(tx, 'deduplicated', async () => {
        events.push('overwritten');
      });
      await tx.transaction(async (child) => {
        afterTransactionCommit(child, 'deduplicated', async () => {
          events.push('once');
        });
      });
      return { committed: true };
    });
    expect(receipt).toEqual({ committed: true });
    expect(events).toEqual(['once']);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({
      type: 'transaction.after-commit.pending-recovery',
      key: 'broken',
    });
  } finally {
    log.mockRestore();
  }
});

it('AC-DM-F261：事务提交后不能再登记，失败保存点不覆盖父事务已登记的同键任务', async () => {
  let closed!: Tx;
  const events: string[] = [];
  await withPlatform(database().db, async (tx) => {
    closed = tx;
    afterTransactionCommit(tx, 'same-key', async () => {
      events.push('parent');
    });
    await expect(
      tx.transaction(async (child) => {
        afterTransactionCommit(child, 'same-key', async () => {
          events.push('rolled-back');
        });
        throw new Error('合成保存点回滚');
      }),
    ).rejects.toThrow('合成保存点回滚');
    expect(events).toEqual([]);
  });
  expect(events).toEqual(['parent']);
  expect(() => afterTransactionCommit(closed, 'late', async () => undefined)).toThrow('当前有效事务');
});
