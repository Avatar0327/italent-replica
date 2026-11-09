/**
 * R2-T09a 职责转交：菜单覆盖与“第 5 次落账”的真 PG 强制交错（F-454⑥；F-448 R1 云端 Sol 建议的屏障式专项）。
 * 记次（countAttempt）与菜单提交都先取同一被转交人的参与人锁，再锁记录行，所以两条路径只会整体先后，不会交叉：
 * - 覆盖先持锁：记次取参与人锁时报 busy，本轮不记；覆盖提交后 attempt_count 是 0、没有被误落 EXECUTION_ERROR；
 * - 落账先持锁：覆盖在参与人锁上等待，放行后看到记录 revision 已变，409 要求刷新；刷新后重提成功并清零预算。
 * 交错靠屏障（promise 门 + pg_stat_activity 的真实锁等待）控制，不靠睡眠；只在真 PG 上跑（PGlite 单连接排不出交错）。
 * 普通角色（app_owner）下同样通过：读写租户数据都在对应租户的 withTenant 里。
 */
import './support/exit-gate-enforced.js';
import { sql, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_USER_ID } from '../../apps/api/src/system-actor.js';
import type * as AuditRecord from '../../apps/api/src/audit/record.js';
import { rowsOf } from '../../apps/api/src/modules/employment/read-model.js';
import type * as TransferLocks from '../../apps/api/src/modules/employment/transfer-locks.js';
import type * as DutyExecution from '../../apps/api/src/modules/transfer/linkage/duty-execution.js';
import { menuWorld, subordinateItem } from './AC-DT-menu-support.js';

interface Gate {
  readonly reached: Promise<void>;
  readonly release: () => void;
}

/** 一道屏障：被测代码走到这里先报到（reached），等测试放行（release）才继续。 */
function gate(): Gate & { arrive: () => Promise<void> } {
  let reach: () => void = () => undefined;
  let open: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const passed = new Promise<void>((resolve) => (open = resolve));
  return {
    reached,
    release: open,
    arrive: () => {
      reach();
      return passed;
    },
  };
}

const hooks = vi.hoisted(() => ({
  /** 被转交人 ID：到期执行时它的转交抛非业务异常，走“整人回滚 → 记次”。 */
  faulty: null as string | null,
  /** 为真时，到期执行取参与人锁就抛非业务异常（整人级步骤出错，定位不到具体记录）。 */
  failRunLock: false,
  /** 记次（调度身份的第 2 次取参与人锁）在真正取锁之前停下。 */
  beforeCountLock: null as null | (() => Promise<void>),
  /** 记次取到参与人锁之后、锁记录行之前停下。 */
  afterCountLock: null as null | (() => Promise<void>),
  /** 菜单覆盖写完记录、写审计时停下（此时覆盖事务仍持有参与人锁和记录行锁）。 */
  onReschedule: null as null | (() => Promise<void>),
  schedulerLockCalls: new Map<string, number>(),
}));

vi.mock('../../apps/api/src/modules/transfer/linkage/duty-execution.js', async (importOriginal) => {
  const original = await importOriginal<typeof DutyExecution>();
  return {
    ...original,
    executeDutyItem: (...args: Parameters<typeof original.executeDutyItem>) => {
      if (hooks.faulty === args[2].employeeId) throw new Error('合成故障：连接中断');
      return original.executeDutyItem(...args);
    },
  };
});

vi.mock('../../apps/api/src/modules/employment/transfer-locks.js', async (importOriginal) => {
  const original = await importOriginal<typeof TransferLocks>();
  return {
    ...original,
    lockTransferParticipants: async (...args: Parameters<typeof original.lockTransferParticipants>) => {
      const [, ctx, employeeId] = args;
      if (hooks.faulty !== employeeId || ctx.userId !== SYSTEM_USER_ID)
        return original.lockTransferParticipants(...args);
      // 调度身份对该人的第 1 次取锁 = 到期执行，第 2 次 = 记次（F-454：记次也先取参与人锁）。
      const calls = (hooks.schedulerLockCalls.get(employeeId) ?? 0) + 1;
      hooks.schedulerLockCalls.set(employeeId, calls);
      if (calls === 1 && hooks.failRunLock) throw new Error('合成故障：取参与人锁失败');
      if (calls === 2) await hooks.beforeCountLock?.();
      const result = await original.lockTransferParticipants(...args);
      if (calls === 2) await hooks.afterCountLock?.();
      return result;
    },
  };
});

// 覆盖在写完记录之后写审计：service.ts 内部直接调自己的 auditRecord，替身挂不上，所以挂在它调用的 recordAudit 上。
vi.mock('../../apps/api/src/audit/record.js', async (importOriginal) => {
  const original = await importOriginal<typeof AuditRecord>();
  return {
    ...original,
    recordAudit: async (...args: Parameters<typeof original.recordAudit>) => {
      if (args[1].action === 'duty_transfer.menu.rescheduled') await hooks.onReschedule?.();
      return original.recordAudit(...args);
    },
  };
});

const database = useTestDb();
const LATER = '2026-10-20';
const ERROR_ATTEMPTS = 5;

/**
 * 轮询 PG 里是否真有事务在等锁（超时即失败，不无限挂住）。可取消：竞速结束后调用 stop() 并等轮询退出，
 * 不让它跨入后续用例或数据库清理阶段（第 1 轮审查 P3-2）。seen 为 false 表示被取消。
 */
function pollLockWait(db: Db) {
  let cancelled = false;
  const seen = (async () => {
    const deadline = Date.now() + 8000;
    while (!cancelled && Date.now() < deadline) {
      const [waiting] = rowsOf<{ n: number }>(
        await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'`),
      );
      if (waiting!.n > 0) return true;
      await new Promise((done) => setTimeout(done, 10));
    }
    if (cancelled) return false;
    throw new Error('未观测到真实锁等待');
  })();
  return {
    seen,
    stop: async () => {
      cancelled = true;
      await seen.catch(() => undefined);
    },
  };
}

/** 等到真的有事务在 PG 里等锁。 */
async function waitForLockWait(db: Db) {
  await pollLockWait(db).seen;
}

/** 屏障到不了（比如被测代码没有按预期取锁）时，用确定的断言失败代替整个文件挂住。 */
async function reachedWithin(passed: Promise<void>, what: string) {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`未走到屏障：${what}`)), 15000);
    void passed.then(() => clearTimeout(timer));
  });
  await Promise.race([passed, timeout]);
}

/** 一名被转交人 + 一条第 4 次异常之后的到期转交（再来一次非业务异常就是第 5 次）。 */
async function atFifthAttempt(label: string) {
  const x = await menuWorld(database().db, label);
  const subordinate = await x.subordinateOf(x.employee.id, '下属');
  const receiver = await x.peer('接收人');
  const other = await x.peer('新接收人');
  const saved = await x.submitted(x.employee.id, {
    timing: 'scheduled',
    transferDate: LATER,
    items: [subordinateItem(subordinate.id, receiver.id)],
  });
  const recordId = saved.records[0]!.id;
  await x.sqlRows(sql`UPDATE duty_transfer_records SET attempt_count=${ERROR_ATTEMPTS - 1}
    WHERE tenant_id=${x.session.tenant.id} AND id=${recordId}::uuid RETURNING id`);
  const revision = (await x.duties(x.employee.id)).items[0]!.pending!.revision;
  const override = (withRevision: number) =>
    x.submit(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, other.id, withRevision)],
    });
  return { x, subordinate, receiver, other, recordId, revision, override };
}

type World = Awaited<ReturnType<typeof atFifthAttempt>>;

/**
 * 旧执行在 revision=旧值时抛非业务异常回滚 → 补记事务取锁前停下 → 菜单覆盖（跨日请求，转交日期仍已到）完整提交
 * → 放行补记。覆盖是新提交：新 revision 的 attempt_count / last_attempt_at 必须保持清零，旧异常不能算到它头上。
 */
async function expectStaleFailureNotCounted(
  x: World['x'],
  recordId: string,
  revision: number,
  override: World['override'],
  arm: () => void,
) {
  const counting = gate();
  arm();
  hooks.beforeCountLock = counting.arrive;
  try {
    const scheduler = x.runScheduler(`${LATER}T02:00:00Z`);
    await reachedWithin(counting.reached, '补记取参与人锁之前（旧执行已回滚）');
    const response = await override(revision);
    expect(response.status, await response.clone().text()).toBe(200);
    counting.release();
    await scheduler;
  } finally {
    counting.release();
    reset();
  }
  const [row] = await x.sqlRows<{ revision: number; attempts: number; lastAttemptAt: string | null }>(sql`
    SELECT revision, attempt_count AS attempts, last_attempt_at::text AS "lastAttemptAt"
    FROM duty_transfer_records WHERE tenant_id=${x.session.tenant.id} AND id=${recordId}::uuid`);
  expect(row).toEqual({ revision: revision + 1, attempts: 0, lastAttemptAt: null });
  expect(await x.ledger(recordId)).toEqual({ attempts: 0, failure: null, status: 0 });
}

function reset() {
  hooks.faulty = null;
  hooks.failRunLock = false;
  hooks.beforeCountLock = null;
  hooks.afterCountLock = null;
  hooks.onReschedule = null;
  hooks.schedulerLockCalls.clear();
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('F-454 真 PG：菜单覆盖 vs 第 5 次落账（屏障式）', () => {
  it('覆盖先持锁：第 5 次落账的记次取参与人锁被占用而让路，覆盖提交后预算清零、不被误落 EXECUTION_ERROR', async () => {
    const { x, subordinate, other, recordId, revision, override } = await atFifthAttempt('barrier-override-first');
    const counting = gate();
    const rescheduling = gate();
    hooks.faulty = x.employee.id;
    hooks.beforeCountLock = counting.arrive;
    hooks.onReschedule = rescheduling.arrive;
    try {
      // 1. 到期执行抛非业务异常整人回滚，走到记次取锁前停下
      const scheduler = x.runScheduler(`${LATER}T02:00:00Z`);
      await reachedWithin(counting.reached, '记次取参与人锁之前');
      // 2. 菜单覆盖抢先拿到参与人锁和记录行锁，写完记录停在审计上
      const overriding = override(revision);
      await reachedWithin(
        Promise.race([
          rescheduling.reached,
          overriding.then(async (early) => {
            throw new Error(`菜单覆盖提前返回 ${early.status}：${await early.clone().text()}`);
          }),
        ]),
        '菜单覆盖写审计',
      );
      // 3. 放行记次：它要先取参与人锁，被覆盖占着，skipLocked 让路（不阻塞在记录行锁上）
      counting.release();
      const lockWait = pollLockWait(database().db);
      let outcome: 'finished' | 'blocked' | 'cancelled';
      try {
        outcome = await Promise.race([
          scheduler.then(() => 'finished' as const),
          lockWait.seen.then((seen) => (seen ? ('blocked' as const) : ('cancelled' as const))),
        ]);
      } finally {
        await lockWait.stop(); // 竞速结束（无论谁赢、是否抛错）就停掉轮询并等它退出
      }
      expect(outcome, '记次应在参与人锁上让路，而不是阻塞等覆盖的记录行锁').toBe('finished');
      // 4. 放行覆盖
      rescheduling.release();
      const response = await overriding;
      expect(response.status, await response.clone().text()).toBe(200);
      await scheduler;
    } finally {
      rescheduling.release();
      counting.release();
      reset();
    }
    expect(await x.ledger(recordId)).toEqual({ attempts: 0, failure: null, status: 0 });
    const [record] = (await x.records('tab=pending')).items;
    expect(record).toMatchObject({ id: recordId, receiverId: other.id, status: 0, failure: null });
    expect(await x.managerOf(subordinate.id, LATER)).toBe(x.employee.id);
  });

  it('落账先持锁：覆盖在参与人锁上等待，放行后看到记录已变而 409；刷新重提成功并清零预算', async () => {
    const { x, recordId, other, revision, override } = await atFifthAttempt('barrier-settle-first');
    const locked = gate();
    hooks.faulty = x.employee.id;
    hooks.afterCountLock = locked.arrive;
    let scheduler: Promise<unknown> | undefined;
    try {
      // 1. 记次拿到参与人锁，停在锁记录行之前
      scheduler = x.runScheduler(`${LATER}T02:00:00Z`);
      await reachedWithin(locked.reached, '记次取到参与人锁之后');
      // 2. 菜单覆盖（带落账前的 revision）在参与人锁上真实等待
      let answered = false;
      const overriding = override(revision).then((response) => {
        answered = true;
        return response;
      });
      await waitForLockWait(database().db);
      expect(answered).toBe(false);
      // 3. 放行：记次把第 5 次落成 EXECUTION_ERROR 并提交，覆盖随后拿到锁
      locked.release();
      await scheduler;
      const stale = await overriding;
      expect(await x.reason(stale)).toMatchObject({
        status: 409,
        code: 'REVISION_CONFLICT',
        reason: 'DUTY_TRANSFER_STALE',
      });
    } finally {
      locked.release();
      await scheduler;
      reset();
    }
    expect(await x.ledger(recordId)).toEqual({ attempts: ERROR_ATTEMPTS, failure: 'EXECUTION_ERROR', status: 0 });

    // 4. 刷新后带新 revision 重提：覆盖清空失败原因并清零预算
    const fresh = (await x.duties(x.employee.id)).items[0]!.pending!;
    expect(fresh.recordId).toBe(recordId);
    const retry = await override(fresh.revision);
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await x.ledger(recordId)).toEqual({ attempts: 0, failure: null, status: 0 });
    expect((await x.records('tab=pending')).items[0]).toMatchObject({ receiverId: other.id, failure: null });
  });

  it('旧执行回滚 → 跨日覆盖完整提交 → 放行补记：旧异常不得扣新提交的预算（P2-1）', async () => {
    const { x, recordId, revision, override } = await atFifthAttempt('barrier-stale-failure');
    await expectStaleFailureNotCounted(x, recordId, revision, override, () => {
      hooks.faulty = x.employee.id;
    });
  });

  it('整人口径同理：取锁出错后、补记前被跨日覆盖，只给锁后仍是出错时 revision 的记录记次', async () => {
    const { x, recordId, revision, override } = await atFifthAttempt('barrier-stale-person');
    await expectStaleFailureNotCounted(x, recordId, revision, override, () => {
      hooks.faulty = x.employee.id;
      hooks.failRunLock = true;
    });
  });
});
