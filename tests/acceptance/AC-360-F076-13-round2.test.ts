/**
 * AC-360-F076-13（F-076 PR-1 第 1 轮审查 P2-1～P2-3 与 P3）：
 * - P2-1 UUID 表示统一：大写 X-Tenant-Id 发出的邀请，维护任务（库里取小写）也能解封发放；
 * - P2-2 运维命令并发幂等：rotate 同版本并发只留一条 key_retired / key_rotated；retire 同一运行并发由持久进度推进；
 * - P2-3 密钥版本防回退：已登记轮换到 k2 后，CURRENT 回到 k1 的进程不得发放，启动校验同样拒绝；
 * - P3：哑摘要预热与损坏摘要仍做一次 KDF、rotate 的 previous 取已登记版本、清理 DELETE 有批量上限。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { pgErrorCode, useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import {
  assertNoKeyRollback,
  runCredentialMaintenance,
} from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { retireKeys, rotateKeys } from '../../apps/api/src/modules/survey360/credential-ops.js';
import {
  dummyDigest,
  kdfCallCount,
  resetKdfCallCount,
  verifyPassword,
} from '../../apps/api/src/modules/survey360/credentials.js';
import { openSealed, sealJson } from '../../apps/api/src/modules/survey360/secret-box.js';
import { key, sceneB } from './AC-360-B-support.js';
import { BASE } from './AC-360-support.js';
import {
  addSession,
  invitations,
  linkRows,
  portalCredentials,
  resetCredentialConfig,
  rowsOf,
  securityEvents,
  setCredential,
} from './AC-360-F076-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());
const at = (iso: string) => () => new Date(iso);
const FAST = { N: 1024, r: 8, p: 1 };
const known = new Map<number, Buffer>();
function configure(versions: number[], current: number, extra: { retired?: number[] } = {}) {
  for (const v of versions) if (!known.has(v)) known.set(v, randomBytes(32));
  portalCredentials(true, {
    credentialKeys: new Map(versions.map((v) => [v, known.get(v)!])),
    currentVersion: current,
    retiredVersions: new Set(extra.retired ?? []),
    compromisedVersions: new Set(),
    kdf: FAST,
  });
  return credentialConfig();
}

describe('AC-360-F076-13 P2-1 UUID 表示统一', () => {
  it('封装与解封在边界统一规范化：大写 / 小写的租户与 outbox 标识互通', () => {
    const config = { outboxKeys: new Map([['a', randomBytes(32)]]), outboxCurrent: 'a' };
    const [tenantId, outboxId] = [randomUUID(), randomUUID()];
    const eventType = 'survey360.answer_invitation';
    const sealed = sealJson(config, { token: 'T' }, { tenantId: tenantId.toUpperCase(), outboxId, eventType });
    expect(openSealed(config, sealed, { tenantId, outboxId: outboxId.toUpperCase(), eventType })).toEqual({
      token: 'T',
    });
    // 规范化不能放松绑定：换成另一个标识仍解不开
    expect(() => openSealed(config, sealed, { tenantId: randomUUID(), outboxId, eventType })).toThrow();
  });

  it('大写 X-Tenant-Id 重发邀请：请求成功，维护任务照常发放（不再 WRITE_FAILED）', async () => {
    portalCredentials(true, { kdf: FAST });
    const s = await sceneB(testDb().db, 'f076-13a');
    const { w } = s;
    await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: at('2026-10-01T02:00:00Z') });
    w.setNow('2026-10-01T05:00:00Z');
    const res = await w.api.request('POST', `${BASE}${s.path}/invitations`, {
      user: w.admin,
      tenant: w.tenantId.toUpperCase(),
      idempotencyKey: key(),
      body: { personIds: [s.person.X.id] },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const report = await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: at('2026-10-01T06:00:00Z') });
    expect(report).toMatchObject({ issued: 1, conflicts: 0 });
    const [latest] = (await linkRows(w, s.activity.id)).filter((l) => l.person_id === s.person.X.id && !l.revoked);
    expect(latest).toMatchObject({ credential_state: 'issued', credential_error: null });
    const mails = await invitations(w);
    expect(mails.at(-1)!.state).toBe('pending');
    expect(mails.at(-1)!.secrets.serial).toBeTruthy();
  });
});

describe('AC-360-F076-13 P2-2 运维命令并发幂等', () => {
  it('rotate 同一版本并发：每租户只有一条 key_rotated；库里也不允许重复', async () => {
    const s = await sceneB(testDb().db, 'f076-13b');
    const { w } = s;
    const cfg = configure([1, 2], 2);
    const results = await Promise.all([
      rotateKeys(w.db, { to: 2, config: cfg }),
      rotateKeys(w.db, { to: 2, config: cfg }),
    ]);
    // rotate 对全部租户各写一条（同文件前面的用例也建了租户）：两个并发命令合计恰好每租户一条
    expect(results.reduce((n, r) => n + r.written, 0)).toBe(results[0]!.tenants);
    expect(await securityEvents(w, 'key_rotated')).toHaveLength(1);
    const duplicate = await withTenant(w.db, w.tenantId, (tx) =>
      tx.execute(sql`INSERT INTO survey360_security_events (tenant_id, kind, credential_key_version, occurred_at)
        VALUES (${w.tenantId}::uuid, 'key_rotated', 2, now())`),
    ).then(
      () => undefined,
      (error: unknown) => pgErrorCode(error),
    );
    expect(duplicate).toBe('23505');
  });

  it('计划退役：同一运行 ID 两个进程同时跑，处理 5 条、只有一条 key_retired 且数量与持久进度一致', async () => {
    configure([1], 1);
    const s = await sceneB(testDb().db, 'f076-13c');
    const { w } = s;
    await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: at('2026-10-01T02:00:00Z') });
    const cfg = configure([2], 2, { retired: [1] });
    const runId = randomUUID();
    const input = {
      tenantId: w.tenantId,
      version: 1,
      compromised: false,
      config: cfg,
      batchSize: 1,
      resumeRunId: runId,
    };

    const [a, b] = await Promise.all([retireKeys(w.db, input), retireKeys(w.db, input)]);

    expect(a.tenants[0]).toMatchObject({ status: 'done', credentials: 5 });
    expect(b.tenants[0]).toMatchObject({ status: 'done', credentials: 5 });
    const done = await securityEvents(w, 'key_retired');
    expect(done).toHaveLength(1);
    expect(done[0]!.detail).toMatchObject({ credentials: 5, sessions: 0 });
    const revoked = await securityEvents(w, 'credential_revoked');
    expect(revoked.reduce((n, e) => n + (e.detail['credentials'] as number), 0)).toBe(5);
  });

  it('泄露处置：同一运行并发，会话数也按持久进度记一次（10）', async () => {
    configure([1], 1);
    const s = await sceneB(testDb().db, 'f076-13d');
    const { w } = s;
    const links = await linkRows(w, s.activity.id);
    for (const link of links) {
      await setCredential(w, link.id, { state: 'issued', version: 1 });
      await addSession(w, link.id, `${link.id}-1`);
      await addSession(w, link.id, `${link.id}-2`);
    }
    const cfg = configure([2], 2, { retired: [1] });
    portalCredentials(true, { ...cfg, compromisedVersions: new Set([1]) });
    const runId = randomUUID();
    const input = {
      tenantId: w.tenantId,
      version: 1,
      compromised: true,
      config: credentialConfig(),
      batchSize: 2,
      resumeRunId: runId,
    };
    const [a, b] = await Promise.all([retireKeys(w.db, input), retireKeys(w.db, input)]);
    expect([a.tenants[0]!.sessions, b.tenants[0]!.sessions]).toEqual([10, 10]);
    const done = await securityEvents(w, 'key_retired');
    expect(done).toHaveLength(1);
    expect(done[0]!.detail).toMatchObject({ credentials: 5, sessions: 10 });
    expect(
      rowsOf<{ n: number }>(
        await withTenant(w.db, w.tenantId, (tx) =>
          tx.execute(sql`SELECT count(*)::int AS n FROM survey360_answer_sessions WHERE revoked_at IS NULL`),
        ),
      )[0]!.n,
    ).toBe(0);
  });
});

describe('AC-360-F076-13 P2-3 密钥版本防回退', () => {
  it('已登记轮换到 k2 后 CURRENT 回到 k1：维护任务拒绝发放、启动校验拒绝；回到 k2 恢复', async () => {
    configure([1, 2], 2);
    const s = await sceneB(testDb().db, 'f076-13e');
    const { w } = s;
    await rotateKeys(w.db, { to: 2, config: credentialConfig() });

    const rolledBack = configure([1, 2], 1);
    await expect(runCredentialMaintenance(w.db, { tenantId: w.tenantId, config: rolledBack })).rejects.toThrow(/回退/);
    await expect(assertNoKeyRollback(w.db, rolledBack)).rejects.toThrow(/回退/);
    expect((await linkRows(w, s.activity.id)).every((l) => l.credential_state === 'pending')).toBe(true);

    const current = configure([1, 2], 2);
    await expect(assertNoKeyRollback(w.db, current)).resolves.toBeUndefined();
    expect((await runCredentialMaintenance(w.db, { tenantId: w.tenantId, config: current })).issued).toBe(5);
    expect((await linkRows(w, s.activity.id)).every((l) => l.credential_key_version === 2)).toBe(true);
  });
});

describe('AC-360-F076-13 P3', () => {
  it('损坏的摘要串也做一次 KDF（各失败分支工作量一致）；哑摘要可预热', async () => {
    const secret = randomBytes(32);
    await dummyDigest(FAST);
    resetKdfCallCount();
    expect(await verifyPassword('scrypt$bad', secret, 'ABCD2345')).toBe(false);
    expect(await verifyPassword('', secret, 'ABCD2345')).toBe(false);
    expect(kdfCallCount()).toBe(2);
  });

  it('rotate 的 previous 取已登记的上一版本：k2 移入 RETIRED、保留 k1 后轮换到 k3，记 2 而不是 1', async () => {
    configure([1, 2], 2);
    const s = await sceneB(testDb().db, 'f076-13f');
    const { w } = s;
    await rotateKeys(w.db, { to: 2, config: credentialConfig() });
    await rotateKeys(w.db, { to: 3, config: configure([1, 3], 3, { retired: [2] }) });
    expect(
      (await securityEvents(w, 'key_rotated')).map((e) => [e.credential_key_version, e.detail['previous']]),
    ).toEqual([
      [2, 1],
      [3, 2],
    ]);
  });

  it('维护清理的 DELETE 有批量上限：一轮最多删 cleanupLimit 条，多轮删完', async () => {
    portalCredentials(true, { kdf: FAST });
    const s = await sceneB(testDb().db, 'f076-13g');
    const { w } = s;
    const [link] = await linkRows(w, s.activity.id);
    await withTenant(w.db, w.tenantId, async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        await tx.execute(sql`INSERT INTO survey360_answer_sessions
          (tenant_id, link_id, token_hash, created_at, expires_at)
          VALUES (${w.tenantId}::uuid, ${link!.id}::uuid, ${`old-${i}`}, now() - interval '2 days',
            now() - interval '1 day')`);
        await tx.execute(sql`INSERT INTO survey360_login_throttle
          (tenant_id, scope, key_hash, window_started_at, updated_at)
          VALUES (${w.tenantId}::uuid, 'ip', ${`idle-${i}`}, now() - interval '3 days',
            now() - interval '3 days')`);
      }
    });
    const now = () => new Date(Date.now() + 3_600_000);
    const first = await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: now, cleanupLimit: 2 });
    expect(first.sessionsDeleted).toBe(2);
    expect(first.throttleDeleted).toBe(2);
    const second = await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: now, cleanupLimit: 2 });
    const third = await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: now, cleanupLimit: 2 });
    expect(first.sessionsDeleted + second.sessionsDeleted + third.sessionsDeleted).toBe(5);
    expect(first.throttleDeleted + second.throttleDeleted + third.throttleDeleted).toBe(5);
  });
});
