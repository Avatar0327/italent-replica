/** DEC-080：三个组织类模块共用路由鉴权；数据范围仍由 permission 的单一解析器产生。 */
import { type Tx } from '@italent/db';
import { buttonResource, MODULE_OBJECTS } from '@italent/domain';
import type { Context } from 'hono';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { resolveModuleScope, scopeAllows, trimModuleResponse } from './module-access.js';
import { requireObjectWrite } from './object-write.js';
import { jobScopeReader, type ScopeBusinessContext, type ScopedJobKind } from './module-contracts.js';
import { creatorOf, hasCreatorScope } from './scope-audit.js';
export { creatorOf, creatorSql, hasCreatorScope } from './scope-audit.js';

export type ModuleScope = Awaited<ReturnType<typeof resolveModuleScope>>;
export const JOB_OBJECT_CODES: Readonly<Record<ScopedJobKind, string>> = {
  layers: MODULE_OBJECTS.jobLayer.code,
  grades: MODULE_OBJECTS.jobGrade.code,
  'level-types': MODULE_OBJECTS.jobLevelType.code,
  levels: MODULE_OBJECTS.jobLevel.code,
  sequences: MODULE_OBJECTS.jobSequence.code,
  'professional-lines': MODULE_OBJECTS.jobProfessionalLine.code,
  posts: MODULE_OBJECTS.jobPost.code,
  positions: MODULE_OBJECTS.jobPosition.code,
};

export async function objectContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  objectCode: string,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<ScopeBusinessContext> {
  const ctx = tenantOf(c);
  // 先判定操作开关，结构校验后 writeFields 会再校验真实字段，不能把这里的空集合当完整写授权。
  await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, resource: objectCode, fields: [] });
  return { ...ctx, expectedRevision, now: deps.clock(), commandId: '' };
}

export async function writeFields(
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  objectCode: string,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
) {
  const controls = new Set(['expectedRevision', 'confirmed', 'reservationId']);
  const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => !controls.has(key)));
  if (objectCode === MODULE_OBJECTS.establishment.code && Array.isArray(payload.subdivisions)) {
    for (const part of payload.subdivisions) {
      if (part && typeof part === 'object') Object.assign(fields, part);
    }
  }
  await requireObjectWrite(deps.authorize, ctx, {
    objectCode,
    operation,
    payload: fields,
  });
}

export async function button(
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  objectCode: string,
  code: string,
  level: 'list' | 'detail',
) {
  await requirePermission(deps.authorize, {
    ...ctx,
    action: 'object.button',
    resource: buttonResource(objectCode, code, level),
  });
}

export function visible(
  scope: ModuleScope,
  orgId: string | undefined,
  message = '对象不存在',
  creatorId?: string | null,
): void {
  if (scopeAllows(scope, { orgId, creatorId })) return;
  // DEC-121（保持 DEC-081）：无组织字段的字典 / 全局方案默认不可见，须显式看全部或命中已登记的创建人规则；
  // 标准 HR 身份的“看全部”由开通租户时预置（R1-T17，permission/standard-profiles.ts）。
  throw new AppError('NOT_FOUND', message);
}

export async function visibleJob(
  tx: Tx,
  ctx: ScopeBusinessContext,
  scope: ModuleScope,
  kind: ScopedJobKind,
  id: string,
  asOf: string,
) {
  const item = await jobScopeReader().load(tx, ctx.tenantId, kind, id, asOf, true);
  if (!item) throw new AppError('NOT_FOUND', '职务体系对象不存在或已失效');
  const creator = hasCreatorScope(scope) ? await creatorOf(tx, ctx.tenantId, item.id, 'job.create', kind) : undefined;
  visible(scope, kind === 'positions' ? (item.orgId ?? undefined) : undefined, '职务体系对象不存在或已失效', creator);
  return item;
}

export { resolveModuleScope, trimModuleResponse };

const requestScopes = new WeakMap<Context<TenantEnv>, Map<string, Promise<ModuleScope>>>();
/**
 * @param dataSource 同一对象下需要单独授范围的数据集（读写同用），如编制方案（ESTABLISHMENT_SCHEME_DATASOURCE）：它与
 *   组织编制共用对象 OrganizationEstablishment，DEC-121 只对无组织字段的编制方案预置看全部，不能连带放开组织编制。
 *   页面编码（列表 / 详情）不变，已配置的页面级策略照常生效。
 */
export function requestScope(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  objectCode: string,
  dataSource?: string,
) {
  const pageCode = c.req.method === 'GET' ? `${objectCode}.${c.req.param('id') ? 'detail' : 'list'}` : undefined;
  const key = `${objectCode}:${pageCode ?? ''}:${dataSource ?? ''}`;
  let scopes = requestScopes.get(c);
  if (!scopes) {
    scopes = new Map();
    requestScopes.set(c, scopes);
  }
  const cached = scopes.get(key);
  if (cached) return cached;
  const pending = resolveModuleScope(deps, ctx, undefined, objectCode, pageCode, dataSource);
  scopes.set(key, pending);
  return pending;
}
