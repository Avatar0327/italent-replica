/**
 * AC-360-F076-20、25、26（F-076 PR-2a，设计 §3.4、§3.6；DEC-379③）：同一出口、不同评价者（方案 C 的残余风险与恢复办法），
 * 资源保护（D1 成功也计、D4 单凭据每小时成功上限、并发闸全局 + 单租户双限）。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { runCredentialMaintenance } from '../../apps/api/src/modules/survey360/credential-maintenance.js';
import { configureLoginGate, resetLoginGate } from '../../apps/api/src/modules/survey360/login-gate.js';
import { loginHooks, resetLoginHooks } from '../../apps/api/src/modules/survey360/portal.js';
import { ipKey } from '../../apps/api/src/modules/survey360/throttle.js';
import { key } from './AC-360-B-support.js';
import { resetCredentialConfig } from './AC-360-F076-support.js';
import {
  START,
  credsOf,
  issuedScene,
  ipRow,
  login,
  loginOk,
  minutes,
  pairRow,
  seedThrottle,
  sessionRows,
  throttleRows,
  wrongPassword,
} from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(() => {
  resetCredentialConfig();
  resetLoginHooks();
  resetLoginGate();
});

const E = '198.51.100.50';
const json = async (res: Response) => (await res.json()) as { error: { code: string; details?: { reason?: string } } };

describe('AC-360-F076-20 同一出口、不同评价者（方案 C）', () => {
  it('(a) 攻击者从出口 E 发 100 次随机失败后，同出口评价者 X 用正确凭据登录 201', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-20a');
    for (let i = 0; i < 100; i += 1) await login(w, `RND${i}ABCDEF`.replace(/[01]/g, '2'), 'ZZZZZZZZ', { ip: E });
    const x = creds.get(s.person.X.id)!;
    expect((await login(w, x.serial, x.password, { ip: E })).status).toBe(201);
  });

  it('(b) 知道 Y 的序列号的攻击者失败 5 次：Y 从 E 登录 429；管理员重发后新凭据 201；个人链接照常', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-20b');
    const y = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 5; i += 1) await login(w, y.serial, wrongPassword(y), { ip: E });
    const locked = await login(w, y.serial, y.password, { ip: E });
    expect(locked.status).toBe(429);
    expect((await json(locked)).error.code).toBe('AUTH_LOCKED');

    const reissue = await w.request('POST', `${s.path}/invitations`, {
      idempotencyKey: key(),
      body: { personIds: [s.person.P1.id] },
    });
    expect(reissue.status, await reissue.clone().text()).toBe(200);
    await runCredentialMaintenance(w.db, { tenantId: w.tenantId, clock: () => new Date(START) });
    const fresh = (await credsOf(w)).get(s.person.P1.id)!;
    expect(fresh.serial).not.toBe(y.serial);
    expect((await login(w, fresh.serial, fresh.password, { ip: E })).status).toBe(201);
    // 个人链接照常（新链接的令牌）
    expect((await w.link(fresh.token)('GET', '')).status).toBe(200);
    // 旧凭据不再可用
    expect((await login(w, y.serial, y.password, { ip: '203.0.113.60' })).status).toBe(401);
  });

  it('(c) 攻击者从 E 发满 3000 次后 X 登录 429 REQUEST_RATE_LIMITED（带 Retry-After），窗口结束后 201', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-20c');
    const x = creds.get(s.person.X.id)!;
    await seedThrottle(w, { scope: 'ip', key: ipKey(credentialConfig(), E), requests: 3000 });
    w.setNow(minutes(5));
    const res = await login(w, x.serial, x.password, { ip: E });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect((await json(res)).error.code).toBe('REQUEST_RATE_LIMITED');
    w.setNow(minutes(16));
    expect((await login(w, x.serial, x.password, { ip: E })).status).toBe(201);
  });
});

describe('AC-360-F076-25 资源保护', () => {
  it('(a) D1 成功也计：本窗口获准计数满 3000 之后的下一次起 429，被拒请求不计入', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-25a');
    configureLoginGate({ global: 100, perTenant: 100 });
    await seedThrottle(w, { scope: 'ip', key: ipKey(credentialConfig(), E), requests: 2996 });
    const people = [s.person.P1, s.person.P2, s.person.T, s.person.M];
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const cred = creds.get(people[i % 4]!.id)!;
        return login(w, cred.serial, cred.password, { ip: E });
      }),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((code) => code === 201)).toHaveLength(4);
    expect(statuses.filter((code) => code === 429)).toHaveLength(4);
    expect((await ipRow(w, E))!.requests).toBe(3000);
  });

  it('(b) 单个凭据跨 IP 一小时内第 21 次成功：429 REQUEST_RATE_LIMITED，不签发会话', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-25b');
    const cred = creds.get(s.person.P1.id)!;
    for (let i = 0; i < 20; i += 1) await loginOk(w, cred, { ip: `203.0.113.${100 + i}` });
    const before = (await sessionRows(w, cred.linkId)).length;
    const res = await login(w, cred.serial, cred.password, { ip: '203.0.113.200' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect((await json(res)).error.code).toBe('REQUEST_RATE_LIMITED');
    expect(await sessionRows(w, cred.linkId)).toHaveLength(before);
    // 过了一小时再来就可以
    w.setNow(minutes(61));
    expect((await login(w, cred.serial, cred.password, { ip: '203.0.113.201' })).status).toBe(201);
  });

  it('(c) 租户 A 占满 2 个名额时，A 的第三个请求 503，租户 B 不受影响', async () => {
    const a = await issuedScene(testDb().db, 'f076-25c-a');
    const b = await issuedScene(testDb().db, 'f076-25c-b');
    configureLoginGate({ global: 4, perTenant: 2 });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    loginHooks.afterPrewrite = async (context) => {
      if (context.tenantId !== a.w.tenantId) return;
      waiting += 1;
      await blocked;
    };
    const credA = (n: number) => [...a.creds.values()][n]!;
    const held = [0, 1].map((n) => login(a.w, credA(n).serial, credA(n).password, { ip: `203.0.113.${70 + n}` }));
    while (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await login(a.w, credA(2).serial, credA(2).password, { ip: '203.0.113.72' });
    expect(third.status).toBe(503);
    expect(await json(third)).toMatchObject({
      error: { code: 'SERVICE_UNAVAILABLE', details: { reason: 'LOGIN_BUSY' } },
    });
    const credB = [...b.creds.values()][0]!;
    expect((await login(b.w, credB.serial, credB.password, { ip: '203.0.113.73' })).status).toBe(201);
    release();
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([201, 201]);
  });
});

describe('AC-360-F076-26 并发闸全局满', () => {
  it('503 SERVICE_UNAVAILABLE，details.reason = LOGIN_BUSY；不计任何维度', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-26');
    configureLoginGate({ global: 1, perTenant: 1 });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let entered = false;
    loginHooks.afterPrewrite = async () => {
      entered = true;
      await blocked;
    };
    const first = creds.get(s.person.P1.id)!;
    const second = creds.get(s.person.P2.id)!;
    const held = login(w, first.serial, first.password, { ip: '203.0.113.80' });
    while (!entered) await new Promise((resolve) => setTimeout(resolve, 5));
    const rowsBefore = await throttleRows(w);
    const res = await login(w, second.serial, wrongPassword(second), { ip: '203.0.113.81' });
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({
      error: { code: 'SERVICE_UNAVAILABLE', details: { reason: 'LOGIN_BUSY' } },
    });
    expect(await throttleRows(w)).toEqual(rowsBefore);
    expect(await pairRow(w, second.serial, '203.0.113.81')).toBeUndefined();
    release();
    expect((await held).status).toBe(201);
  });
});
