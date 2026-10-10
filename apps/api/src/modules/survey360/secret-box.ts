/**
 * outbox 秘密字段加密（F-076 设计 §2.6；AGENTS §5，DEC-377②）：AES-256-GCM，128 位认证标签，
 * 每次封装用 CSPRNG 新生成的 12 字节 IV；AAD = 租户:outbox 行:事件类型，密文挪到别的行或别的租户无法解封。
 * 明文是 JSON `{ token, serial?, password? }`。密钥只来自配置（credential-config.ts），库里只有密文。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed {
  readonly v: 1;
  readonly kid: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

export interface SealContext {
  readonly tenantId: string;
  readonly outboxId: string;
  readonly eventType: string;
}

export interface SealedSecrets {
  token?: string;
  serial?: string;
  password?: string;
}

interface BoxKeys {
  readonly outboxKeys: ReadonlyMap<string, Buffer>;
  readonly outboxCurrent: string;
}

const aad = (ctx: SealContext) => Buffer.from(`${ctx.tenantId}:${ctx.outboxId}:${ctx.eventType}`, 'utf8');

/** 用 CURRENT kid 封装；每次调用都是新 IV。 */
export function sealJson(config: BoxKeys, plain: SealedSecrets, ctx: SealContext): Sealed {
  const key = config.outboxKeys.get(config.outboxCurrent);
  if (!key) throw new Error(`outbox 当前 kid 不在配置里：${config.outboxCurrent}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(ctx));
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return {
    v: 1,
    kid: config.outboxCurrent,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

/** 按 sealed.kid 取密钥解封；kid 不在配置里、AAD 不符、密文或标签被改动都抛错。 */
export function openSealed(config: BoxKeys, sealed: Sealed, ctx: SealContext): SealedSecrets {
  if (sealed.v !== 1) throw new Error(`不支持的 sealed 版本：${String(sealed.v)}`);
  const key = config.outboxKeys.get(sealed.kid);
  if (!key) throw new Error(`outbox 密钥 kid 不在配置里：${sealed.kid}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
  decipher.setAAD(aad(ctx));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as SealedSecrets;
}
