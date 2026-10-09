/**
 * 同步端口替身的事务与锁（《R3-T04/T05 同步协议》SP-09 / SP-11 的三个事务边界）：
 * - 每个事务只记自己的撤销日志，失败只回滚本事务写过的键，不覆盖其他已提交事务（替代整状态快照回滚）；
 * - 写同一个键之前必须持有它的 X 锁（严格两阶段：锁到事务结束才放），所以撤销时不会和别的事务的写入交叉；
 * - 消费记录按 S / X 锁等待：执行页 assertExecutionActive 取 S，接管 / 终止 / 完成 / 取代取 X，冲突时挂起等待对方结束。
 * 方法收到的若不是本替身开的事务（调用方没有开事务），按单语句自动提交执行。
 */
import type { Tx } from '@italent/db';

const TX = Symbol('memoryTx');

export interface MemoryTx {
  readonly id: number;
  readonly undo: (() => void)[];
  readonly locks: Set<string>;
  /** 本事务已作为执行页断言或写过执行页回执：完成只能在独立终结事务里做（SP-11 第 3 个边界）。 */
  page: boolean;
}

type Mode = 'S' | 'X';

export class MemoryTransactions {
  private seq = 0;
  private readonly held = new Map<string, { mode: Mode; holders: Set<number> }>();
  private waiters: (() => void)[] = [];

  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const tx: MemoryTx = { id: ++this.seq, undo: [], locks: new Set(), page: false };
    try {
      const result = await work({ [TX]: tx } as unknown as Tx);
      this.end(tx);
      return result;
    } catch (error) {
      for (const undo of tx.undo.reverse()) undo();
      this.end(tx);
      throw error;
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

  /** 事务内写一个键：记下旧值供本事务回滚（调用方须已持有该键所属的 X 锁）。 */
  set<K, V>(tx: MemoryTx, map: Map<K, V>, key: K, value: V): void {
    const had = map.has(key);
    const previous = map.get(key);
    tx.undo.push(() => (had ? map.set(key, previous as V) : map.delete(key)));
    map.set(key, value);
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
