/**
 * 人才标准的权限接入（DEC-080 单一权限模型；AGENTS §10「权限」每次请求重验）：
 * - 功能权限：对象的查看 / 新增 / 编辑 / 删除（objectContext），写入按解析后的载荷逐字段校验编辑权（含显式清空）；
 * - 数据范围：四个对象都没有组织字段，只认“看全部”或“使用用户（创建人）”（DEC-121 口径，默认空，fail-closed）；
 *   范围按对象所属应用 TalentCenter 解析（permission/module-access.ts scopeAppOf，DEC-043）；
 * - 响应裁剪：顶层按本对象字段权限；人才标准里嵌套的指标内容另按指标对象的查看权、范围与字段权限（DEC-178 同口径）。
 */
import { TALENT_OBJECTS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { getModuleViewableFields, scopeAllows, scopeSql } from '../permission/module-access.js';
import {
  button,
  objectContext,
  requestScope,
  trimModuleResponse,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';

for (const definition of Object.values(TALENT_OBJECTS)) registerObjectDefinition(definition);

export type TalentObject = keyof typeof TALENT_OBJECTS;
export type TalentContext = ScopeBusinessContext;
export type { ModuleScope };

export const TALENT_LABELS: Readonly<Record<TalentObject, string>> = {
  library: '指标库',
  dimension: '指标',
  criterionCategory: '人才标准分类',
  criterion: '人才标准',
};

export const codeOf = (object: TalentObject) => TALENT_OBJECTS[object].code;

export function talentContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: TalentObject,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<TalentContext> {
  return objectContext(c, deps, codeOf(object), operation, expectedRevision);
}

/** 写入口对应的按钮（目录登记 create@list / update@detail / delete@detail）。 */
const WRITE_BUTTONS = {
  create: ['create', 'list'],
  update: ['update', 'detail'],
  delete: ['delete', 'detail'],
} as const;

/**
 * 写入口的功能权限：数据操作权（objectContext）之外再叠加按钮权限（REQ-PRM-001 R6）。在进入命令台账之前校验，
 * 首次执行与幂等重放都经过这里，撤掉按钮后重放同样 403。
 */
export async function talentWriteContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: TalentObject,
  operation: keyof typeof WRITE_BUTTONS,
  expectedRevision: number,
): Promise<TalentContext> {
  const ctx = await talentContext(c, deps, object, operation, expectedRevision);
  const [code, level] = WRITE_BUTTONS[operation];
  await button(deps, ctx, codeOf(object), code, level);
  return ctx;
}

export const talentScope = (c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: TalentContext, object: TalentObject) =>
  requestScope(c, deps, ctx, codeOf(object));

export function checkWriteFields(
  deps: TenantRouteDeps,
  ctx: TalentContext,
  object: TalentObject,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
) {
  return writeFields(deps, ctx, codeOf(object), operation, payload);
}

/** 范围外与不存在同样返回 404，不泄露对象是否存在。 */
export function requireVisible(scope: ModuleScope, object: TalentObject, createdBy: string | null | undefined): void {
  if (!scopeAllows(scope, { creatorId: createdBy ?? null })) {
    throw new AppError('NOT_FOUND', `${TALENT_LABELS[object]}不存在`);
  }
}

/** 列表 / 候选的 SQL 侧范围谓词（分页之前生效）。 */
export const visibleSql = (scope: ModuleScope, createdBy: SQL) => scopeSql(scope, { creator: createdBy });

export const trimTalent = <T extends object>(
  deps: TenantRouteDeps,
  ctx: TalentContext,
  object: TalentObject,
  value: T,
): Promise<Partial<T>> => trimModuleResponse(deps, ctx, codeOf(object), value);

export const trimTalentList = <T extends object>(
  deps: TenantRouteDeps,
  ctx: TalentContext,
  object: TalentObject,
  value: T[],
): Promise<Partial<T>[]> => trimModuleResponse(deps, ctx, codeOf(object), value) as Promise<Partial<T>[]>;

/**
 * 人才标准里嵌套的指标内容：查看人须有指标对象的查看权，且该指标在其指标数据范围内；否则只保留引用本身
 * （指标 ID、类型、权重、目标、顺序），不带指标内容。可见时按指标字段权限裁剪。
 */
export async function nestedDimensionReader(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: TalentContext) {
  const code = codeOf('dimension');
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] });
  if (!canView) return () => undefined;
  const scope = await talentScope(c, deps, ctx, 'dimension');
  const fields = await getModuleViewableFields(deps, ctx, code);
  return <T extends { createdBy?: string | null }>(dimension: T | undefined) => {
    if (!dimension || !scopeAllows(scope, { creatorId: dimension.createdBy ?? null })) return undefined;
    if (fields === undefined) return dimension;
    return Object.fromEntries(Object.entries(dimension).filter(([field]) => fields.has(field))) as Partial<T>;
  };
}
