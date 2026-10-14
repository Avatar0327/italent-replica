/**
 * AC-360-F076-01b（#223 审查 P3）：损坏摘要的 scrypt 参数联合约束。
 * N、r 各自在范围内但组合会让 scrypt 抛错（N=65536、r=1：scrypt 要求 N < 2^(16·r)）时，一律按损坏摘要处理：
 * 返回 false，不抛错，且仍恰好做一次 KDF（各失败分支工作量一致，设计 §3.8）。
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  kdfCallCount,
  resetKdfCallCount,
  verifyPassword,
} from '../../apps/api/src/modules/survey360/credentials.js';

const key = randomBytes(32);
const salt = randomBytes(16).toString('base64url');
const hash = randomBytes(32).toString('base64url');

describe('AC-360-F076-01b 损坏摘要的 scrypt 联合参数', () => {
  it.each([
    ['N=65536、r=1（scrypt 要求 N < 2^(16r)）', 'scrypt$65536$1$1$'],
    ['N=2^20、r=32（内存远超上限）', 'scrypt$1048576$32$1$'],
    ['N=2^20、r=8（约 1GB，超过内存上限）', 'scrypt$1048576$8$1$'],
    ['N 不是 2 的幂', 'scrypt$1000$8$1$'],
    ['p 超限', 'scrypt$16384$8$99$'],
  ])('%s：返回 false，不抛错，恰好做一次 KDF', async (_name, prefix) => {
    resetKdfCallCount();
    await expect(verifyPassword(`${prefix}${salt}$${hash}`, key, 'ABCDEFGH')).resolves.toBe(false);
    expect(kdfCallCount()).toBe(1);
  });

  it('合法的升级参数（N=2^15、r=8）仍能校验', async () => {
    const digest = await hashPassword(key, 'ABCDEFGH', { N: 32768, r: 8, p: 1 });
    await expect(verifyPassword(digest, key, 'ABCDEFGH')).resolves.toBe(true);
    await expect(verifyPassword(digest, key, 'ABCDEFGJ')).resolves.toBe(false);
  });
});
