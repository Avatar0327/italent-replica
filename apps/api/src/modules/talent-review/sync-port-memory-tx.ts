/**
 * 同步端口替身的事务与锁（《R3-T04/T05 同步协议》SP-09 / SP-11 的三个事务边界；第 3 轮 R2-02 / R2-03）：
 * - 写入先暂存在本事务里，提交时一次发布、回滚时直接丢弃：其他事务只读到已提交的数据（与 PostgreSQL 读已提交一致），
 *   回滚不会覆盖别人已提交的结果；
 * - 写任何键之前先取该键的 X 锁（回执行、页证明、健康度行、命令台账各一把），锁到事务结束才放，同键写入互相等待；
 * - 消费记录另有 S / X 锁：执行页 assertExecutionActive 取 S，接管 / 计划 / 终止 / 完成 / 取代取 X；
 * - 读取不取锁，所以不存在读写之间的锁序环；多键写入由调用方按键排序后取锁。
 * 方法收到的若不是本替身开的事务（调用方没有开事务），按单语句自动提交执行。
 */
import type { Tx } from '@italent/db';

const TX = Symbol('memoryTx');

export interface MemoryTx {
  readonly id: number;
  readonly locks: Set<string>;
  /** 本事务暂存的写入：目标表 → 键 → 新值。 */
  readonly writes: Map<Map<unknown, unknown>, Map<unknown, unknown>>;
  /** 本事务已作为执行页断言或写过执行页回执：完成只能在独立终结事务里做（SP-11 第 3 个边界）。 */
  page: boolean;
}

type Mode = 'S' | 'X';

export class MemoryTransactions {
  private seq = 0;
  private readonly held = new Map<string, { mode: Mode; holders: Set<number> }>();
  private waiters: (() => void)[] = [];

  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const tx: MemoryTx = { id: ++this.seq, locks: new Set(), writes: new Map(), page: false };
    try {
      const result = await work({ [TX]: tx } as unknown as Tx);
      for (const [map, writes] of tx.writes) for (const [key, value] of writes) map.set(key, value);
      return result;
    } finally {
      this.end(tx);
    }
  }

  /** 在调用方的事务里执行；调用方没开本替身的事务时自动提交。 */
  within<T>(tx: Tx, work: (m: MemoryTx) => Promise<T>): Promise<T> {
    const current = (tx as unknown as { [TX]?: MemoryTx } | undefined)?.[TX];
    if (current) return work(current);
    return this.run((t) => work((t as unknown as { [TX]: MemoryTx })[TX]));
  }

  /** 取锁：S 与 S 兼容；同一事务可重入，唯一持有者可由 S 升级为 X；冲突时等待持有者结束后重试。 */
  async lock(tx: MemoryTx, key: string, mode: Mode): Promise<void> {
    for (;;) {
      const entry = this.held.get(key);
      if (!entry) {
        this.held.set(key, { mode, holders: new Set([tx.id]) });
        tx.locks.add(key);
        return;
      }
      if (entry.holders.has(tx.id)) {
        if (mode === 'S' || entry.mode === 'X') return;
        if (entry.holders.size === 1) {
          entry.mode = 'X';
          return;
        }
      } else if (mode === 'S' && entry.mode === 'S') {
        entry.holders.add(tx.id);
        tx.locks.add(key);
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** 读一个键：本事务暂存的写入优先，其次是已提交的值。 */
  get<K, V>(tx: MemoryTx, map: Map<K, V>, key: K): V | undefined {
    const writes = tx.writes.get(map as Map<unknown, unknown>);
    return writes?.has(key) ? (writes.get(key) as V) : map.get(key);
  }

  /** 本事务看到的整张表：已提交的值叠加本事务的暂存写入。 */
  view<K, V>(tx: MemoryTx, map: Map<K, V>): Map<K, V> {
    const merged = new Map(map);
    for (const [key, value] of tx.writes.get(map as Map<unknown, unknown>) ?? []) merged.set(key as K, value as V);
    return merged;
  }

  /** 暂存一次写入（调用方须已持有该键的 X 锁），提交时发布。 */
  set<K, V>(tx: MemoryTx, map: Map<K, V>, key: K, value: V): void {
    const target = map as Map<unknown, unknown>;
    if (!tx.writes.has(target)) tx.writes.set(target, new Map());
    tx.writes.get(target)!.set(key, value);
  }

  private end(tx: MemoryTx): void {
    for (const key of tx.locks) {
      const entry = this.held.get(key);
      entry?.holders.delete(tx.id);
      if (entry && entry.holders.size === 0) this.held.delete(key);
    }
    tx.locks.clear();
    const waiting = this.waiters;
    this.waiters = [];
    for (const wake of waiting) wake();
  }
}
