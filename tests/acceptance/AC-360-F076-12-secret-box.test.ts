/**
 * AC-360-F076-12（F-076 PR-1，设计 §2.6；DEC-377②）：outbox 秘密字段加密——AES-256-GCM、每次新 IV、
 * AAD = 租户:outbox 行:事件类型、kid 保留与旧 kid 可解封；以及凭据 / 密钥配置的启动校验与 KDF 单元行为。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseCredentialConfig,
  type CredentialConfig,
} from '../../apps/api/src/modules/survey360/credential-config.js';
import {
  dummyDigest,
  hashPassword,
  makeCredential,
  serialLookup,
  verifyPassword,
} from '../../apps/api/src/modules/survey360/credentials.js';
import { openSealed, sealJson } from '../../apps/api/src/modules/survey360/secret-box.js';

const b64 = (bytes = 32) => randomBytes(bytes).toString('base64');
const ctx = () => ({ tenantId: randomUUID(), outboxId: randomUUID(), eventType: 'survey360.answer_invitation' });
const boxConfig = (kids: Record<string, Buffer>, current: string) => ({
  outboxKeys: new Map(Object.entries(kids)),
  outboxCurrent: current,
});

describe('AC-360-F076-12 sealed 格式', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it('同一内容封装两次：IV 与密文都不同；格式为 { v, kid, iv, tag, data }；解封还原', () => {
    const config = boxConfig({ a: k1 }, 'a');
    const where = ctx();
    const one = sealJson(config, { token: 'T', serial: 'S', password: 'P' }, where);
    const two = sealJson(config, { token: 'T', serial: 'S', password: 'P' }, where);
    expect(Object.keys(one).sort()).toEqual(['data', 'iv', 'kid', 'tag', 'v']);
    expect(one).toMatchObject({ v: 1, kid: 'a' });
    expect(Buffer.from(one.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(one.tag, 'base64')).toHaveLength(16);
    expect(one.iv).not.toBe(two.iv);
    expect(one.data).not.toBe(two.data);
    expect(openSealed(config, one, where)).toEqual({ token: 'T', serial: 'S', password: 'P' });
    expect(JSON.stringify(one)).not.toContain('"T"');
  });

  it('把密文挪到另一行 / 另一租户 / 另一事件类型：AAD 不符，无法解封', () => {
    const config = boxConfig({ a: k1 }, 'a');
    const where = ctx();
    const sealed = sealJson(config, { token: 'T' }, where);
    expect(() => openSealed(config, sealed, { ...where, outboxId: randomUUID() })).toThrow();
    expect(() => openSealed(config, sealed, { ...where, tenantId: randomUUID() })).toThrow();
    expect(() => openSealed(config, sealed, { ...where, eventType: 'survey360.confirm_invitation' })).toThrow();
  });

  it('密文或认证标签被改动：无法解封', () => {
    const config = boxConfig({ a: k1 }, 'a');
    const where = ctx();
    const sealed = sealJson(config, { token: 'T' }, where);
    const flip = (value: string) => {
      const bytes = Buffer.from(value, 'base64');
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString('base64');
    };
    expect(() => openSealed(config, { ...sealed, data: flip(sealed.data) }, where)).toThrow();
    expect(() => openSealed(config, { ...sealed, tag: flip(sealed.tag) }, where)).toThrow();
  });

  it('非 CURRENT 但仍在配置里的 kid 能解封；kid 不在配置里拒绝；新封装一律用 CURRENT', () => {
    const where = ctx();
    const old = sealJson(boxConfig({ a: k1 }, 'a'), { token: 'T' }, where);
    const rotated = boxConfig({ a: k1, b: k2 }, 'b');
    expect(openSealed(rotated, old, where)).toEqual({ token: 'T' });
    expect(sealJson(rotated, { token: 'T' }, where).kid).toBe('b');
    expect(() => openSealed(boxConfig({ b: k2 }, 'b'), old, where)).toThrow(/kid/);
  });
});

describe('AC-360-F076-12 密钥配置与启动校验（设计 §2.4、§2.6）', () => {
  const valid = (): Record<string, string> => ({
    SURVEY360_CREDENTIAL_KEYS: `3:${b64()},2:${b64()}`,
    SURVEY360_CREDENTIAL_KEY_CURRENT: '3',
    SURVEY360_CREDENTIAL_KEYS_RETIRED: '1',
    SURVEY360_CREDENTIAL_KEYS_COMPROMISED: '1',
    SURVEY360_THROTTLE_KEY: b64(),
    SURVEY360_OUTBOX_KEYS: `k2:${b64()},k1:${b64()}`,
    SURVEY360_OUTBOX_KEY_CURRENT: 'k2',
    SURVEY360_PORTAL_CREDENTIALS: 'on',
  });
  const strict = (env: Record<string, string>) => parseCredentialConfig(env, { lenient: false });

  it('完整配置解析成功', () => {
    const config = strict(valid());
    expect([...config.credentialKeys.keys()].sort()).toEqual([2, 3]);
    expect(config.currentVersion).toBe(3);
    expect([...config.retiredVersions]).toEqual([1]);
    expect([...config.compromisedVersions]).toEqual([1]);
    expect(config.outboxCurrent).toBe('k2');
    expect(config.portalCredentials).toBe(true);
    expect(config.kdf).toEqual({ N: 16384, r: 8, p: 1 });
  });

  it('开关缺省关闭；只有 on 打开', () => {
    const env = valid();
    delete env['SURVEY360_PORTAL_CREDENTIALS'];
    expect(strict(env).portalCredentials).toBe(false);
    expect(strict({ ...env, SURVEY360_PORTAL_CREDENTIALS: 'off' }).portalCredentials).toBe(false);
  });

  it.each<[string, (env: Record<string, string>) => void, RegExp]>([
    ['生产缺密钥表', (e) => delete e['SURVEY360_CREDENTIAL_KEYS'], /SURVEY360_CREDENTIAL_KEYS/],
    ['密钥不是 32 字节', (e) => (e['SURVEY360_CREDENTIAL_KEYS'] = `3:${b64(16)}`), /32/],
    [
      '超过 4 个版本',
      (e) => (e['SURVEY360_CREDENTIAL_KEYS'] = [1, 2, 3, 4, 5].map((v) => `${v}:${b64()}`).join(',')),
      /4/,
    ],
    ['版本号不是正整数', (e) => (e['SURVEY360_CREDENTIAL_KEYS'] = `0:${b64()}`), /版本/],
    ['版本号重复', (e) => (e['SURVEY360_CREDENTIAL_KEYS'] = `3:${b64()},3:${b64()}`), /重复/],
    ['当前版本不在密钥表里', (e) => (e['SURVEY360_CREDENTIAL_KEY_CURRENT'] = '9'), /CURRENT/],
    ['已退役版本与密钥表重叠', (e) => (e['SURVEY360_CREDENTIAL_KEYS_RETIRED'] = '2'), /RETIRED/],
    ['泄露版本不是退役版本的子集', (e) => (e['SURVEY360_CREDENTIAL_KEYS_COMPROMISED'] = '5'), /COMPROMISED/],
    ['限频密钥缺失', (e) => delete e['SURVEY360_THROTTLE_KEY'], /THROTTLE/],
    ['限频密钥不足 32 字节', (e) => (e['SURVEY360_THROTTLE_KEY'] = b64(8)), /THROTTLE/],
    ['outbox 当前 kid 不在密钥表里', (e) => (e['SURVEY360_OUTBOX_KEY_CURRENT'] = 'zz'), /OUTBOX/],
    ['outbox 密钥缺失', (e) => delete e['SURVEY360_OUTBOX_KEYS'], /OUTBOX/],
  ])('生产环境 %s：拒绝启动', (_name, mutate, message) => {
    const env = valid();
    mutate(env);
    expect(() => strict(env)).toThrow(message);
  });

  it('开发 / 测试环境缺省时生成进程内随机密钥', () => {
    const config: CredentialConfig = parseCredentialConfig({}, { lenient: true });
    expect(config.credentialKeys.get(config.currentVersion)).toHaveLength(32);
    expect(config.throttleKey.length).toBeGreaterThanOrEqual(32);
    expect(config.outboxKeys.get(config.outboxCurrent)).toHaveLength(32);
    expect(config.portalCredentials).toBe(false);
  });
});

describe('AC-360-F076-12 凭据摘要（设计 §2.3）', () => {
  const key = randomBytes(32);
  const fast = { N: 1024, r: 8, p: 1 };

  it('serial_lookup 对同一密钥与序列号确定，换密钥或序列号则不同', () => {
    const other = randomBytes(32);
    expect(serialLookup(key, 'ABCDEFGH23')).toBe(serialLookup(key, 'ABCDEFGH23'));
    expect(serialLookup(key, 'ABCDEFGH23')).not.toBe(serialLookup(other, 'ABCDEFGH23'));
    expect(serialLookup(key, 'ABCDEFGH23')).not.toBe(serialLookup(key, 'ABCDEFGH24'));
    expect(serialLookup(key, 'ABCDEFGH23')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('password_hash 为 scrypt$N$r$p$盐$哈希，参数随行存储；盐随机；校验按存储的参数', async () => {
    const one = await hashPassword(key, 'ABCD2345', fast);
    const two = await hashPassword(key, 'ABCD2345', fast);
    expect(one).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(one).not.toBe(two);
    expect(await verifyPassword(one, key, 'ABCD2345')).toBe(true);
    expect(await verifyPassword(one, key, 'ABCD2346')).toBe(false);
    expect(await verifyPassword(one, randomBytes(32), 'ABCD2345')).toBe(false);
    expect(await verifyPassword('scrypt$bad', key, 'ABCD2345')).toBe(false);
  });

  it('哑摘要结果恒为假，但耗时路径与真摘要一致（同参数）', async () => {
    const dummy = await dummyDigest();
    expect(dummy).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword(dummy, key, 'ABCD2345')).toBe(false);
  });

  it('makeCredential 生成合格的序列号与密码，并给出可复算的摘要', async () => {
    const config = parseCredentialConfig({}, { lenient: true });
    const issued = await makeCredential({ ...config, kdf: fast });
    expect(issued.serial).toMatch(/^[2-9A-HJKMNP-Z]{10}$/);
    expect(issued.password).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    const secret = config.credentialKeys.get(config.currentVersion)!;
    expect(issued.serialLookup).toBe(serialLookup(secret, issued.serial));
    expect(await verifyPassword(issued.passwordHash, secret, issued.password)).toBe(true);
  });
});
