/**
 * Offer 模块的请求上下文与写入出口（R2 BE-14a C1）。权限按 Offer 对象（TenantBase.Offer）的对象 / 字段权限判断，
 * 数据范围按录用部门（组织维度）与创建人（使用用户维度）裁剪，默认空（fail-closed）；system_admin 不越过对象权限
 * （DEC-503）。写命令一律经 runCommand 的 ledgerExit + CommandGuard.before：首次、重放、失败回查都按当前权限复核（#199）。
 */
import { type Tx } from '@italent/db';
import { OFFER_OBJECT } from '@italent/domain';
import type { Context } from 'hono';
import { requirePermission, type Authorizer } from '../../authorization.js';
import { runCommand, type CommandGuard, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantContext, type TenantEnv } from '../../tenant-context.js';
import { EMPTY_SCOPE } from '../permission/scope-types.js';
import {
  authorizeInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllows,
  trimModuleResponse,
  type ModuleScope,
} from '../permission/module-access.js';
import { objectContext, requestScope, writeFields } from '../permission/module-route-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
import { revision } from '../job/context.js';

/**
 * 两个 Offer 字典挂在任职设置配置对象上（与离职三个字典同一对象，字段 code / name / enabled / displayOrder）：
 * 写入按 tenant.employment.configuration.write + 配置对象字段编辑权授权，配置对象不带数据范围。
 */
export const OFFER_DICTIONARY_OBJECT = 'TenantBase.EmploymentSettings';
const CONFIGURATION_WRITE = 'tenant.employment.configuration.write';

export interface OfferContext extends TenantContext {
  readonly now: Date;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly scope: ModuleScope;
}

/** 读：对象查看权 + 当前数据范围（列表 / 详情按页面编码解析，DEC-121 无组织对象须看全部）。 */
export async function offerReadContext(c: Context<TenantEnv>, deps: TenantRouteDeps, objectCode = OFFER_OBJECT) {
  const base = await objectContext(c, deps, objectCode, 'view');
  return { ...base, scope: await requestScope(c, deps, base, objectCode) } satisfies OfferContext;
}

export type OfferOperation = 'create' | 'update' | 'delete';

/**
 * 写命令的权限复核：事务外先判一次（拒绝不入台账），事务内由 CommandGuard.before 按当前授权再判，撤权后同键重放也拒绝。
 * 每类写入口用各自的判定函数，不共用分支（F-039 按处理函数闭包取现状）。
 */
export type OfferCheck = (authorize: Authorizer, ctx: OfferContext) => Promise<void>;

/** 新建 / 编辑：对象数据操作 + 实际写入字段的编辑权。 */
export const offerFieldsCheck =
  (operation: 'create' | 'update', fields: Readonly<Record<string, unknown>>): OfferCheck =>
  (authorize, ctx) =>
    writeFields({ authorize }, ctx, OFFER_OBJECT, operation, fields);

/** 删除 / 复制：只判对象数据操作开关，不提取字段。 */
export const offerOperationCheck =
  (operation: OfferOperation): OfferCheck =>
  (authorize, ctx) =>
    requirePermission(authorize, { ...ctx, action: `object.${operation}`, resource: OFFER_OBJECT, fields: [] });

/** Offer 写入口：execute 拿到的上下文带本事务重新解析的数据范围；响应按字段查看权裁剪。 */
export async function runOfferWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  input: unknown,
  operation: OfferOperation,
  check: OfferCheck,
  execute: (tx: Tx, ctx: OfferContext) => Promise<CommandResult>,
  options: {
    readonly isNew?: boolean;
    /** 重放命中台账后复核结果对象仍在当前范围内（撤范围后同键重放不再交出原响应）。 */
    readonly replayed?: (tx: Tx, ctx: OfferContext, body: unknown) => Promise<void>;
  } = {},
) {
  const expectedRevision = revision(c);
  if (options.isNew && expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '新建对象的 revision 必须为 0');
  const base = await objectContext(c, deps, OFFER_OBJECT, operation, expectedRevision);
  const ctx: OfferContext = { ...base, scope: await requestScope(c, deps, base, OFFER_OBJECT) };
  await check(deps.authorize, ctx);
  const inTransaction = async (tx: Tx): Promise<OfferContext> => ({
    ...ctx,
    scope: await resolveModuleScopeInTransaction(deps, ctx, tx, OFFER_OBJECT),
  });
  const guard: CommandGuard = {
    before: async (tx) => check(authorizeInTransaction(deps.authorize, tx), await inTransaction(tx)),
    ...(options.replayed
      ? { replayed: async (tx, replay) => options.replayed!(tx, await inTransaction(tx), replay.body) }
      : {}),
  };
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: ctx.expectedRevision, input },
    guard,
    execute: async (tx, commandId) => execute(tx, { ...(await inTransaction(tx)), commandId }),
  });
  const body = result.body as { revision?: number } | null;
  if (body?.revision !== undefined) c.header('ETag', `"${body.revision}"`);
  return c.json(await trimOffer(deps, ctx, result.body), result.status);
}

/**
 * 字典写入口（配置对象，无数据范围）：tenant.employment.configuration.write + 任职设置对象的字段编辑权，事务内复核；
 * 响应是字典项固定键，不按 Offer 字段裁剪。
 */
export async function runDictionaryWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  input: unknown,
  operation: 'create' | 'update',
  fields: Readonly<Record<string, unknown>>,
  execute: (tx: Tx, ctx: OfferContext) => Promise<CommandResult>,
) {
  const expectedRevision = revision(c);
  if (operation === 'create' && expectedRevision !== 0)
    throw new AppError('REVISION_CONFLICT', '新建对象的 revision 必须为 0');
  const ctx: OfferContext = { ...tenantOf(c), expectedRevision, now: deps.clock(), commandId: '', scope: EMPTY_SCOPE };
  const allowed = async (authorize: Authorizer) => {
    await requirePermission(authorize, { ...ctx, action: CONFIGURATION_WRITE, resource: OFFER_DICTIONARY_OBJECT });
    await requireObjectWrite(authorize, ctx, { objectCode: OFFER_DICTIONARY_OBJECT, operation, payload: fields });
  };
  await allowed(deps.authorize);
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, revision: expectedRevision, input },
    guard: { before: (tx) => allowed(authorizeInTransaction(deps.authorize, tx)) },
    execute: async (tx, commandId) => execute(tx, { ...ctx, commandId }),
  });
  const body = result.body as { revision?: number } | null;
  if (body?.revision !== undefined) c.header('ETag', `"${body.revision}"`);
  return c.json(result.body, result.status);
}

/** 字段裁剪：items 逐行按对象字段查看权裁剪；分页信封与删除回执不裁。 */
export async function trimOffer(deps: TenantRouteDeps, ctx: OfferContext, body: unknown) {
  if (!body || typeof body !== 'object') return body;
  const value = body as Record<string, unknown>;
  if (Array.isArray(value.items))
    return { ...value, items: await trimModuleResponse(deps, ctx, OFFER_OBJECT, value.items as object[]) };
  if (value.deleted === true) return value;
  return trimModuleResponse(deps, ctx, OFFER_OBJECT, value);
}

/** Offer 落在当前范围内：录用部门命中组织维度，或创建人命中使用用户维度；范围外与不存在同为 404。 */
export function requireOfferInScope(
  ctx: OfferContext,
  offer: { readonly departmentId: string | null; readonly createdBy: string },
) {
  if (!scopeAllows(ctx.scope, { orgId: offer.departmentId, creatorId: offer.createdBy }))
    throw new AppError('NOT_FOUND', 'Offer 不存在');
}

export function assertOfferRevision(expected: number, actual: number) {
  if (expected !== actual)
    throw new AppError('REVISION_CONFLICT', 'Offer 已变更，请刷新后显式重提', { expected, actual });
}
