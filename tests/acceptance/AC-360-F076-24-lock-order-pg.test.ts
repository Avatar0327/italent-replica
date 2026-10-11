/**
 * AC-360-F076-24（真 PostgreSQL 交错；PGlite 单连接无法并发，只在设了 TEST_DATABASE_URL 时运行）：
 * 取锁顺序固定为 IP 行 → 序列号 × IP 行 → 链接行（设计 §3.5，R2-P2-3）。
 * 同 IP、同序列号的两个登录重叠时，B 的 T1 与 A 的 T2 依次排队，不死锁；计数与锁定结果与串行执行一致。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginHooks, resetLoginHooks } from '../../apps/api/src/modules/survey360/portal.js';
import { resetLoginGate } from '../../apps/api/src/modules/survey360/login-gate.js';
import { resetCredentialConfig } from './AC-360-F076-support.js';
import { issuedScene, login, pairRow, wrongPassword } from './AC-360-F076-portal-support.js';

const realPostgres = Boolean(process.env.TEST_DATABASE_URL);
const testDb = useTestDb();
afterEach(() => {
  resetCredentialConfig();
  resetLoginHooks();
  resetLoginGate();
  vi.restoreAllMocks();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 停在 T2 已锁完 IP 行与序列号 × IP 行之后；启动 B；等一会儿让 B 的 T1 排上队；放行 A。 */
async function overlap(first: () => Promise<Response>, second: () => Promise<Response>) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  loginHooks.afterT2Locks = async () => {
    held = true;
    await gate;
  };
  const a = first();
  while (!held) await pause(5);
  loginHooks.afterT2Locks = undefined;
  const b = second();
  await pause(300);
  release();
  return Promise.all([a, b]);
}

describe.skipIf(!realPostgres)('AC-360-F076-24 取锁顺序（真 PG）', () => {
  it('两个正确登录重叠：都 201，没有死锁，失败计数为 0', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-24a');
    const cred = creds.get(s.person.P1.id)!;
    const [a, b] = await overlap(
      () => login(w, cred.serial, cred.password),
      () => login(w, cred.serial, cred.password),
    );
    expect([a.status, b.status]).toEqual([201, 201]);
    expect((await pairRow(w, cred.serial))!.failures).toBe(0);
  });

  it('一成一败重叠：不死锁；A 成功退回预扣，B 的失败计 1，与串行执行一致', async () => {
    const { w, s, creds } = await issuedScene(testDb().db, 'f076-24b');
    const cred = creds.get(s.person.P1.id)!;
    const [a, b] = await overlap(
      () => login(w, cred.serial, cred.password),
      () => login(w, cred.serial, wrongPassword(cred)),
    );
    expect([a.status, b.status]).toEqual([201, 401]);
    expect((await pairRow(w, cred.serial))!.failures).toBe(1);
  });
});
