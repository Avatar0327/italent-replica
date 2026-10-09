/**
 * 任职资格路由的公共部分：写命令上下文、命令执行（首次与幂等重放都按当前范围复核结果对象、按当前字段权限裁剪响应，
 * DEC-067 / AGENTS §10；第 2 轮 P2-01）、标准响应的通用指标内容投影（§5.2 #2）。
 */
import { sql, withTenant, type Tx } from '@italent/db';
import type { Context } from 'hono';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, scopeAllows } from '../permission/module-access.js';
import { JOB_OBJECT_CODES, requestScope, writeFields } from '../permission/module-route-access.js';
import type { ScopedJobKind } from '../permission/module-contracts.js';
import {
  ANCHOR,
  codeOf,
  fieldVisible,
  type ModuleScope,
  objectFields,
  qlReadable,
  QUALIFICATION_LABELS,
  type QualificationContext,
  type QualificationObject,
  qualificationScope,
  requireReadable,
  rowsOf,
  trimQualification,
} from './access.js';
import type * as config from './config-service.js';
import type * as read from './read-model.js';
import { rowAccess, type WriteContext } from './store.js';

export const QL_BASE = '/api/tenant/qualification';

export type View = { readonly id: string; readonly revision: number } & Record<string, unknown>;

/** 写命令的上下文：本对象范围、引用对象范围、要读取的字段（指标说明：新格带入，§5.2 #1）、岗职务的读取权限。 */
export async function writeContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: QualificationObject,
  references: readonly QualificationObject[],
  jobs: readonly ScopedJobKind[] = [],
): Promise<config.ConfigWriteContext> {
  const scopes: Partial<Record<QualificationObject, ModuleScope | null>> = {};
  for (const ref of references) {
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(ref), fields: [] });
    scopes[ref] = canView ? await qualificationScope(c, deps, ctx, ref) : null;
  }
  const jobAccess: Partial<
    Record<ScopedJobKind, { scope: ModuleScope; fields: ReadonlySet<string> | undefined } | null>
  > = {};
  for (const kind of jobs) {
    const code = JOB_OBJECT_CODES[kind];
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] });
    jobAccess[kind] = canView
      ? { scope: await requestScope(c, deps, ctx, code), fields: await getModuleViewableFields(deps, ctx, code) }
      : null;
  }
  return {
    ...ctx,
    scope: await qualificationScope(c, deps, ctx, object),
    scopes,
    fields: {
      ...(references.includes('target') ? { target: await objectFields(deps, ctx, 'target') } : {}),
      // 关联岗职务冲突时，已关联对象的名称按操作人对本对象名称字段的查看权带出（P2-03）
      ...(jobs.length ? { [object]: await objectFields(deps, ctx, object) } : {}),
    },
    jobs: jobAccess,
  };
}

/** 操作人当前对某字段有无编辑权（不抛错）：派生写入（如改关联类型清空关联）在命令内据此拦截。 */
export async function fieldEditable(
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: QualificationObject,
  field: string,
): Promise<boolean> {
  try {
    await writeFields(deps, ctx, codeOf(object), 'update', { [field]: null });
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'FORBIDDEN') return false;
    throw error;
  }
}

/**
 * 命令的结果怎么复核与呈现：`recheck` 按当前范围复核结果对象（不可见与不存在同一个 404），`present` 按当前字段权限
 * 裁剪响应。缺省：结果是本对象的一行，按读取谓词复核，按对象字段裁剪。
 */
export interface Outcome<T> {
  readonly recheck: (value: T) => Promise<void>;
  readonly present: (value: T) => Promise<unknown>;
}

/**
 * 命令执行：范围在事务外按当前权限解析，首次执行在事务内逐个复核（行锁之后）；首次与幂等重放都按当前范围复核结果
 * 对象（撤权后重放 404），响应按当前字段权限裁剪（AGENTS §10，第 2 轮 P2-01）。
 */
export async function runWrite<T>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: QualificationObject,
  body: object,
  status: 200 | 201,
  execute: (tx: Tx, ctx: WriteContext) => Promise<T>,
  outcome?: Outcome<T>,
) {
  const result = await runCommand(deps.db, w, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: w.expectedRevision, input: body },
    execute: async (tx, commandId) => ({ status, body: await execute(tx, { ...w, commandId }) }),
  });
  const value = result.body as T;
  const { recheck, present } = outcome ?? objectOutcome(c, deps, w, object, c.req.method);
  await recheck(value);
  const revision = (value as { revision?: unknown }).revision;
  if (typeof revision === 'number' && c.req.method !== 'DELETE') c.header('ETag', `"${revision}"`);
  return c.json((await present(value)) as object, result.status);
}

function objectOutcome<T>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  w: WriteContext,
  object: QualificationObject,
  method: string,
): Outcome<T> {
  return {
    recheck: (value) => requireStillVisible(deps, w, object, value as unknown as View, method),
    present: async (value) => (await presenter(deps, object)(c, w, [value as unknown as View]))[0],
  };
}

/** 按当前读取谓词复核若干结果对象：任一不可见即与不存在同一个 404。 */
export async function requireAllVisible(
  deps: TenantRouteDeps,
  w: WriteContext,
  object: QualificationObject,
  ids: readonly string[],
) {
  await withTenant(deps.db, w.tenantId, async (tx) => {
    for (const id of ids) requireReadable((await rowAccess(tx, w, w.scope, object, id)).access, object);
  });
}

/** 重放时按当前范围复核结果对象：现存对象按读取谓词，已删除对象按快照的锚点（删除要求可写，不看向下公开）。 */
async function requireStillVisible(
  deps: TenantRouteDeps,
  w: WriteContext,
  object: QualificationObject,
  value: View,
  method: string,
) {
  if (method !== 'DELETE') return requireAllVisible(deps, w, object, [value.id]);
  const target =
    ANCHOR[object] === 'dictionary'
      ? { creatorId: value.createdBy as string }
      : { orgId: value.ownerOrgId as string, creatorId: value.ownerId as string };
  if (!scopeAllows(w.scope, target)) throw new AppError('NOT_FOUND', `${QUALIFICATION_LABELS[object]}不存在`);
}

/**
 * 按字段权限裁剪；标准里通用指标覆盖写入的能力标准另按查看人当前对 Target.description 的查看权与该指标的读取范围
 * 给出（§5.2 #2）：看不到只留标记 projectionHidden，不给内容。
 */
export function presenter(deps: TenantRouteDeps, object: QualificationObject) {
  return async <T extends object>(c: Context<TenantEnv>, ctx: QualificationContext, items: T[]) => {
    if (object !== 'standard') return trimQualification(deps, ctx, object, items);
    const shaped = await hideOverwritten(c, deps, ctx, items as unknown as read.StandardView[]);
    return trimQualification(deps, ctx, object, shaped);
  };
}

/** 查看人当前读取范围内的同类对象（在给定的 ID 里）；没有对象查看权时为空。 */
export async function readableIds(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: 'category' | 'level' | 'target',
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (!ids.length) return new Set();
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(object), fields: [] }))) {
    return new Set();
  }
  const scope = await qualificationScope(c, deps, ctx, object);
  const table = { category: 'ql_categories', level: 'ql_levels', target: 'ql_targets' }[object];
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT t.id FROM ${sql.identifier(table)} t
      WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.id = ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[])
        AND ${qlReadable(ctx, scope, 't')}`);
    return new Set(rowsOf<{ id: string }>(result).map((row) => row.id));
  });
}

async function hideOverwritten(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  items: read.StandardView[],
) {
  const sources = items.flatMap((item) =>
    item.details.flatMap((detail) =>
      detail.abilities.filter((a) => a.source === 'common_overwrite').map((a) => a.sourceTargetId!),
    ),
  );
  if (!sources.length) return items;
  const visible = fieldVisible(await objectFields(deps, ctx, 'target'), 'description');
  const readable = visible ? await readableIds(c, deps, ctx, 'target', sources) : new Set<string>();
  return items.map((item) => ({
    ...item,
    details: item.details.map((detail) => ({
      ...detail,
      abilities: detail.abilities.map(({ sourceTargetId, ...ability }) => {
        if (ability.source !== 'common_overwrite' || readable.has(sourceTargetId!)) return ability;
        const { content: _hidden, ...rest } = ability;
        return { ...rest, projectionHidden: true as const };
      }),
    })),
  }));
}
