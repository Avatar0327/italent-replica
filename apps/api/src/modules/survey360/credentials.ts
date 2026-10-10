/**
 * 通用网址作答凭据的生成与摘要（F-076 设计 §2.2、§2.3、§3.8；DEC-401 Q3）。
 * - 序列号只存 `HMAC-SHA256(K_v, 'survey360:serial:' ‖ 规范化序列号)`（hex）；
 * - 密码只存 `scrypt(HMAC-SHA256(K_v, 'survey360:password:' ‖ 规范化密码), 随机盐, N, r, p)`，
 *   串格式 `scrypt$N$r$p$盐$哈希`（参数随行存储，可在登录成功时升级）；
 * - 比较一律 timingSafeEqual；scrypt 用异步版本（线程池）。字符集 / 长度 / 规范化在领域包（survey360.credential）。
 */
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { survey360 } from '@italent/domain';
import type { CredentialConfig, ScryptParams } from './credential-config.js';
import { DEFAULT_SCRYPT } from './credential-config.js';

const SERIAL_LABEL = 'survey360:serial:';
const PASSWORD_LABEL = 'survey360:password:';
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** 测试用的 KDF 调用计数与并发峰值（AC-02 命令内 0 次、AC-09 并发 ≤ 2、PR-2a 的 AC-31 工作量相同）。 */
let calls = 0;
let inflight = 0;
let peak = 0;
export const kdfCallCount = () => calls;
export const kdfPeakConcurrency = () => peak;
export function resetKdfCallCount(): void {
  calls = 0;
  peak = 0;
}

export function serialLookup(key: Buffer, normalizedSerial: string): string {
  return createHmac('sha256', key).update(SERIAL_LABEL).update(normalizedSerial).digest('hex');
}

function passwordPrehash(key: Buffer, normalizedPassword: string): Buffer {
  return createHmac('sha256', key).update(PASSWORD_LABEL).update(normalizedPassword).digest();
}

function derive(secret: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  calls += 1;
  inflight += 1;
  peak = Math.max(peak, inflight);
  return new Promise<Buffer>((resolve, reject) => {
    // maxmem 留出余量：128 * N * r 是 scrypt 的主要内存，默认上限 32MB 对 N=2^14、r=8（16MB）够用，参数升级时不被卡住
    const maxmem = 256 * params.N * params.r + 1024 * 1024;
    scrypt(secret, salt, HASH_BYTES, { N: params.N, r: params.r, p: params.p, maxmem }, (error, derived) => {
      inflight -= 1;
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

const b64 = (bytes: Buffer) => bytes.toString('base64url');

export async function hashPassword(
  key: Buffer,
  normalizedPassword: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(passwordPrehash(key, normalizedPassword), salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${b64(salt)}$${b64(hash)}`;
}

interface ParsedDigest {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseDigest(digest: string): ParsedDigest | undefined {
  const parts = digest.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return undefined;
  return { params: { N, r, p }, salt: Buffer.from(parts[4]!, 'base64url'), hash: Buffer.from(parts[5]!, 'base64url') };
}

/** 校验恰好做一次 KDF；摘要串损坏时返回 false（不抛错，调用方按失败处理）。 */
export async function verifyPassword(digest: string, key: Buffer, normalizedPassword: string): Promise<boolean> {
  const parsed = parseDigest(digest);
  if (!parsed) {
    // 摘要串损坏也做一次同参数 KDF 再返回假，各失败分支的工作量一致（设计 §3.8）
    await derive(passwordPrehash(key, normalizedPassword), randomBytes(SALT_BYTES), DEFAULT_SCRYPT);
    return false;
  }
  const derived = await derive(passwordPrehash(key, normalizedPassword), parsed.salt, parsed.params);
  return parsed.hash.length === derived.length && timingSafeEqual(parsed.hash, derived);
}

let dummy: Promise<string> | undefined;
/**
 * 哑摘要（设计 §3.8）：序列号不存在时仍做一次同参数的 KDF，结果恒为假。盐与密钥都是启动后随机生成，
 * 对应的密码没有人知道。
 */
export function dummyDigest(params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  dummy ??= hashPassword(randomBytes(32), randomBytes(16).toString('hex'), params);
  return dummy;
}

export interface IssuedCredential {
  readonly serial: string;
  readonly password: string;
  readonly serialLookup: string;
  readonly passwordHash: string;
  readonly version: number;
}

/** 生成一组凭据并用 version（缺省当前版本）的密钥算摘要。KDF 在这里发生一次，调用方不得放进命令事务。 */
export async function makeCredential(
  config: Pick<CredentialConfig, 'credentialKeys' | 'currentVersion' | 'kdf'>,
  random: (maxExclusive: number) => number = randomInt,
  version: number = config.currentVersion,
): Promise<IssuedCredential> {
  const key = config.credentialKeys.get(version);
  if (!key) throw new Error(`凭据密钥版本 ${version} 不在配置里`);
  const { serial, password } = survey360.generateCredentialPair(random);
  return {
    serial,
    password,
    version,
    serialLookup: serialLookup(key, serial),
    passwordHash: await hashPassword(key, password, config.kdf),
  };
}
