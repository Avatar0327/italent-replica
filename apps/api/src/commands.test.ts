/**
 * 并发败者路径的确定性测试：PGlite 是单连接，两个事务无法真正交错，
 * 所以直接验证“失败后回查台账”的判定（真 PG 下 AC-TEN-03 的并发用例会走到这条路径）。
 */
import { commandLedger, createTenant, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { commandHash, replayAfterFailure } from './commands.js';
import { AppError } from './errors.js';

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
