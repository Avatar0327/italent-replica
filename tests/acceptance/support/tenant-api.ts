/**
 * 多租户验收测试的公共装配：建租户 / 用户 / 成员关系（走平台路径），
 * 并用开发期签名身份头构造请求。签名密钥每次运行随机生成，不入库、不入仓。
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
  type AppDeps,
  type Authorizer,
  createApp,
  createDevIdentityResolver,
  devIdentityHeaders,
  type ErrorBody,
} from '@italent/api';
import {
  createTenant,
  createUser,
  type Db,
  grantMembership,
  type PlatformCommandMeta,
  type Tenant,
  type User,
} from '@italent/db';

/** 测试中注入“全部允许”的授权钩子；真实判定由 R1-T01 接入。 */
export const allowAll: Authorizer = () => true;

export interface RequestOptions {
  readonly user?: string;
  readonly tenant?: string;
  readonly body?: unknown;
  readonly ifMatch?: string | number;
  /** 写请求缺省自动生成；传 null 表示故意不带（验证 400）。 */
  readonly idempotencyKey?: string | null;
  /** 额外请求头（审计来源：X-Forwarded-For、User-Agent、X-Source-Page 等，R1-T16）。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 请求的中止信号（模拟客户端断开；F-080）。 */
  readonly signal?: AbortSignal;
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function tenantApi(db: Db, deps: Omit<AppDeps, 'db' | 'identity'> = {}) {
  const secret = randomBytes(32).toString('hex');
  const app = createApp({
    authorize: allowAll,
    ...deps,
    db,
    identity: createDevIdentityResolver({ secret, nodeEnv: 'test' }),
  });

  function request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.user) Object.assign(headers, devIdentityHeaders(secret, options.user));
    if (options.tenant) headers['x-tenant-id'] = options.tenant;
    if (options.ifMatch !== undefined) headers['if-match'] = `"${options.ifMatch}"`;
    const key =
      options.idempotencyKey === undefined && WRITE_METHODS.has(method) ? randomUUID() : options.idempotencyKey;
    if (key) headers['idempotency-key'] = key;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    return Promise.resolve(app.request(path, { method, headers, body, signal: options.signal }));
  }

  return { app, request };
}

/** 平台命令元信息：新的命令 ID；操作人缺省为平台方（null）。 */
export function cmd(actorUserId: string | null = null): PlatformCommandMeta {
  return { actorUserId, commandId: randomUUID() };
}

export async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ErrorBody).error.code;
}

/** 建一个租户和它的一名成员。编码加随机后缀，避免同一测试库内重复。 */
export async function seedTenantWithMember(
  db: Db,
  label: string,
  timezone?: string,
): Promise<{ tenant: Tenant; user: User }> {
  const suffix = randomUUID();
  const tenant = await createTenant(db, { code: `${label}-${suffix}`, name: `租户${label}`, timezone }, cmd());
  const user = await createUser(db, { email: `${label}-${suffix}@example.com`, displayName: `${label} 管理员` }, cmd());
  await grantMembership(db, { tenantId: tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
  return { tenant, user };
}
