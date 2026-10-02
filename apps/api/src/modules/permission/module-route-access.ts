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
import type { BusinessContext } from '../job/context.js';
import type { JobKind } from '../job/metadata.js';
import { creatorOf, hasCreatorScope } from './scope-audit.js';
export { creatorOf, creatorSql, hasCreatorScope } from './scope-audit.js';
import { loadJobObject } from '../job/read-model.js';

export type ModuleScope = Awaited<ReturnType<typeof resolveModuleScope>>;
export const JOB_OBJECT_CODES: Readonly<Record<JobKind, string>> = {
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
): Promise<BusinessContext> {
  const ctx = tenantOf(c);
  // 先判定操作开关，结构校验后 writeFields 会再校验真实字段，不能把这里的空集合当完整写授权。
  await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, resource: objectCode, fields: [] });
  return { ...ctx, expectedRevision, now: deps.clock(), commandId: '' };
}

export async function writeFields(
  deps: TenantRouteDeps,
  ctx: BusinessContext,
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
  ctx: BusinessContext,
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
  // TODO(需取证 Q-M0-28)：无组织字段的字典/全局方案须显式看全部或命中已登记的创建人规则。
  throw new AppError('NOT_FOUND', message);
}

export async function visibleJob(
  tx: Tx,
  ctx: BusinessContext,
  scope: ModuleScope,
  kind: JobKind,
  id: string,
  asOf: string,
) {
  const item = await loadJobObject(tx, ctx.tenantId, kind, id, asOf, true);
  if (!item) throw new AppError('NOT_FOUND', '职务体系对象不存在或已失效');
  const creator = hasCreatorScope(scope) ? await creatorOf(tx, ctx.tenantId, item.id, 'job.create', kind) : undefined;
  visible(scope, kind === 'positions' ? item.orgId : undefined, '职务体系对象不存在或已失效', creator);
  return item;
}

export { resolveModuleScope, trimModuleResponse };

export function requestScope(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: BusinessContext, objectCode: string) {
  const pageCode = c.req.method === 'GET' ? `${objectCode}.${c.req.param('id') ? 'detail' : 'list'}` : undefined;
  return resolveModuleScope(deps, ctx, undefined, objectCode, pageCode);
}
