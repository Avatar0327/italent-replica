/**
 * 并发败者路径的确定性测试：PGlite 是单连接，两个事务无法真正交错，
 * 所以直接验证“失败后回查台账”的判定（真 PG 下 AC-TEN-03 的并发用例会走到这条路径）。
 */
import { commandLedger, createTenant, createUser, type Db, sql, type Tx, withTenant } from '@italent/db';
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
