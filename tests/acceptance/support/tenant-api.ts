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
  eq,
  grantMembership,
  type PlatformCommandMeta,
  tenants,
  type Tenant,
  type User,
  withPlatform,
} from '@italent/db';
import { runWithAuditRequest } from '../../../apps/api/src/audit/request-context.js';
import { AppError } from '../../../apps/api/src/errors.js';
import { runCommand } from '../../../apps/api/src/commands.js';
import { normalizeEmploymentInput } from '../../../apps/api/src/modules/employment/fields.js';
import {
  createEmploymentBusiness,
  requireSavedBusiness,
} from '../../../apps/api/src/modules/employment/write-service.js';

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

/**
 * F-082（F082-5）：总开关默认已打开。B5 时代的计算规则套件断言的是开关关闭路径（名称存储、B5 响应形状），
 * 在文件顶部 import './support/b5-path.js' 把本文件内未显式指定开关的应用固定为关闭路径；显式传 formulaIdBinding 的不受影响。
 */
let pinnedFormulaIdBinding: boolean | undefined;
export function pinFormulaIdBinding(value: boolean): void {
  pinnedFormulaIdBinding = value;
}

/**
 * R2-T03 B2a：离职创建经门禁后，直接离职只存 approved、不落地（设计 §18.1），而存量验收用例大量把“已离职员工”当作前置夹具。
 * 缺省（'seed'）把经通用入口创建 kind=leave 的请求改走服务端可信端口 ctx.trustedExit='seed'（进程内、与 HTTP 同一命令台账 / 审计 / 事务），
 * 行为与门禁之前的 main 相同；离职门禁自己的验收文件 import './support/exit-gate-enforced.js' 切到 'enforce'，走真实门禁。
 */
let exitGateMode: 'seed' | 'enforce' = 'seed';
export function pinExitGate(mode: 'seed' | 'enforce'): void {
  exitGateMode = mode;
}

const LEAVE_CREATE = /^\/api\/tenant\/employment\/employees\/([0-9a-f-]{36})\/businesses$/;

export function tenantApi(db: Db, deps: Omit<AppDeps, 'db' | 'identity'> = {}) {
  const secret = randomBytes(32).toString('hex');
  const app = createApp({
    authorize: allowAll,
    ...(pinnedFormulaIdBinding === undefined ? {} : { formulaIdBinding: pinnedFormulaIdBinding }),
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
    const seeded =
      exitGateMode === 'seed' && method === 'POST' && (!('authorize' in deps) || deps.authorize === allowAll)
        ? LEAVE_CREATE.exec(path)
        : null;
    if (seeded && (options.body as { kind?: string } | undefined)?.kind === 'leave' && options.user && options.tenant)
      return seedLeave(seeded[1]!, options, key ?? undefined);
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    return Promise.resolve(app.request(path, { method, headers, body, signal: options.signal }));
  }

  async function seedLeave(employeeId: string, options: RequestOptions, key: string | undefined) {
    const [tenant] = await withPlatform(db, (tx) => tx.select().from(tenants).where(eq(tenants.id, options.tenant!)));
    const ctx = {
      tenantId: options.tenant!,
      userId: options.user!,
      timezone: tenant!.timezone,
      now: (deps.clock ?? (() => new Date()))(),
      commandId: key ?? randomUUID(),
      expectedRevision: Number(options.ifMatch ?? 0),
      trustedExit: 'seed' as const,
    };
    try {
      const clock = deps.clock ?? (() => new Date());
      const result = await runWithAuditRequest(
        { clock, method: 'POST', path: `employees/${employeeId}/businesses` },
        () =>
          runCommand(db, ctx, {
            id: key,
            fingerprint: { method: 'POST', path: `employees/${employeeId}/businesses`, input: options.body },
            execute: async (tx, commandId) => {
              const context = { ...ctx, commandId };
              const input = normalizeEmploymentInput(context, options.body);
              const created = await createEmploymentBusiness(tx, context, employeeId, input);
              return { status: 201, body: await requireSavedBusiness(tx, context, created.id) };
            },
          }),
      );
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      // 与 app.onError 同口径：业务错误按码返回，其余一律 500 不外泄
      const known = error instanceof AppError;
      const body = known
        ? { error: { code: error.code, message: error.message, details: error.details } }
        : { error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } };
      return new Response(JSON.stringify(body), {
        status: known ? error.status : 500,
        headers: { 'content-type': 'application/json' },
      });
    }
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
