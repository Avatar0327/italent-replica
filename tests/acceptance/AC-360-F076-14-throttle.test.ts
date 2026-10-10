/**
 * AC-360-F076-14～19、21～23（F-076 PR-2a，设计 §3.2、§3.3、§3.5；DEC-379③ 方案 C）：
 * 序列号 × IP 的失败锁定（D3）、窗口与锁定的统一语义、被拒请求不扣其他维度、租户失败只告警、预扣标识。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { kdfCallCount, resetKdfCallCount } from '../../apps/api/src/modules/survey360/credentials.js';
import { configureLoginGate, resetLoginGate } from '../../apps/api/src/modules/survey360/login-gate.js';
import { loginHooks, resetLoginHooks } from '../../apps/api/src/modules/survey360/portal.js';
import { ipKey } from '../../apps/api/src/modules/survey360/throttle.js';
import { resetCredentialConfig, securityEvents } from './AC-360-F076-support.js';
import {
  issuedScene,
  ipRow,
  login,
  loginOk,
  minutes,
  pairRow,
  seedThrottle,
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

const IP = '198.51.100.7';
const isoOf = (value: string | Date) => new Date(value).toISOString();

async function body(res: Response) {
  return (await res.json()) as { error: { code: string; message: string; details?: { unlockAt?: string } } };
}

describe('AC-360-F076-14 D3：同 IP 同序列号失败 5 次锁 15 分钟', () => {
  it('第 6 次 429 AUTH_LOCKED（整数秒 Retry-After + unlockAt）；锁内正确密码也 429；另一 IP 不受影响；到期后 201 并写 unlock', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-14');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 5; i += 1) expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(401);

    const sixth = await login(w, cred.serial, wrongPassword(cred));
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).toBe('900');
    const locked = await body(sixth);
    expect(locked.error.code).toBe('AUTH_LOCKED');
    expect(locked.error.details?.unlockAt).toBe('2026-10-01T01:15:00.000Z');

    // 锁内正确密码也 429；剩余时间随时钟递减
    w.setNow(minutes(1));
    const inside = await login(w, cred.serial, cred.password);
    expect(inside.status).toBe(429);
    expect(inside.headers.get('retry-after')).toBe('840');

    // 另一 IP（同序列号 + 正确密码）不受影响
    expect((await login(w, cred.serial, cred.password, { ip: '203.0.113.20' })).status).toBe(201);

    // 到期后恢复，并写一条 unlock（解锁时间 = 原 locked_until）
    w.setNow(minutes(16));
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
    const unlocks = await securityEvents(w, 'unlock');
    expect(unlocks).toHaveLength(1);
    expect(unlocks[0]!.detail).toMatchObject({ unlockedAt: '2026-10-01T01:15:00.000Z' });
  });
});

describe('AC-360-F076-15 已达阈值未锁（第 5 次预扣提交后、T2 前崩溃）', () => {
  it('窗口内 429，unlockAt = 窗口结束；超过窗口后正确密码 201', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-15');
    const cred = creds.get(s.person.P1.id)!;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < 4; i += 1) expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(401);
    loginHooks.afterPrewrite = () => {
      throw new Error('模拟 T1 提交后进程崩溃');
    };
    expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(500);
    resetLoginHooks();
    expect((await pairRow(w, cred.serial))!.failures).toBe(5);
    expect((await pairRow(w, cred.serial))!.locked_until).toBeNull();

    w.setNow(minutes(3));
    const res = await login(w, cred.serial, cred.password);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('720');
    const rejected = await body(res);
    expect(rejected.error.code).toBe('AUTH_LOCKED');
    expect(rejected.error.details?.unlockAt).toBe('2026-10-01T01:15:00.000Z');

    w.setNow(minutes(16));
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
  });
});

describe('AC-360-F076-16 窗口过期后重新计数', () => {
  it('旧窗口失败 4 次，16 分钟后再失败 1 次：返回 401（不是 429），从 1 计', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-16');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 4; i += 1) expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(401);
    w.setNow(minutes(16));
    expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(401);
    const row = (await pairRow(w, cred.serial))!;
    expect(row.failures).toBe(1);
    expect(isoOf(row.window_started_at)).toBe('2026-10-01T01:16:00.000Z');
    expect(row.locked_until).toBeNull();
  });
});

describe('AC-360-F076-17 方案 C：不设 IP 失败锁，也不锁租户', () => {
  it('单 IP 串行 301 次随机序列号全是 401；另一 IP 正确凭据 201；管理员重发后的新凭据 201', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-17');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 301; i += 1) {
      const serial = `K${String(i).padStart(9, '2')}`.replace(/[01]/g, '3');
      expect((await login(w, serial, 'ZZZZZZZZ')).status, `第 ${i + 1} 次`).toBe(401);
    }
    expect((await login(w, cred.serial, cred.password, { ip: '203.0.113.30' })).status).toBe(201);
    // 攻击者出口自己：还没碰过的序列号只受 D1 约束，没有 IP 失败锁
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
    const locks = (await throttleRows(w)).filter((row) => row.locked_until !== null);
    expect(locks.every((row) => row.scope === 'pair')).toBe(true);
    expect(await securityEvents(w, 'lock')).toHaveLength(0);
  });
});

describe('AC-360-F076-18 被拒请求不扣其他维度', () => {
  it('D1 已满后再发 100 次：IP 行 requests 不变，不新建任何行', async () => {
    const { w } = await issuedScene(testDb().db, 'f076-18');
    await seedThrottle(w, { scope: 'ip', key: ipKey(credentialConfig(), IP), requests: 3000 });
    const before = await throttleRows(w);
    for (let i = 0; i < 100; i += 1) {
      const res = await login(w, `SER${i}ABCDEF`, 'ZZZZZZZZ');
      expect(res.status).toBe(429);
      expect((await body(res)).error.code).toBe('REQUEST_RATE_LIMITED');
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(await throttleRows(w)).toEqual(before);
  });
});

describe('AC-360-F076-19 序列号 A 已锁，换序列号 B / 换 IP', () => {
  it('同 IP 换序列号照常预扣并 401；另一 IP 用序列号 A 不受影响', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-19');
    const a = creds.get(s.person.P1.id)!;
    const b = creds.get(s.person.P2.id)!;
    for (let i = 0; i < 5; i += 1) await login(w, a.serial, wrongPassword(a));
    expect((await login(w, a.serial, a.password)).status).toBe(429);
    const ipBefore = (await ipRow(w))!.requests;

    expect((await login(w, b.serial, wrongPassword(b))).status).toBe(401);
    expect((await pairRow(w, b.serial))!.failures).toBe(1);
    expect((await ipRow(w))!.requests).toBe(ipBefore + 1);
    expect((await login(w, a.serial, a.password, { ip: '203.0.113.31' })).status).toBe(201);
  });
});

describe('AC-360-F076-21 租户失败只告警', () => {
  it('合计第 300 次失败写一条运行日志告警（不进安全事件表），之后的正确登录仍 201', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-21');
    const cred = creds.get(s.person.P1.id)!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedThrottle(w, { scope: 'tenant', key: '', failures: 298 });
    await login(w, 'AAAAAAAAAA', 'ZZZZZZZZ', { ip: '203.0.113.40' });
    expect(warn).not.toHaveBeenCalled();
    await login(w, 'BBBBBBBBBB', 'ZZZZZZZZ', { ip: '203.0.113.41' });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('survey360.login.tenant_failures');
    expect(line).not.toContain('BBBBBBBBBB');
    // 跨过阈值之后不再重复告警
    await login(w, 'CCCCCCCCCC', 'ZZZZZZZZ', { ip: '203.0.113.42' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await securityEvents(w)).toHaveLength(0);
    expect((await login(w, cred.serial, cred.password, { ip: '203.0.113.43' })).status).toBe(201);
  });
});

describe('AC-360-F076-22 并发原子性：预扣计入在途请求', () => {
  it('并发闸调到 100，20 个并发错误请求打同一序列号 × IP：进入 KDF ≤ 5 次', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-22');
    const cred = creds.get(s.person.P1.id)!;
    configureLoginGate({ global: 100, perTenant: 100 });
    resetKdfCallCount();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => login(w, cred.serial, wrongPassword(cred))),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((code) => code === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.every((code) => code === 401 || code === 429)).toBe(true);
    expect(kdfCallCount()).toBeLessThanOrEqual(5);
  });
});

describe('AC-360-F076-23 预扣标识', () => {
  it('失败 4 次、成功 1 次、再失败 5 次：第 5 次仍是 401（成功清零），第 6 次才 429', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-23a');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 4; i += 1) await login(w, cred.serial, wrongPassword(cred));
    await loginOk(w, cred);
    expect((await pairRow(w, cred.serial))!.failures).toBe(0);
    for (let i = 0; i < 5; i += 1) expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(401);
    expect((await login(w, cred.serial, wrongPassword(cred))).status).toBe(429);
  });

  it('跨窗口完成的成功：退回不扣新窗口的计数', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-23b');
    const cred = creds.get(s.person.P1.id)!;
    loginHooks.afterPrewrite = async () => {
      resetLoginHooks();
      w.setNow(minutes(16));
      expect((await login(w, cred.serial, wrongPassword(cred), { ip: IP })).status).toBe(401);
    };
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
    const row = (await pairRow(w, cred.serial))!;
    expect(row.failures).toBe(1);
    expect(isoOf(row.window_started_at)).toBe('2026-10-01T01:16:00.000Z');
  });

  it('锁定后才完成的成功：登录成功但不清掉已设置的锁，计数不为负', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-23c');
    const cred = creds.get(s.person.P1.id)!;
    loginHooks.afterPrewrite = async () => {
      resetLoginHooks();
      for (let i = 0; i < 4; i += 1) await login(w, cred.serial, wrongPassword(cred));
    };
    expect((await login(w, cred.serial, cred.password)).status).toBe(201);
    const row = (await pairRow(w, cred.serial))!;
    expect(row.locked_until).not.toBeNull();
    expect(row.failures).toBe(0);
    expect((await login(w, cred.serial, cred.password)).status).toBe(429);
  });
});
