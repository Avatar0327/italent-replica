/**
 * 平台接口 /api/platform/*（REQ-PLT-001；R1-T17）：只对平台运营身份开放（context.ts），与 /api/tenant/* 的
 * 租户上下文与权限模型互不相通。写请求必须带 Idempotency-Key（平台命令台账，同键同内容重放、异内容 409）；
 * 改已有对象必须带 If-Match revision（409 后由客户端刷新显式重提，AGENTS.md §10）。
 */
import {
  and,
  createUser,
  type Db,
  desc,
  eq,
  isUuid,
  pgErrorCode,
  platformCommandFailures,
  type PlatformCommandMeta,
  recordPlatformEntryFailure,
  runInPlatformFailureScope,
  withPlatform,
} from '@italent/db';
import { isValidTimeZone } from '@italent/domain';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { IdentityResolver } from '../../identity.js';
import { etag, ifMatch, parseBody } from '../permission/http.js';
import { LICENSE_TYPE } from '../permission/licenses.js';
import { operatorOf, platformContext, type PlatformEnv } from './context.js';
import { changeTenantLifecycle, issueLicense, requireTenant, tenantBalances } from './operations.js';
import { provisionTenant, tenantView } from './provisioning.js';

const COMMAND_ID = /^[A-Za-z0-9:_-]{1,100}$/;
const userId = z.uuid();

const provisionBody = z.strictObject({
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  timezone: z.string().max(64).refine(isValidTimeZone, '非法的 IANA 时区').optional(),
  firstAdminUserId: userId,
  // 开通时必须指定预置流程的异常管理员并直接发布（R1-T17 第 2 项；不留“未可用”的草稿流程）
  exceptionAdminUserId: userId,
  licenses: z
    .array(z.strictObject({ licenseType: z.string().regex(LICENSE_TYPE), quota: z.number().int().min(0) }))
    .max(20)
    .refine((items) => new Set(items.map((i) => i.licenseType)).size === items.length, '许可类型不能重复')
    .optional(),
});

const statusBody = z.strictObject({ status: z.enum(['active', 'suspended']) });
const quotaBody = z.strictObject({ quota: z.number().int().min(0).max(10_000_000) });
const userBody = z.strictObject({ email: z.email().max(320), displayName: z.string().trim().min(1).max(200) });

function meta(c: Context<PlatformEnv>): PlatformCommandMeta {
  const commandId = c.req.header('idempotency-key');
  if (commandId === undefined) throw new AppError('IDEMPOTENCY_KEY_REQUIRED', '写请求必须携带 Idempotency-Key');
  if (!COMMAND_ID.test(commandId)) throw new AppError('VALIDATION_FAILED', 'Idempotency-Key 格式不合法');
  return { actorUserId: operatorOf(c).userId, commandId };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * DEC-199 / PR #75 第三轮 P2-2：平台写命令在进入执行器之前就失败（请求体、If-Match、参数校验）也写平台失败通道。
 * 挂在平台身份中间件之后（可信平台运营才记录）；只认携带合法命令 ID 的写请求；本次请求内执行器已记过的不再重复（请求级状态，第四轮 N3）。
 */
function capturePlatformFailures(db: Db): MiddlewareHandler<PlatformEnv> {
  return async (c, next) => {
    // 请求级“已记录”状态（第四轮 N3）：执行器在本次请求内记过失败，路由再把错误转换成别的应用错误也不重复记录
    const scope = { recorded: false };
    await runInPlatformFailureScope(scope, () => next());
    const error = c.error;
    const commandId = c.req.header('idempotency-key');
    if (!error || scope.recorded || !WRITE_METHODS.has(c.req.method) || !commandId || !COMMAND_ID.test(commandId)) {
      return;
    }
    const tenantId = c.req.param('tenantId');
    const operation = `${c.req.method} ${c.req.routePath}`;
    await recordPlatformEntryFailure(
      db,
      { actorUserId: operatorOf(c).userId, commandId },
      operation,
      tenantId && isUuid(tenantId) ? tenantId.toLowerCase() : null,
      error,
    );
  };
}

function tenantParam(c: Context): string {
  const id = c.req.param('tenantId') ?? '';
  if (!isUuid(id)) throw new AppError('NOT_FOUND', '租户不存在');
  return id;
}

export function createPlatformRouter(db: Db, identity: IdentityResolver, clock: () => Date): Hono<PlatformEnv> {
  const router = new Hono<PlatformEnv>();
  router.use('/api/platform/*', platformContext(db, identity));
  router.use('/api/platform/*', capturePlatformFailures(db));

  router.post('/api/platform/users', async (c) => {
    const body = await parseBody(c, userBody);
    const user = await createUser(db, body, meta(c)).catch((error: unknown) => {
      if (pgErrorCode(error) === '23505') throw new AppError('CONFLICT', '登录邮箱已存在', { reason: 'EMAIL_TAKEN' });
      throw error;
    });
    return c.json({ id: user.id, email: user.email, displayName: user.displayName, status: user.status }, 201);
  });

  router.post('/api/platform/tenants', async (c) => {
    const body = await parseBody(c, provisionBody);
    return c.json(await provisionTenant(db, body, meta(c), clock()), 201);
  });

  // DEC-199：平台命令失败的受限通道，只对平台运营开放（租户审计查询里看不到）
  router.get('/api/platform/command-failures', async (c) => c.json(await platformFailures(db, c)));

  router.get('/api/platform/tenants/:tenantId', async (c) => {
    const tenant = tenantView(await requireTenant(db, tenantParam(c)));
    etag(c, tenant.revision);
    return c.json(tenant);
  });

  router.post('/api/platform/tenants/:tenantId/status', async (c) => {
    const tenantId = tenantParam(c);
    const expectedRevision = ifMatch(c);
    const { status } = await parseBody(c, statusBody);
    const tenant = tenantView(await changeTenantLifecycle(db, { tenantId, status, expectedRevision }, meta(c)));
    etag(c, tenant.revision);
    return c.json(tenant);
  });

  router.get('/api/platform/tenants/:tenantId/licenses', async (c) =>
    c.json({ items: await tenantBalances(db, tenantParam(c)) }),
  );

  router.put('/api/platform/tenants/:tenantId/licenses/:licenseType', async (c) => {
    const tenantId = tenantParam(c);
    const licenseType = c.req.param('licenseType');
    if (!LICENSE_TYPE.test(licenseType)) throw new AppError('VALIDATION_FAILED', '许可类型编码不合法');
    const expectedRevision = ifMatch(c);
    const { quota } = await parseBody(c, quotaBody);
    const balance = await issueLicense(db, { tenantId, licenseType, quota, expectedRevision }, meta(c));
    etag(c, balance.revision);
    return c.json(balance);
  });

  return router;
}

const failureQuery = z.strictObject({
  commandId: z.string().regex(COMMAND_ID).optional(),
  subjectTenantId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

async function platformFailures(db: Db, c: Context<PlatformEnv>) {
  const parsed = failureQuery.safeParse(c.req.query());
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '查询条件不合法', parsed.error.issues);
  const { commandId, subjectTenantId, limit } = parsed.data;
  const t = platformCommandFailures;
  const items = await withPlatform(db, (tx) =>
    tx
      .select()
      .from(t)
      .where(
        and(
          commandId ? eq(t.commandId, commandId) : undefined,
          subjectTenantId ? eq(t.subjectTenantId, subjectTenantId) : undefined,
        ),
      )
      .orderBy(desc(t.occurredAt), desc(t.id))
      .limit(limit),
  );
  return { items: items.map((row) => ({ ...row, occurredAt: new Date(row.occurredAt).toISOString() })) };
}
