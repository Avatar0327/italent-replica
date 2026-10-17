/**
 * Offer 模块的请求上下文与写入出口（R2 BE-14a）。权限按 Offer 对象（TenantBase.Offer）的对象 / 字段 / 按钮权限判断，
 * 数据范围按录用部门（组织维度）与创建人（使用用户维度）裁剪，默认空（fail-closed）；system_admin 不越过对象权限
 * （DEC-503）。写命令一律经 runCommand 的 ledgerExit + CommandGuard.before：首次、重放、失败回查都按当前权限复核（#199）。
 */
import { type Tx } from '@italent/db';
import { OFFER_OBJECT, type ButtonLevel } from '@italent/domain';
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
import { button, objectContext, requestScope, writeFields } from '../permission/module-route-access.js';
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
 * 写命令的当前权限复核，事务内执行（CommandGuard.before）：操作开关、实际写入的字段、可选按钮。撤权之后同键重放也拒绝。
 */
export interface OfferWriteCheck {
  readonly operation: OfferOperation;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly button?: { readonly code: string; readonly level: ButtonLevel };
}

async function check(authorize: Authorizer, ctx: OfferContext, objectCode: string, write: OfferWriteCheck) {
  const deps = { authorize };
  if (objectCode === OFFER_DICTIONARY_OBJECT)
    await requirePermission(authorize, { ...ctx, action: CONFIGURATION_WRITE, resource: objectCode });
  if (write.operation === 'delete') {
    if (!(await authorize({ ...ctx, action: 'object.delete', resource: objectCode })))
      throw new AppError('FORBIDDEN', '无权删除');
  } else await writeFields(deps, ctx, objectCode, write.operation, write.fields ?? {});
  if (write.button) await button(deps as TenantRouteDeps, ctx, objectCode, write.button.code, write.button.level);
}

/**
 * 写入口：事务外先做一次授权判定（拒绝不入台账），事务内由 guard 按当前授权与当前范围复核；execute 拿到的上下文
 * 带本事务重新解析的数据范围。
 */
export async function runOfferWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  input: unknown,
  write: OfferWriteCheck,
  execute: (tx: Tx, ctx: OfferContext) => Promise<CommandResult>,
  options: {
    readonly objectCode?: string;
    readonly isNew?: boolean;
    /** 重放命中台账后复核结果对象仍在当前范围内（撤范围后同键重放不再交出原响应）。 */
    readonly replayed?: (tx: Tx, ctx: OfferContext, body: unknown) => Promise<void>;
  } = {},
) {
  const objectCode = options.objectCode ?? OFFER_OBJECT;
  const configuration = objectCode === OFFER_DICTIONARY_OBJECT;
  const expectedRevision = revision(c);
  if (options.isNew && expectedRevision !== 0) throw new AppError('REVISION_CONFLICT', '新建对象的 revision 必须为 0');
  const base = configuration
    ? { ...tenantOf(c), expectedRevision, now: deps.clock(), commandId: '' }
    : await objectContext(c, deps, objectCode, write.operation, expectedRevision);
  const ctx: OfferContext = {
    ...base,
    scope: configuration ? EMPTY_SCOPE : await requestScope(c, deps, base, objectCode),
  };
  await check(deps.authorize, ctx, objectCode, write);
  const inTransaction = async (tx: Tx): Promise<OfferContext> => ({
    ...ctx,
    scope: configuration ? EMPTY_SCOPE : await resolveModuleScopeInTransaction(deps, ctx, tx, objectCode),
  });
  const guard: CommandGuard = {
    before: async (tx) => check(authorizeInTransaction(deps.authorize, tx), await inTransaction(tx), objectCode, write),
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
  return c.json(await trimOffer(deps, ctx, objectCode, result.body), result.status);
}

/** 协议元数据（行操作、转移候选），不是对象字段，不参与字段裁剪。 */
const PROTOCOL_KEYS = ['rowActions', 'targets'] as const;

/** 字段裁剪：items 逐行按对象字段查看权裁剪；分页与协议元数据不裁。 */
export async function trimOffer(deps: TenantRouteDeps, ctx: OfferContext, objectCode: string, body: unknown) {
  if (!body || typeof body !== 'object') return body;
  const value = body as Record<string, unknown>;
  const trimRow = async (row: Record<string, unknown>) => {
    const kept = PROTOCOL_KEYS.filter((key) => key in row);
    const rest = Object.fromEntries(Object.entries(row).filter(([key]) => !kept.includes(key as never)));
    const trimmed = await trimModuleResponse(deps, ctx, objectCode, rest);
    return { ...trimmed, ...Object.fromEntries(kept.map((key) => [key, row[key]])) };
  };
  if (Array.isArray(value.items))
    return { ...value, items: await Promise.all((value.items as Record<string, unknown>[]).map(trimRow)) };
  if (value.deleted === true) return value;
  return trimRow(value);
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
