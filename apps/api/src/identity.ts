/**
 * 身份解析（“你是谁”）。可插拔：生产实现由 B-01 真实登录提供（技术栈评估 §6：Better Auth 会话），
 * 本任务只提供开发 / 测试用的签名头实现。生产环境未配置真实实现时启动即报错，不回退到不安全实现。
 *
 * 与 AGENTS.md §6 所禁止的“平台身份请求头”不同：这里的头必须带 HMAC 签名（密钥只在服务端），
 * 且只在 NODE_ENV=test|development 时才能构造，生产代码路径上根本不存在。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '@italent/db';

export interface IdentityResolver {
  /** 从请求得出已认证的用户 ID；无法认证时返回 null（由调用方统一回 401）。 */
  resolve(request: Request): Promise<string | null> | string | null;
}

/** 未配置身份实现时的缺省值：谁都不认（fail-closed）。 */
export const denyAllIdentity: IdentityResolver = { resolve: () => null };

const DEV_ENVS = new Set(['test', 'development']);
const MIN_SECRET_LENGTH = 32;

export const DEV_IDENTITY_HEADER = {
  user: 'x-dev-user-id',
  signature: 'x-dev-identity-signature',
} as const;

function sign(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(userId).digest('hex');
}

/** 测试 / 本地联调时构造身份头。 */
export function devIdentityHeaders(secret: string, userId: string): Record<string, string> {
  return { [DEV_IDENTITY_HEADER.user]: userId, [DEV_IDENTITY_HEADER.signature]: sign(secret, userId) };
}

export interface DevIdentityOptions {
  readonly secret: string;
  /** 默认取 process.env.NODE_ENV；只允许 test / development。 */
  readonly nodeEnv?: string | undefined;
}

export function createDevIdentityResolver(options: DevIdentityOptions): IdentityResolver {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  if (!nodeEnv || !DEV_ENVS.has(nodeEnv)) {
    throw new Error(`开发身份实现只允许在 NODE_ENV=test|development 下使用（当前：${nodeEnv ?? '未设置'}）`);
  }
  if (options.secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`开发身份签名密钥至少 ${MIN_SECRET_LENGTH} 个字符`);
  }
  return {
    resolve(request) {
      const userId = request.headers.get(DEV_IDENTITY_HEADER.user);
      const signature = request.headers.get(DEV_IDENTITY_HEADER.signature);
      if (!userId || !signature || !isUuid(userId)) return null;
      const expected = Buffer.from(sign(options.secret, userId), 'hex');
      const actual = Buffer.from(signature, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? userId : null;
    },
  };
}

/** 进程入口按环境选择身份实现；生产未接入真实登录时直接抛错，阻止启动。 */
export function identityResolverFromEnv(env: NodeJS.ProcessEnv = process.env): IdentityResolver {
  if (env.NODE_ENV && DEV_ENVS.has(env.NODE_ENV)) {
    const secret = env.DEV_IDENTITY_SECRET;
    if (!secret) throw new Error('开发环境缺少 DEV_IDENTITY_SECRET（见 .env.example）');
    return createDevIdentityResolver({ secret, nodeEnv: env.NODE_ENV });
  }
  // TODO(B-01)：接入真实登录（会话 Cookie → userId）后在此返回生产实现
  throw new Error('未配置真实身份认证（B-01 真实登录尚未实现），拒绝在非开发环境启动');
}
