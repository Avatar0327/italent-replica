/** DEC-431① / F-261：按实际事务登记后续任务，保存点不等于提交，消费不能重入原事务的锁。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from './client.js';
import type { Tx } from './tenant-context.js';

type Effect = () => Promise<void>;
type TenantScope = { tenantId: string; run: (task: Effect) => Promise<void> };
type BeforeCommitBatch = {
  payloads: unknown[];
  flush: (tx: Tx, payloads: unknown[]) => Promise<void>;
  scope?: TenantScope;
};
/** F-326-L §3.3：事务内已持有的行锁模式；键由调用方定（变量 id 全局唯一）。 */
export type HeldLockMode = 'share' | 'update';
type Frame = {
  db: Db;
  effects: Map<string, Effect>;
  beforeCommit: Map<string, BeforeCommitBatch>;
  /** 本层（根事务或保存点）新取的行锁；保存点成功并入外层，回滚则丢弃（PostgreSQL 回滚保存点即释放其锁） */
  locks: Map<string | undefined, Map<string, HeldLockMode>>;
  parent?: Frame;
  scope?: TenantScope;
  open: boolean;
};
// 透明代理也能访问原句柄的事务槽位；保存点仍有独立槽位。
const frameKey = Symbol('transactionFrame');
type TrackedTx = Tx & { [frameKey]?: Frame };
const frameOf = (tx: Tx) => (tx as TrackedTx)[frameKey];
const draining = new AsyncLocalStorage<Map<string, Effect>[]>();

function appendBeforeCommit(frame: Frame, key: string, batch: BeforeCommitBatch) {
  const previous = frame.beforeCommit.get(key);
  if (previous && previous.scope?.tenantId !== batch.scope?.tenantId) {
    throw new Error('同键提交前任务必须属于同一租户上下文');
  }
  frame.beforeCommit.set(key, {
    ...batch,
    payloads: previous ? previous.payloads.concat(batch.payloads) : batch.payloads,
  });
}

/** 平台命令只在租户路径内登记该租户的提交前任务，根事务收尾时重新进入同一权限上下文。 */
export async function withTransactionTenantScope<T>(
  tx: Tx,
  tenantId: string,
  run: TenantScope['run'],
  fn: () => Promise<T>,
): Promise<T> {
  const frame = frameOf(tx);
  if (!frame?.open) throw new Error('租户上下文必须登记在当前有效事务内');
  const previous = frame.scope;
  frame.scope = { tenantId, run };
  try {
    return await fn();
  } finally {
    frame.scope = previous;
  }
}

/** F-326-L §2.3：同键负载汇总到根事务提交前；同一 key 的调用方使用相同的负载类型与处理器。 */
export function beforeTransactionCommit<T>(
  tx: Tx,
  key: string,
  payload: T,
  flush: (tx: Tx, payloads: T[]) => Promise<void>,
) {
  const frame = frameOf(tx);
  if (!frame?.open) throw new Error('提交前任务必须登记在当前有效事务内');
  appendBeforeCommit(frame, key, {
    scope: frame.scope,
    payloads: [payload],
    flush: (current, payloads) => flush(current, payloads as T[]),
  });
}

function recordLock(frame: Frame, tenantId: string | undefined, key: string, mode: HeldLockMode) {
  let locks = frame.locks.get(tenantId);
  if (!locks) {
    locks = new Map();
    frame.locks.set(tenantId, locks);
  }
  if (mode === 'update' || !locks.has(key)) locks.set(key, mode);
}

/**
 * F-326-L §3.3 锁台账：同一事务（含其保存点）内已持有的行锁。取锁入口据此判断“只重入已持有的子集、不 SHARE→UPDATE 升级”，
 * 违反时由调用方抛程序错误，整个事务回滚（fail-closed）。台账与提交前任务同在事务槽位上，必须登记在受管理的事务内。
 */
export function transactionLockLedger(tx: Tx) {
  const frame = frameOf(tx);
  if (!frame?.open) throw new Error('锁台账必须登记在当前有效事务内');
  // 同一平台事务可遍历多个租户。RLS 下各租户行集合互斥，各自仍受一次取锁约束。
  const tenantId = frame.scope?.tenantId;
  return {
    /** 当前事务链上持有的最强模式；update 压过 share。 */
    held(key: string): HeldLockMode | undefined {
      let found: HeldLockMode | undefined;
      for (let level: Frame | undefined = frame; level; level = level.parent) {
        const mode = level.locks.get(tenantId)?.get(key);
        if (mode === 'update') return mode;
        found ??= mode;
      }
      return found;
    },
    empty(): boolean {
      for (let level: Frame | undefined = frame; level; level = level.parent) {
        if (level.locks.get(tenantId)?.size) return false;
      }
      return true;
    },
    record(key: string, mode: HeldLockMode) {
      recordLock(frame, tenantId, key, mode);
    },
  };
}

/** 必须登记在受管理的事务上；新入口遗漏事务包装时直接拒绝写入，不能静默留下未消费任务。 */
export function afterTransactionCommit(tx: Tx, key: string, effect: (db: Db) => Promise<void>) {
  const frame = frameOf(tx);
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
    const frame: Frame = {
      db: root,
      effects: new Map(),
      beforeCommit: new Map(),
      locks: new Map(),
      parent,
      scope: parent?.scope,
      open: true,
    };
    const result = await transaction(async (tx) => {
      Object.defineProperty(tx, frameKey, { value: frame, configurable: true });
      trackTransactionCommits(tx, root, frame);
      try {
        const result = await fn(tx);
        // F-326-L §2.3：flush 仍在驱动事务内，抛错交给驱动回滚主体及所有提交前写入。
        if (!parent) {
          for (const batch of frame.beforeCommit.values()) {
            const flush = () => batch.flush(tx, batch.payloads);
            if (batch.scope) await batch.scope.run(flush);
            else await flush();
          }
        }
        return result;
      } finally {
        frame.open = false;
        delete (tx as TrackedTx)[frameKey];
      }
    }, config);
    // 抛错/ROLLBACK（含保存点回滚）不会到达这里；成功保存点只向外层传递登记。
    if (parent) {
      for (const [key, batch] of frame.beforeCommit) appendBeforeCommit(parent, key, batch);
      for (const [key, effect] of frame.effects) parent.effects.set(key, effect);
      for (const [tenantId, locks] of frame.locks)
        for (const [key, mode] of locks) recordLock(parent, tenantId, key, mode);
    } else await consume(frame.effects);
    return result;
  };
  return db;
}
