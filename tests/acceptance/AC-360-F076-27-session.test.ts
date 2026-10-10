/**
 * AC-360-F076-27～29、31、32、08（F-076 PR-2a，设计 §2.4、§3.8、§4.1、§5.4）：会话签发与登出、登录时密钥迁移、
 * 曾暴露判定（登录侧）、KDF 调用次数（工作量相同）、安全事件生命周期、登录相关位置不落明文。
 */
import { randomBytes } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { kdfCallCount, resetKdfCallCount } from '../../apps/api/src/modules/survey360/credentials.js';
import { configureLoginGate, resetLoginGate } from '../../apps/api/src/modules/survey360/login-gate.js';
import { hashToken } from '../../apps/api/src/modules/survey360/links.js';
import { loginHooks, resetLoginHooks } from '../../apps/api/src/modules/survey360/portal.js';
import { ipKey } from '../../apps/api/src/modules/survey360/throttle.js';
import {
  leakSurface,
  linkRows,
  portalCredentials,
  resetCredentialConfig,
  rowsOf,
  securityEvents,
} from './AC-360-F076-support.js';
import {
  FAST,
  type Cred,
  issuedScene,
  login,
  loginOk,
  loginRaw,
  logout,
  minutes,
  pairRow,
  seedThrottle,
  sessionRows,
  sql1,
  throttleRows,
  wrongPassword,
} from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(() => {
  resetCredentialConfig();
  resetLoginHooks();
  resetLoginGate();
  vi.restoreAllMocks();
});

const keyMap = (...versions: number[]) => new Map(versions.map((v) => [v, randomBytes(32)]));

describe('AC-360-F076-27 会话签发与登出', () => {
  it('会话行只有 link_id 与 8 小时期限；登出后 revoked_at 有值；二次登出 / 无效 / 缺失令牌都 204 且库不变', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-27');
    const cred = creds.get(s.person.P1.id)!;
    const { session, expiresAt } = await loginOk(w, cred);
    const columns = rowsOf<{ column_name: string }>(
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'survey360_answer_sessions'`),
      ),
    ).map((c) => c.column_name);
    expect(columns.sort()).toEqual(
      ['created_at', 'expires_at', 'id', 'link_id', 'revoked_at', 'tenant_id', 'token_hash'].sort(),
    );
    const [row] = await sessionRows(w, cred.linkId);
    expect(new Date(row!.expires_at).toISOString()).toBe(expiresAt);
    expect(await securityEvents(w, 'login_success')).toHaveLength(1);

    const first = await logout(w, session);
    expect(first.status).toBe(204);
    expect((await sessionRows(w, cred.linkId))[0]!.revoked_at).not.toBeNull();
    expect(await securityEvents(w, 'logout')).toHaveLength(1);

    const before = await sessionRows(w);
    for (const token of [session, 'x'.repeat(40), undefined]) {
      expect((await logout(w, token)).status).toBe(204);
    }
    expect((await logout(w, session, { tenant: null })).status).toBe(204);
    expect(await sessionRows(w)).toEqual(before);
    expect(await securityEvents(w, 'logout')).toHaveLength(1);
    expect(hashToken(session)).toBe(row!.token_hash);
  });

  it('同一链接有效会话超过 5 个时作废最早的', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-27b');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 6; i += 1) {
      w.setNow(minutes(i));
      await loginOk(w, cred);
    }
    const rows = await sessionRows(w, cred.linkId);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.revoked_at !== null)).toEqual([true, false, false, false, false, false]);
  });
});

describe('AC-360-F076-28 登录时迁移与计划退役（登录侧）', () => {
  it('k1 凭据在 CURRENT = 2 时登录：201，提交后行 version = 2、集合 {1, 2}，KDF 2 次；迁移后的凭据照常登录', async () => {
    const keys = keyMap(1, 2);
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-28a', {
      credentialKeys: keys,
      currentVersion: 1,
      retiredVersions: new Set(),
      compromisedVersions: new Set(),
    });
    const cred = creds.get(s.person.P1.id)!;
    portalCredentials(true, { kdf: FAST, credentialKeys: keys, currentVersion: 2 });
    resetKdfCallCount();
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
    expect(kdfCallCount()).toBe(2);
    const [row] = (await linkRows(w, s.activity.id)).filter((l) => l.id === cred.linkId);
    expect(row).toMatchObject({ credential_key_version: 2, credential_key_versions: [1, 2] });
    resetKdfCallCount();
    expect((await login(w, cred.serial, cred.password, { ip: '203.0.113.90' })).status).toBe(201);
    expect(kdfCallCount()).toBe(1);
  });

  it('迁移 CAS 失败（期间被重发作废）：登录仍 201，行不变', async () => {
    const keys = keyMap(1, 2);
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-28b', {
      credentialKeys: keys,
      currentVersion: 1,
      retiredVersions: new Set(),
      compromisedVersions: new Set(),
    });
    const cred = creds.get(s.person.P1.id)!;
    portalCredentials(true, { kdf: FAST, credentialKeys: keys, currentVersion: 2 });
    loginHooks.beforeMigration = async () => {
      await sql1(w, sql`UPDATE survey360_links SET revoked = true WHERE id = ${cred.linkId}::uuid`);
    };
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
    const [row] = (await linkRows(w, s.activity.id)).filter((l) => l.id === cred.linkId);
    expect(row).toMatchObject({ credential_key_version: 1, credential_key_versions: [1], revoked: true });
  });

  it('计划退役（k1 移出 KEYS 进 RETIRED）：未迁移的 k1 凭据登录 401', async () => {
    const keys = keyMap(1, 2);
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-28c', {
      credentialKeys: keys,
      currentVersion: 1,
      retiredVersions: new Set(),
      compromisedVersions: new Set(),
    });
    const cred = creds.get(s.person.P1.id)!;
    const onlyV2 = new Map([[2, keys.get(2)!]]);
    portalCredentials(true, {
      kdf: FAST,
      credentialKeys: onlyV2,
      currentVersion: 2,
      retiredVersions: new Set([1]),
    });
    expect((await login(w, cred.serial, cred.password)).status).toBe(401);
  });
});

describe('AC-360-F076-29 曾暴露于 COMPROMISED 版本（登录侧）', () => {
  it('(a) 集合含 2 的凭据（用过 k2 的，含已迁到 k3 的）登录 401；(b) 集合 {1, 3} 的凭据登录照常 201', async () => {
    const keys = keyMap(1, 2, 3);
    const base = {
      kdf: FAST,
      credentialKeys: keys,
      retiredVersions: new Set<number>(),
      compromisedVersions: new Set<number>(),
    };
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-29', { ...base, currentVersion: 1 });
    const [p1, p2, p3] = [s.person.P1, s.person.P2, s.person.T].map((p) => creds.get(p.id)!) as [Cred, Cred, Cred];
    let n = 0;
    const ip = () => ({ ip: `203.0.113.${120 + n++}` });

    // CURRENT = 2：P1、P2 登录并迁到 k2；CURRENT = 3：P2 再迁到 k3，P3 从 k1 直接迁到 k3（从未用过 k2）
    portalCredentials(true, { ...base, currentVersion: 2 });
    expect((await login(w, p1.serial, p1.password, ip())).status).toBe(201);
    expect((await login(w, p2.serial, p2.password, ip())).status).toBe(201);
    portalCredentials(true, { ...base, currentVersion: 3 });
    expect((await login(w, p2.serial, p2.password, ip())).status).toBe(201);
    expect((await login(w, p3.serial, p3.password, ip())).status).toBe(201);
    const versions = Object.fromEntries((await linkRows(w, s.activity.id)).map((l) => [l.id, l.credential_key_versions]));
    expect(versions[p1.linkId]).toEqual([1, 2]);
    expect(versions[p2.linkId]).toEqual([1, 2, 3]);
    expect(versions[p3.linkId]).toEqual([1, 3]);

    // 2 泄露（RETIRED + COMPROMISED，不运行 retire）：部署即生效
    portalCredentials(true, {
      ...base,
      credentialKeys: new Map([...keys].filter(([version]) => version !== 2)),
      currentVersion: 3,
      retiredVersions: new Set([2]),
      compromisedVersions: new Set([2]),
    });
    expect((await login(w, p1.serial, p1.password, ip())).status).toBe(401);
    expect((await login(w, p2.serial, p2.password, ip())).status).toBe(401);
    expect((await login(w, p3.serial, p3.password, ip())).status).toBe(201);
  });
});

describe('AC-360-F076-31 KDF 调用次数（工作量相同，不是完整计时证明）', () => {
  it('失败分支 = 1；成功 = 1；正确密码但 T2 复核失败 = 1；400、429、503、租户无效 = 0；D4 的 429 = 1', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-31');
    const cred = (p: { id: string }) => creds.get(p.id)!;
    const count = async (run: () => Promise<Response>, status: number) => {
      resetKdfCallCount();
      const res = await run();
      expect(res.status, await res.clone().text()).toBe(status);
      return kdfCallCount();
    };
    let n = 0;
    const ip = () => ({ ip: `203.0.113.${110 + n++}` });
    const p1 = cred(s.person.P1);

    expect(await count(() => login(w, 'ZZZZZZZZZZ', 'ZZZZZZZZ', ip()), 401)).toBe(1);
    expect(await count(() => login(w, p1.serial, wrongPassword(p1), ip()), 401)).toBe(1);
    expect(await count(() => login(w, p1.serial, p1.password, ip()), 201)).toBe(1);

    // 正确密码，T2 复核失败：链接已作废 / 无有效关系
    await sql1(w, sql`UPDATE survey360_links SET revoked = true WHERE id = ${cred(s.person.P2).linkId}::uuid`);
    expect(await count(() => login(w, cred(s.person.P2).serial, cred(s.person.P2).password, ip()), 401)).toBe(1);
    await sql1(
      w,
      sql`UPDATE survey360_relations SET removed = true WHERE appraiser_person_id = ${s.person.X.id}::uuid`,
    );
    expect(await count(() => login(w, cred(s.person.X).serial, cred(s.person.X).password, ip()), 401)).toBe(1);

    // 0 次：400、租户无效、D1 的 429、D3 的 429、503
    expect(await count(() => loginRaw(w, { body: {}, ...ip() }), 400)).toBe(0);
    expect(await count(() => login(w, p1.serial, p1.password, { tenant: null, ...ip() }), 401)).toBe(0);
    const full = ip();
    await seedThrottle(w, { scope: 'ip', key: ipKey(credentialConfig(), full.ip), requests: 3000 });
    expect(await count(() => login(w, p1.serial, p1.password, full), 429)).toBe(0);
    const t = cred(s.person.T);
    const locked = ip();
    for (let i = 0; i < 5; i += 1) await login(w, t.serial, wrongPassword(t), locked);
    expect(await count(() => login(w, t.serial, t.password, locked), 429)).toBe(0);
    configureLoginGate({ global: 0, perTenant: 0 });
    expect(await count(() => login(w, p1.serial, p1.password, ip()), 503)).toBe(0);
    resetLoginGate();

    // D4 的 429 = 1（发生在校验之后）
    const m = cred(s.person.M);
    for (let i = 0; i < 20; i += 1) await loginOk(w, m, ip());
    expect(await count(() => login(w, m.serial, m.password, ip()), 429)).toBe(1);
  });
});

describe('AC-360-F076-32 安全事件生命周期', () => {
  it('锁定 → 到期后被新失败重新锁定（旧锁 unlock、新锁 lock）→ 空闲到期由维护任务写 unlock；字段只有 §5.4 所列；表只增不改', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-32');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 5; i += 1) await login(w, cred.serial, wrongPassword(cred));
    w.setNow(minutes(16));
    for (let i = 0; i < 5; i += 1) await login(w, cred.serial, wrongPassword(cred));
    expect((await securityEvents(w)).map((e) => e.kind)).toEqual(['lock', 'unlock', 'lock']);
    const events = await securityEvents(w);
    expect(events[1]!.detail).toMatchObject({ unlockedAt: '2026-10-01T01:15:00.000Z' });
    expect(events[2]!.detail).toMatchObject({ lockedUntil: '2026-10-01T01:31:00.000Z' });

    w.setNow(minutes(40));
    await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: () => new Date(minutes(40)) });
    const after = await securityEvents(w);
    expect(after.map((e) => e.kind)).toEqual(['lock', 'unlock', 'lock', 'unlock']);
    expect(after[3]!.detail).toMatchObject({ unlockedAt: '2026-10-01T01:31:00.000Z' });

    const rows = rowsOf<Record<string, unknown>>(
      await withTenant(w.db, w.tenantId, (tx) =>
        tx.execute(sql`SELECT * FROM survey360_security_events WHERE kind IN ('lock', 'unlock')`),
      ),
    );
    for (const row of rows) {
      expect(row['scope']).toBe('pair');
      expect(String(row['key_prefix'])).toMatch(/^[0-9a-f]{8}$/);
      expect(row['link_id']).toBeNull();
      expect(JSON.stringify(row)).not.toContain(cred.serial);
    }
    await expect(sql1(w, sql`UPDATE survey360_security_events SET kind = kind`)).rejects.toThrow();
    await expect(sql1(w, sql`DELETE FROM survey360_security_events`)).rejects.toThrow();
  });
});

describe('AC-360-F076-08 登录相关位置不落明文', () => {
  it('审计、命令台账、outbox（除 sealed）、安全事件、限频表、捕获的日志都查不到序列号 / 密码 / 会话令牌', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-08');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await seedThrottle(w, { scope: 'tenant', key: '', failures: 299 });
    const cred = creds.get(s.person.P1.id)!;
    const other = creds.get(s.person.P2.id)!;
    const { session } = await loginOk(w, cred);
    await login(w, other.serial, wrongPassword(other));
    for (let i = 0; i < 5; i += 1) await login(w, other.serial, wrongPassword(other));
    await logout(w, session);
    const throttle = JSON.stringify(await throttleRows(w));
    const surface = `${await leakSurface(w)}\n${throttle}\n${await dumpTable(w, 'survey360_answer_sessions')}`;
    const logs = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
    for (const secret of [cred.serial, cred.password, session, other.serial, other.password, wrongPassword(other)]) {
      expect(surface).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(await pairRow(w, other.serial)).toBeDefined();
  });
});

async function dumpTable(w: { db: Parameters<typeof withTenant>[0]; tenantId: string }, table: string): Promise<string> {
  const result = await withTenant(w.db, w.tenantId, (tx) =>
    tx.execute(sql.raw(`SELECT coalesce(string_agg(to_jsonb(t)::text, ' '), '') AS t FROM ${table} t`)),
  );
  return rowsOf<{ t: string }>(result)[0]!.t;
}
