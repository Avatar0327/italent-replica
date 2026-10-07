/**
 * 人才标准的权限接入（DEC-080 单一权限模型；AGENTS §10「权限」每次请求重验）：
 * - 功能权限：对象的查看 / 新增 / 编辑 / 删除（objectContext）+ 写入口的按钮，写入按解析后的载荷逐字段校验编辑权（含显式清空）；
 * - 数据范围（DEC-281⑨）：指标库、库内分类、指标、标准分类、人才标准按所属管理单元（组织，DEC-026 同思路）判定，
 *   复用模块统一的 visible / scopeSql；“使用用户”规则按所属人。发展建议类型是没有组织字段的字典，只认看全部或创建人
 *   （DEC-121 口径）。范围按对象所属应用 TalentCenter 解析（permission/module-access.ts scopeAppOf，DEC-043），默认空；
 * - 响应裁剪：顶层按本对象字段权限；人才标准里嵌套的指标内容另按指标对象的查看权、范围与字段权限（DEC-178 同口径），
 *   并且只投影 名称、定义、指标类别（DEC-281⑪）。
 */
import { sql } from '@italent/db';
import { TALENT_OBJECTS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { getModuleViewableFields, scopeSql } from '../permission/module-access.js';
import {
  button,
  hasCreatorScope,
  objectContext,
  requestScope,
  trimModuleResponse,
  visible,
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
  dimensionCategory: '指标库分类',
  descriptionType: '发展建议类型',
  dimension: '指标',
  criterionCategory: '人才标准分类',
  criterion: '人才标准',
};

export const codeOf = (object: TalentObject) => TALENT_OBJECTS[object].code;

/** 审计动作前缀（`<前缀>.create|update|delete`）；审计查询的查看规则按它登记（audit/visibility.ts）。 */
export const TALENT_AUDIT_ACTIONS: Readonly<Record<TalentObject, string>> = {
  library: 'talent.library',
  dimensionCategory: 'talent.dimension-category',
  descriptionType: 'talent.description-type',
  dimension: 'talent.dimension',
  criterionCategory: 'talent.category',
  criterion: 'talent.criterion',
};

/** 没有组织字段的字典对象（只认看全部或创建人，DEC-121 口径）。 */
export const isDictionary = (object: TalentObject) => object === 'descriptionType';

/** 范围锚点：所属管理单元（组织）与所属人；字典对象只有创建人。 */
export interface Owner {
  readonly orgId?: string | null;
  readonly ownerId?: string | null;
}

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
export function requireVisible(scope: ModuleScope, object: TalentObject, owner: Owner): void {
  // 复用模块统一的范围判定（module-route-access.ts visible）：所属管理单元按组织，“使用用户”按所属人
  visible(scope, owner.orgId ?? undefined, `${TALENT_LABELS[object]}不存在`, owner.ownerId ?? null);
}

/** 同 requireVisible，但不抛错（嵌套内容按范围省略而不是整单 404）。 */
function canSee(scope: ModuleScope, owner: Owner): boolean {
  try {
    visible(scope, owner.orgId ?? undefined, '', owner.ownerId ?? null);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

/** 列表 / 候选的 SQL 侧范围谓词（分页之前生效）。 */
export const visibleSql = (scope: ModuleScope, columns: { org?: SQL; creator?: SQL }) => scopeSql(scope, columns);

/** 范围谓词的列：挂管理单元的对象按所属组织与所属人，字典按创建人。 */
export function scopeColumns(object: TalentObject, table: string) {
  const column = (name: string) => sql`${sql.identifier(table)}.${sql.identifier(name)}`;
  return isDictionary(object)
    ? { creator: column('created_by') }
    : { org: column('owner_org_id'), creator: column('owner_id') };
}

/** 列表信封：查看人在该对象上有没有任何数据范围（挂管理单元的对象看范围本身，字典看看全部或创建人）。 */
export function listEnvelope(page: { page: number; pageSize: number }, scope: ModuleScope, object: TalentObject) {
  const hasDataPermission = scope.all || (isDictionary(object) ? hasCreatorScope(scope) : scope.hasDataPermission);
  return { page: page.page, pageSize: page.pageSize, hasDataPermission };
}

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

/** DEC-281⑪：标准的指标列表只显示 名称、定义、指标类别（另有引用行上的目标、权重），不显示库名称与库状态。 */
const NESTED_DIMENSION_FIELDS = ['name', 'definition', 'categoryName'] as const;
type NestedDimension = Partial<Record<(typeof NESTED_DIMENSION_FIELDS)[number], unknown>>;

/**
 * 人才标准里嵌套的指标内容：查看人须有指标对象的查看权，且该指标在其指标数据范围内；否则只保留引用本身
 * （指标 ID、类型、权重、目标、顺序），不带指标内容。可见时只投影上述三项，再按指标字段权限裁剪。
 */
export async function nestedDimensionReader(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: TalentContext) {
  const code = codeOf('dimension');
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] });
  if (!canView) return () => undefined;
  const scope = await talentScope(c, deps, ctx, 'dimension');
  const fields = await getModuleViewableFields(deps, ctx, code);
  return (dimension: (NestedDimension & { ownerOrgId: string; ownerId: string }) | undefined) => {
    if (!dimension || !canSee(scope, { orgId: dimension.ownerOrgId, ownerId: dimension.ownerId })) return undefined;
    return Object.fromEntries(
      NESTED_DIMENSION_FIELDS.filter((field) => fields === undefined || fields.has(field)).map((field) => [
        field,
        dimension[field],
      ]),
    ) as NestedDimension;
  };
}
