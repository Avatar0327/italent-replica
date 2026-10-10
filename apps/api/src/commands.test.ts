/**
 * 并发败者路径的确定性测试：PGlite 是单连接，两个事务无法真正交错，
 * 所以直接验证“失败后回查台账”的判定（真 PG 下 AC-TEN-03 的并发用例会走到这条路径）。
 */
import { commandLedger, createTenant, createUser, type Db, eq, sql, type Tx, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { commandHash, replayAfterFailure, runCommand } from './commands.js';
import { AppError } from './errors.js';
import { SYSTEM_USER_ID } from './system-actor.js';

const testDb = useTestDb();
const userId = '00000000-0000-4000-8000-0000000000a1';
const fingerprint = { op: 'override', key: 'audit.retention', expectedRevision: 0, value: 1 };

describe('命令失败后回查台账（结果未知先回查，DEC-067）', () => {
  let tenantId: string;
  const loserError = new AppError('REVISION_CONFLICT', '败者在行锁后看到 revision 已变');

  beforeAll(async () => {
    const { db } = testDb();
    const meta = { actorUserId: null, commandId: 'seed-cmd-t' };
    tenantId = (await createTenant(db, { code: 'cmd-t', name: '命令租户' }, meta)).id;
    await withTenant(db, tenantId, (tx) =>
      tx.insert(commandLedger).values({
        tenantId,
        commandId: 'cmd-won',
        requestHash: commandHash(userId, fingerprint),
        responseStatus: 200,
        responseBody: { revision: 1 },
      }),
    );
  });

  it('先提交者已记录同键同内容 → 败者重放其响应，而不是返回 409', async () => {
    const key = { commandId: 'cmd-won', requestHash: commandHash(userId, fingerprint) };
    await expect(replayAfterFailure(testDb().db, tenantId, key, loserError)).resolves.toEqual({
      status: 200,
      body: { revision: 1 },
    });
  });

  it('同键异内容 → IDEMPOTENCY_CONFLICT', async () => {
    const key = { commandId: 'cmd-won', requestHash: commandHash(userId, { ...fingerprint, value: 2 }) };
    await expect(replayAfterFailure(testDb().db, tenantId, key, loserError)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('台账里没有该命令 → 原样抛出原错误', async () => {
    const key = { commandId: 'cmd-lost', requestHash: commandHash(userId, fingerprint) };
    await expect(replayAfterFailure(testDb().db, tenantId, key, loserError)).rejects.toBe(loserError);
  });
});

/**
 * R1-T16 失败命令三类审计中“结果未知”与“存储不可写”的判定（AGENTS.md §10「审计」）：提交阶段连接中断时无法确知
 * 是否已提交——回查台账也没有记录时记为结果未知，并以 503 RESULT_UNKNOWN 提示客户端按原命令 ID 回查后再决定是否重提。
 */
describe('失败命令审计：结果未知 / 存储不可写', () => {
  let tenantId: string;
  let actor: string;
  const ctx = () => ({ tenantId, userId: actor, timezone: 'Asia/Shanghai' });
  const ROLLBACK = new Error('test rollback');
  const connectionLost = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });

  beforeAll(async () => {
    const meta = { actorUserId: null, commandId: 'seed-cmd-failure' };
    tenantId = (await createTenant(testDb().db, { code: 'cmd-failure', name: '失败命令租户' }, meta)).id;
    const user = { email: 'cmd-failure@example.com', displayName: '失败命令操作人' };
    actor = (await createUser(testDb().db, user, { ...meta, commandId: 'seed-user-failure' })).id;
  });

  /** 第一次事务执行完回调后回滚，再向调用方报告连接中断——模拟“提交请求已发出、结果没有回来”。 */
  function lostCommit(db: Db): Db {
    let first = true;
    const wrapper = Object.create(db) as Db;
    wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
      if (!first) return db.transaction(fn);
      first = false;
      await db
        .transaction(async (tx) => {
          await fn(tx);
          throw ROLLBACK;
        })
        .catch((error: unknown) => {
          if (error !== ROLLBACK) throw error;
        });
      throw connectionLost();
    }) as Db['transaction'];
    return wrapper;
  }

  async function failureOf(commandId: string) {
    return withTenant(testDb().db, tenantId, async (tx) => {
      const result = await tx.execute(sql`SELECT outcome, error_code AS "errorCode", actor_user_id AS "actor"
        FROM audit_command_failures WHERE command_id=${commandId}`);
      return Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
    });
  }

  it('提交阶段连接中断且台账查无记录 → 503 RESULT_UNKNOWN，记一条「结果未知」', async () => {
    const command = { id: 'cmd-unknown', fingerprint, execute: async () => ({ status: 200 as const, body: {} }) };
    await expect(runCommand(lostCommit(testDb().db), ctx(), command)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'RESULT_UNKNOWN', commandId: 'cmd-unknown' },
    });
    expect(await failureOf('cmd-unknown')).toEqual([{ outcome: 'unknown', errorCode: 'ECONNRESET', actor }]);
  });

  it('执行阶段连接中断（尚未提交，服务端必然回滚）→ 存储不可写', async () => {
    const command = {
      id: 'cmd-storage',
      fingerprint,
      execute: async () => {
        throw connectionLost();
      },
    };
    await expect(runCommand(testDb().db, ctx(), command)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { reason: 'STORAGE_UNWRITABLE' },
    });
    expect(await failureOf('cmd-storage')).toEqual([{ outcome: 'storage_unwritable', errorCode: 'ECONNRESET', actor }]);
  });

  it('只读事务写入（25006）→ 存储不可写；系统任务的失败操作人记为空', async () => {
    const command = {
      id: 'cmd-readonly',
      fingerprint,
      execute: async (tx: Tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        await tx.insert(commandLedger).values({
          tenantId,
          commandId: 'never',
          requestHash: 'x',
          responseStatus: 200,
          responseBody: {},
        });
        return { status: 200 as const, body: {} };
      },
    };
    await expect(runCommand(testDb().db, { ...ctx(), userId: SYSTEM_USER_ID }, command)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(await failureOf('cmd-readonly')).toEqual([
      { outcome: 'storage_unwritable', errorCode: '25006', actor: null },
    ]);
  });

  it('业务错误（AppError）原样返回，记为业务失败', async () => {
    const command = {
      id: 'cmd-business',
      fingerprint,
      execute: async () => {
        throw new AppError('VALIDATION_FAILED', '合成的业务校验失败', { reason: 'SYNTHETIC' });
      },
    };
    await expect(runCommand(testDb().db, ctx(), command)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await failureOf('cmd-business')).toEqual([
      { outcome: 'business_failed', errorCode: 'VALIDATION_FAILED', actor },
    ]);
  });
});

/**
 * #199 第 3 轮（DEC-338⑤ / DEC-385③ 改结构）：返回台账结果的路径只有一个出口。直接重放与失败后回查都先经过
 * guard.before（当前权限），命中台账后再经过 guard.replayed（结果可见性），才把结果交给调用方；首次执行也从同一个
 * 入口进 guard.before。不传 guard 的调用方行为与改动前逐字相同（下方对照组）。
 */
describe('台账出口统一守卫（CommandGuard）', () => {
  let tenantId: string;
  let actor: string;
  const ctx = () => ({ tenantId, userId: actor, timezone: 'Asia/Shanghai' });
  const loserError = new AppError('REVISION_CONFLICT', '败者在行锁后看到 revision 已变');
  const denied = () => new AppError('NOT_FOUND', '当前权限已看不到');
  const stored = { status: 201 as const, body: { id: 'won', revision: 1 } };

  beforeAll(async () => {
    const meta = { actorUserId: null, commandId: 'seed-cmd-guard' };
    tenantId = (await createTenant(testDb().db, { code: 'cmd-guard', name: '台账出口租户' }, meta)).id;
    const user = { email: 'cmd-guard@example.com', displayName: '台账出口操作人' };
    actor = (await createUser(testDb().db, user, { ...meta, commandId: 'seed-user-guard' })).id;
  });

  const seedLedger = (commandId: string, fp: unknown = fingerprint) =>
    withTenant(testDb().db, tenantId, (tx) =>
      tx.insert(commandLedger).values({
        tenantId,
        commandId,
        requestHash: commandHash(actor, fp),
        responseStatus: stored.status,
        responseBody: stored.body,
      }),
    );
  const keyOf = (commandId: string) => ({ commandId, requestHash: commandHash(actor, fingerprint) });

  /** 记录调用顺序的守卫；deny 指定哪一步拒绝。 */
  function recordingGuard(deny?: 'before' | 'replayed') {
    const calls: string[] = [];
    return {
      calls,
      guard: {
        before: async () => {
          calls.push('before');
          if (deny === 'before') throw denied();
        },
        replayed: async (_tx: Tx, result: { body: unknown }) => {
          calls.push(`replayed:${JSON.stringify(result.body)}`);
          if (deny === 'replayed') throw denied();
        },
      },
    };
  }

  it('失败后回查命中台账：先 before 再 replayed，通过才返回结果', async () => {
    await seedLedger('g-fail-ok');
    const { calls, guard } = recordingGuard();
    await expect(replayAfterFailure(testDb().db, tenantId, keyOf('g-fail-ok'), loserError, guard)).resolves.toEqual(
      stored,
    );
    expect(calls).toEqual(['before', `replayed:${JSON.stringify(stored.body)}`]);
  });

  it('失败后回查：当前权限已撤（before 拒绝）→ 抛守卫的错误，不返回台账结果', async () => {
    await seedLedger('g-fail-before');
    const { guard } = recordingGuard('before');
    await expect(
      replayAfterFailure(testDb().db, tenantId, keyOf('g-fail-before'), loserError, guard),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('失败后回查：结果对象已不可见（replayed 拒绝）→ 抛守卫的错误，不返回台账结果', async () => {
    await seedLedger('g-fail-replayed');
    const { guard } = recordingGuard('replayed');
    await expect(
      replayAfterFailure(testDb().db, tenantId, keyOf('g-fail-replayed'), loserError, guard),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('失败后回查台账里没有：守卫通过时原样抛出原错误，不调用 replayed', async () => {
    const { calls, guard } = recordingGuard();
    await expect(replayAfterFailure(testDb().db, tenantId, keyOf('g-fail-none'), loserError, guard)).rejects.toBe(
      loserError,
    );
    expect(calls).toEqual(['before']);
  });

  /**
   * 败者交错的确定性模拟（PGlite 单连接，两个事务无法真正交错）：第一个事务（主事务）开始前把先提交者的台账行移走，
   * 回滚后再放回。于是主事务查不到台账、执行撞上冲突回滚，随后的回查一定能看到台账——即“失败后回查”出口。
   */
  function loserDb(db: Db, commandId: string): Db {
    let first = true;
    const wrapper = Object.create(db) as Db;
    wrapper.transaction = (async (fn: Parameters<Db['transaction']>[0]) => {
      if (!first) return db.transaction(fn);
      first = false;
      const [row] = await withTenant(db, tenantId, (tx) =>
        tx.delete(commandLedger).where(eq(commandLedger.commandId, commandId)).returning(),
      );
      try {
        return await db.transaction(fn);
      } finally {
        if (row) await withTenant(db, tenantId, (tx) => tx.insert(commandLedger).values(row));
      }
    }) as Db['transaction'];
    return wrapper;
  }
  const failing = (id: string, guard?: unknown) => ({
    id,
    fingerprint,
    ...(guard ? { guard } : {}),
    execute: async (): Promise<never> => {
      throw loserError;
    },
  });

  it('runCommand 执行失败后走回查出口：撤权时不返回先提交者的结果', async () => {
    await seedLedger('g-run-loser');
    let round = 0;
    const guard = {
      before: async () => {
        round += 1;
        if (round > 1) throw denied();
      },
      replayed: async () => undefined,
    };
    const command = failing('g-run-loser', guard) as Parameters<typeof runCommand>[2];
    await expect(runCommand(loserDb(testDb().db, 'g-run-loser'), ctx(), command)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(round).toBe(2);
  });

  it('runCommand 执行失败后走回查出口：结果已不可见（replayed 拒绝）时同样不返回', async () => {
    await seedLedger('g-run-hidden');
    const { calls, guard } = recordingGuard('replayed');
    const command = failing('g-run-hidden', guard) as Parameters<typeof runCommand>[2];
    await expect(runCommand(loserDb(testDb().db, 'g-run-hidden'), ctx(), command)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(calls).toEqual(['before', 'before', `replayed:${JSON.stringify(stored.body)}`]);
  });

  it('首次执行与直接重放都只经过一次 before（同一守卫入口）', async () => {
    const first = recordingGuard();
    const command = (guard: typeof first.guard) => ({
      id: 'g-entry',
      fingerprint,
      guard,
      execute: async () => stored,
    });
    await expect(runCommand(testDb().db, ctx(), command(first.guard))).resolves.toEqual(stored);
    expect(first.calls).toEqual(['before']);
    const again = recordingGuard();
    await expect(runCommand(testDb().db, ctx(), command(again.guard))).resolves.toEqual(stored);
    expect(again.calls).toEqual(['before', `replayed:${JSON.stringify(stored.body)}`]);
  });

  describe('对照：不传 guard 的调用方行为不变', () => {
    it('首次执行写台账，直接重放返回首次结果且不再执行', async () => {
      let executed = 0;
      const command = {
        id: 'plain-replay',
        fingerprint,
        execute: async () => {
          executed += 1;
          return stored;
        },
      };
      await expect(runCommand(testDb().db, ctx(), command)).resolves.toEqual(stored);
      await expect(runCommand(testDb().db, ctx(), command)).resolves.toEqual(stored);
      expect(executed).toBe(1);
    });

    it('同键异内容 → IDEMPOTENCY_CONFLICT', async () => {
      await seedLedger('plain-conflict', { other: true });
      const command = { id: 'plain-conflict', fingerprint, execute: async () => stored };
      await expect(runCommand(testDb().db, ctx(), command)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('执行失败后回查命中先提交者 → 重放其结果（败者路径）', async () => {
      await seedLedger('plain-loser');
      const command = failing('plain-loser') as Parameters<typeof runCommand>[2];
      await expect(runCommand(loserDb(testDb().db, 'plain-loser'), ctx(), command)).resolves.toEqual(stored);
    });

    it('执行失败且台账查无 → 原样抛出业务错误', async () => {
      const command = {
        id: 'plain-fail',
        fingerprint,
        execute: async () => {
          throw loserError;
        },
      };
      await expect(runCommand(testDb().db, ctx(), command)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    });
  });
});
