/**
 * 通用网址作答凭据与 outbox 加密的密钥配置（F-076 设计 §2.4、§2.6）。只放 Secret 管理 / 环境变量，库里不存密钥。
 * - 生产（NODE_ENV 不是 development / test）缺失或长度不足即启动失败；
 * - development / test 缺省时在进程内生成随机密钥（重启后旧数据解不开，只用于本地与测试）。
 */
import { randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** DEC-401 Q3：N=2^14, r=8, p=1。参数写进摘要串，以后可在登录成功时升级；生产不提供环境变量覆盖。 */
export const DEFAULT_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1 };

const KEY_BYTES = 32;
const MAX_CREDENTIAL_VERSIONS = 4;
const SMALLINT_MAX = 32767;

export interface CredentialConfig {
  /** 版本 ↔ HMAC 密钥（至多 4 个）。 */
  readonly credentialKeys: ReadonlyMap<number, Buffer>;
  readonly currentVersion: number;
  readonly retiredVersions: ReadonlySet<number>;
  /** 已判定泄露的版本：部署即生效，凭据实际用过其中任一版本即视为暴露（设计 §2.4）。 */
  readonly compromisedVersions: ReadonlySet<number>;
  /** 登录限频键用的独立密钥（PR-2a 使用），不随凭据密钥轮换。 */
  readonly throttleKey: Buffer;
  readonly outboxKeys: ReadonlyMap<string, Buffer>;
  readonly outboxCurrent: string;
  /** SURVEY360_PORTAL_CREDENTIALS：缺省关闭；关闭时作答链接不进入 pending（维护任务就位前不产生无人发放的等待邀请）。 */
  readonly portalCredentials: boolean;
  readonly kdf: ScryptParams;
  /** TRUSTED_PROXY_CIDRS：套接字对端属于这些网段时才读 X-Forwarded-For（设计 §3.6 代理契约）；缺省空 = 一律用套接字地址。 */
  readonly trustedProxyCidrs: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

function fail(message: string): never {
  throw new Error(`作答凭据配置无效：${message}`);
}

function decodeKey(name: string, label: string, text: string): Buffer {
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES) fail(`${name} 的 ${label} 须为 base64 编码的 ${KEY_BYTES} 字节`);
  return key;
}

function entries(name: string, raw: string | undefined): [string, string][] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      if (at <= 0 || at === part.length - 1) fail(`${name} 的条目须为 标识:base64密钥`);
      return [part.slice(0, at), part.slice(at + 1)];
    });
}

function versionOf(name: string, text: string): number {
  const version = Number(text);
  if (!Number.isInteger(version) || version < 1 || version > SMALLINT_MAX) fail(`${name} 的版本号须为正整数：${text}`);
  return version;
}

function versionList(name: string, raw: string | undefined): Set<number> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => versionOf(name, part)),
  );
}

function required(env: Env, name: string, lenient: boolean): string | undefined {
  const value = env[name]?.trim();
  if (value) return value;
  if (lenient) return undefined;
  return fail(`${name} 缺失`);
}

/** 解析并校验；lenient = development / test：缺省的密钥与当前版本在进程内随机生成。 */
export function parseCredentialConfig(env: Env, options: { readonly lenient: boolean }): CredentialConfig {
  const { lenient } = options;

  const keyText = required(env, 'SURVEY360_CREDENTIAL_KEYS', lenient);
  const credentialKeys = new Map<number, Buffer>();
  if (keyText === undefined) {
    credentialKeys.set(1, randomBytes(KEY_BYTES));
  } else {
    for (const [version, text] of entries('SURVEY360_CREDENTIAL_KEYS', keyText)) {
      const v = versionOf('SURVEY360_CREDENTIAL_KEYS', version);
      if (credentialKeys.has(v)) fail(`SURVEY360_CREDENTIAL_KEYS 的版本 ${v} 重复`);
      credentialKeys.set(v, decodeKey('SURVEY360_CREDENTIAL_KEYS', `版本 ${v} 密钥`, text));
    }
  }
  if (credentialKeys.size < 1 || credentialKeys.size > MAX_CREDENTIAL_VERSIONS) {
    fail(`SURVEY360_CREDENTIAL_KEYS 须有 1～${MAX_CREDENTIAL_VERSIONS} 个版本（至多 4 个）`);
  }

  const currentText = required(env, 'SURVEY360_CREDENTIAL_KEY_CURRENT', lenient && keyText === undefined);
  const currentVersion =
    currentText === undefined
      ? Math.max(...credentialKeys.keys())
      : versionOf('SURVEY360_CREDENTIAL_KEY_CURRENT', currentText);
  if (!credentialKeys.has(currentVersion)) fail('SURVEY360_CREDENTIAL_KEY_CURRENT 必须在 KEYS 里');

  const retiredVersions = versionList('SURVEY360_CREDENTIAL_KEYS_RETIRED', env['SURVEY360_CREDENTIAL_KEYS_RETIRED']);
  for (const v of retiredVersions) {
    if (credentialKeys.has(v)) fail(`SURVEY360_CREDENTIAL_KEYS_RETIRED 的版本 ${v} 不得与 KEYS 重叠`);
  }
  const compromisedVersions = versionList(
    'SURVEY360_CREDENTIAL_KEYS_COMPROMISED',
    env['SURVEY360_CREDENTIAL_KEYS_COMPROMISED'],
  );
  for (const v of compromisedVersions) {
    if (!retiredVersions.has(v)) fail(`SURVEY360_CREDENTIAL_KEYS_COMPROMISED 的版本 ${v} 必须同时在 RETIRED 里`);
  }

  const throttleText = required(env, 'SURVEY360_THROTTLE_KEY', lenient);
  const throttleKey =
    throttleText === undefined ? randomBytes(KEY_BYTES) : decodeKey('SURVEY360_THROTTLE_KEY', '密钥', throttleText);

  const outboxText = required(env, 'SURVEY360_OUTBOX_KEYS', lenient);
  const outboxKeys = new Map<string, Buffer>();
  if (outboxText === undefined) {
    outboxKeys.set('dev', randomBytes(KEY_BYTES));
  } else {
    for (const [kid, text] of entries('SURVEY360_OUTBOX_KEYS', outboxText)) {
      if (outboxKeys.has(kid)) fail(`SURVEY360_OUTBOX_KEYS 的 kid ${kid} 重复`);
      outboxKeys.set(kid, decodeKey('SURVEY360_OUTBOX_KEYS', `kid ${kid} 密钥`, text));
    }
  }
  const outboxCurrent =
    env['SURVEY360_OUTBOX_KEY_CURRENT']?.trim() ||
    (lenient && outboxText === undefined ? 'dev' : fail('SURVEY360_OUTBOX_KEY_CURRENT 缺失'));
  if (!outboxKeys.has(outboxCurrent)) fail('SURVEY360_OUTBOX_KEY_CURRENT 必须在 SURVEY360_OUTBOX_KEYS 里');

  const trustedProxyCidrs = (env['TRUSTED_PROXY_CIDRS'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const cidr of trustedProxyCidrs) {
    if (!isValidCidr(cidr)) fail(`TRUSTED_PROXY_CIDRS 的条目不是合法的 CIDR：${cidr}`);
  }

  return {
    credentialKeys,
    currentVersion,
    retiredVersions,
    compromisedVersions,
    throttleKey,
    outboxKeys,
    outboxCurrent,
    portalCredentials: env['SURVEY360_PORTAL_CREDENTIALS']?.trim() === 'on',
    kdf: DEFAULT_SCRYPT,
    trustedProxyCidrs,
  };
}

/** 形如 10.0.0.0/8 或 fd00::/8（前缀长度必填，避免把单个地址误写成整段）。 */
export function isValidCidr(cidr: string): boolean {
  const [address = '', prefix, ...rest] = cidr.split('/');
  if (rest.length || prefix === undefined || !/^\d{1,3}$/.test(prefix)) return false;
  const length = Number(prefix);
  if (isIPv4(address)) return length <= 32;
  return isIPv6(address) && length <= 128;
}

/** development / test 才允许缺省生成密钥和覆盖配置；其余环境按生产处理。 */
function lenientEnvironment(env: Env = process.env): boolean {
  return env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test';
}

let cached: CredentialConfig | undefined;
let override: Partial<CredentialConfig> | undefined;

function base(): CredentialConfig {
  cached ??= parseCredentialConfig(process.env, { lenient: lenientEnvironment() });
  return cached;
}

/** 进程级配置（首次使用时解析）。issue()、维护任务、运维命令都从这里取。 */
export function credentialConfig(): CredentialConfig {
  return override ? { ...base(), ...override } : base();
}

/** 进程启动时调用：生产配置有误即抛错，进程拒绝启动（设计 §2.4）。 */
export function checkCredentialConfigAtStartup(): CredentialConfig {
  return base();
}

/** 只供测试覆盖（undefined = 还原）；非 development / test 环境直接拒绝，避免被用来绕过生产配置。 */
export function overrideCredentialConfig(patch: Partial<CredentialConfig> | undefined): void {
  if (!lenientEnvironment()) throw new Error('作答凭据配置只允许在 development / test 环境覆盖');
  override = patch;
}
