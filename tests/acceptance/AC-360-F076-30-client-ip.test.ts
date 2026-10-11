/**
 * AC-360-F076-30（F-076 PR-2a，设计 §3.6；部署手册“代理契约”）：可信代理与客户端地址提取。
 * 只在套接字对端属于 TRUSTED_PROXY_CIDRS 时才读 X-Forwarded-For，否则一律用套接字地址；
 * IPv4-mapped 去前缀，IPv6 按 /64 聚合，无法解析记为 unknown。
 */
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { clientBucket } from '../../apps/api/src/modules/survey360/client-ip.js';
import { credentialConfig } from '../../apps/api/src/modules/survey360/credential-config.js';
import { ipKey } from '../../apps/api/src/modules/survey360/throttle.js';
import { portalCredentials, resetCredentialConfig } from './AC-360-F076-support.js';
import { issuedScene, login, throttleRows } from './AC-360-F076-portal-support.js';

const testDb = useTestDb();
afterEach(() => resetCredentialConfig());

const TRUSTED = ['10.0.0.0/8', 'fd00::/8'];
const bucket = (peer: string | undefined, forwardedFor?: string, trusted: readonly string[] = TRUSTED) =>
  clientBucket({ peer, forwardedFor, trusted });

describe('AC-360-F076-30 客户端地址提取（纯函数）', () => {
  it('非可信来源：忽略请求自带的转发头，按套接字地址', () => {
    expect(bucket('198.51.100.7', '203.0.113.9')).toBe('198.51.100.7');
    expect(bucket('198.51.100.7', '203.0.113.9', [])).toBe('198.51.100.7');
  });

  it('可信代理：按转发头；链式转发从右往左跳过可信地址，取第一个非可信地址（伪造的左侧不起作用）', () => {
    expect(bucket('10.1.2.3', '203.0.113.9')).toBe('203.0.113.9');
    expect(bucket('10.1.2.3', '203.0.113.9, 10.9.9.9')).toBe('203.0.113.9');
    expect(bucket('10.1.2.3', '1.2.3.4, 203.0.113.9')).toBe('203.0.113.9');
    expect(bucket('10.1.2.3', '10.4.4.4')).toBe('10.4.4.4');
    expect(bucket('10.1.2.3', undefined)).toBe('10.1.2.3');
    expect(bucket('10.1.2.3', 'not-an-ip')).toBe('unknown');
  });

  it('IPv4-mapped 与 IPv4 同键；IPv6 同一 /64 同键，不同 /64 不同键', () => {
    expect(bucket('::ffff:198.51.100.7')).toBe(bucket('198.51.100.7'));
    expect(bucket('2001:db8:1:2::1')).toBe(bucket('2001:db8:1:2:ffff:0:0:9'));
    expect(bucket('2001:db8:1:2::1')).not.toBe(bucket('2001:db8:1:3::1'));
    expect(bucket('::ffff:10.1.2.3', '203.0.113.9')).toBe('203.0.113.9');
  });

  it('无法解析 / 缺失记为 unknown', () => {
    expect(bucket(undefined)).toBe('unknown');
    expect(bucket('')).toBe('unknown');
    expect(bucket('garbage')).toBe('unknown');
  });
});

describe('AC-360-F076-30 经登录接口：伪造转发头不改变限频身份', () => {
  it('非可信来源带伪造 X-Forwarded-For：按套接字地址计；可信代理转发：按转发头计', async () => {
    const { w } = await issuedScene(testDb().db, 'f076-30');
    const config = credentialConfig();
    const keysOf = async () => new Set((await throttleRows(w, 'ip')).map((row) => row.key_hash));

    await login(w, 'AAAAAAAAAA', 'ZZZZZZZZ', { ip: '198.51.100.7', headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(await keysOf()).toEqual(new Set([ipKey(config, '198.51.100.7')]));

    portalCredentials(true, { trustedProxyCidrs: TRUSTED });
    await login(w, 'AAAAAAAAAA', 'ZZZZZZZZ', { ip: '10.1.2.3', headers: { 'x-forwarded-for': '203.0.113.9' } });
    await login(w, 'AAAAAAAAAA', 'ZZZZZZZZ', { ip: '2001:db8:1:2::1' });
    await login(w, 'AAAAAAAAAA', 'ZZZZZZZZ', { ip: '2001:db8:1:2:ffff:0:0:9' });
    await login(w, 'AAAAAAAAAA', 'ZZZZZZZZ', { ip: null });
    const keys = await keysOf();
    expect(keys.has(ipKey(config, '203.0.113.9'))).toBe(true);
    expect(keys.has(ipKey(config, '10.1.2.3'))).toBe(false);
    expect(keys.has(ipKey(config, 'unknown'))).toBe(true);
    // 同一 /64 的两个地址共用一行：198.51.100.7、203.0.113.9、一个 /64、unknown
    expect(keys.size).toBe(4);
  });
});
