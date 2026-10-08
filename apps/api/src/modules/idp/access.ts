/**
 * IDP 配置的权限接入（DEC-080 单一权限模型；AGENTS §10「权限」每次请求重验；PR 描述矩阵 A）：
 * - 功能权限：对象的查看 / 新增 / 编辑 / 删除（objectContext）+ 写入口按钮；写入按解析后的载荷逐字段校验编辑权
 *   （含显式清空），嵌套对象（子流程、模块、通用目标）按各自对象校验；
 * - 数据范围：流程与模板按所属组织（复用 module-route-access 的 visible / scopeSql），“使用用户”按创建人；
 *   范围按对象所属应用 IDP 解析（permission/module-access.ts scopeAppOf，DEC-043），缺省空；
 *   向下公开（🟡 K-23）：查看人范围内有其下级组织时可查看与选用，不能修改（403 IDP_PUBLIC_DOWN_READONLY）；
 * - 响应裁剪：顶层与嵌套层各按本对象字段权限；没有嵌套对象查看权时整段省略。
 */
import { sql, type Tx } from '@italent/db';
import { IDP_OBJECTS, tenantLocalDate, type IdpObject } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { type Authorizer, requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { authorizeInTransaction, getModuleViewableFields, scopeAllows, scopeSql } from '../permission/module-access.js';
import {
  button,
  objectContext,
  requestScope,
  visible,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';

for (const definition of Object.values(IDP_OBJECTS)) registerObjectDefinition(definition);

export type IdpContext = ScopeBusinessContext;
export type { ModuleScope };

export const IDP_LABELS: Readonly<Record<IdpObject, string>> = {
  process: '发展计划流程',
  subProcess: '子流程',
  template: '发展计划模板',
  templateModule: '模板模块',
  commonGoal: '模板通用目标',
};

/** 审计动作前缀（`<前缀>.create|update|delete`）；审计查询的查看规则按它登记（audit/visibility.ts）。 */
export const IDP_AUDIT_ACTIONS: Readonly<Record<IdpObject, string>> = {
  process: 'idp.process',
  subProcess: 'idp.sub-process',
  template: 'idp.template',
  templateModule: 'idp.template-module',
  commonGoal: 'idp.common-goal',
};

export const codeOf = (object: IdpObject) => IDP_OBJECTS[object].code;

export function idpContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: IdpObject,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<IdpContext> {
  return objectContext(c, deps, codeOf(object), operation, expectedRevision);
}

/**
 * 写入口的功能权限：数据操作权之外再叠加按钮（REQ-PRM-001 R6）。在进入命令台账之前校验，首次执行与幂等重放
 * 都经过这里，撤掉按钮后重放同样 403。
 */
export async function idpWriteContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: IdpObject,
  operation: 'create' | 'update' | 'delete',
  buttonCode: string,
  level: 'list' | 'detail',
  expectedRevision: number,
): Promise<IdpContext> {
  const ctx = await idpContext(c, deps, object, operation, expectedRevision);
  await button(deps, ctx, codeOf(object), buttonCode, level);
  return ctx;
}

export const idpScope = (c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: IdpContext, object: IdpObject) =>
  requestScope(c, deps, ctx, codeOf(object));

/** 载荷字段编辑权（含显式清空）：键即字段编码。 */
export function checkWriteFields(
  deps: TenantRouteDeps,
  ctx: IdpContext,
  object: IdpObject,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
) {
  return writeFields(deps, ctx, codeOf(object), operation, payload);
}

/**
 * 命令实际用到的权限（第 2 轮 P2-2 / P2-3）：嵌套写权限按首次执行时的实际变化得出，复制另须源内容的查看权。
 * 首次执行在事务内逐项判定，并随结果存进命令台账；幂等重放返回前按当前权限逐项复核（replayChecks）。
 */
export type PermissionCheck =
  | {
      readonly kind: 'write';
      readonly object: IdpObject;
      readonly operation: 'create' | 'update' | 'delete';
      readonly fields: readonly string[];
    }
  | { readonly kind: 'view'; readonly object: IdpObject; readonly fields: readonly string[] };

/** 带“已用权限记录”的上下文：服务层每判定一项就记一项。 */
export interface CheckedContext extends IdpContext {
  readonly checks?: PermissionCheck[];
}

async function requireWrite(authorize: Authorizer, ctx: IdpContext, check: PermissionCheck & { kind: 'write' }) {
  const { object, operation, fields } = check;
  await requirePermission(authorize, { ...ctx, action: `object.${operation}`, resource: codeOf(object), fields });
}

/** 嵌套对象的写权限（在事务内按实际变化判定：新增段 create、改动的字段 update、删掉的段 delete）。 */
export async function requireNestedWrite(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize'>,
  ctx: CheckedContext,
  object: IdpObject,
  operation: 'create' | 'update' | 'delete',
  payload: Readonly<Record<string, unknown>> = {},
) {
  const check: PermissionCheck = {
    kind: 'write',
    object,
    operation,
    fields: operation === 'delete' ? [] : Object.keys(payload),
  };
  // 在调用方事务内判定（不另开连接，避免与本事务的行锁互等）
  await requireWrite(authorizeInTransaction(deps.authorize, tx), ctx, check);
  ctx.checks?.push(check);
}

/** 复制：继承内容的每个字段都须可查看（字段投影事务外预先解析）；看不到即整次拒绝，不生成副本（P2-3）。 */
export function requireViewable(ctx: CheckedContext, projection: Projection, object: IdpObject, fields: string[]) {
  const check: PermissionCheck = { kind: 'view', object, fields };
  if (!viewable(projection, fields)) {
    throw new AppError('FORBIDDEN', `看不到${IDP_LABELS[object]}的部分内容，不能复制`, {
      reason: 'IDP_COPY_HIDDEN_FIELDS',
    });
  }
  ctx.checks?.push(check);
}

const viewable = (projection: Projection, fields: readonly string[]) =>
  projection !== null && (projection === undefined || fields.every((field) => projection.has(field)));

/** 幂等重放（与首次执行）返回前，按当前权限复核命令实际用到的每一项权限。 */
export async function replayChecks(deps: TenantRouteDeps, ctx: IdpContext, checks: readonly PermissionCheck[]) {
  const projections = new Map<IdpObject, Projection>();
  for (const check of checks) {
    if (check.kind === 'write') {
      await requireWrite(deps.authorize, ctx, check);
      continue;
    }
    if (!projections.has(check.object)) projections.set(check.object, await projectionOf(deps, ctx, check.object));
    requireViewable(ctx, projections.get(check.object)!, check.object, [...check.fields]);
  }
}

/** 流程 / 模板的范围锚点：所属组织、是否向下公开、创建人（“使用用户”规则）。 */
export interface Anchor {
  readonly orgId: string;
  readonly publicDown: boolean;
  readonly createdBy: string;
}

export type Access = 'edit' | 'view' | 'none';

/** 范围内（所属组织在范围内或命中“使用用户”）可编辑；仅因向下公开可见的只读（🟡 K-23）。 */
export async function accessOf(tx: Tx, ctx: IdpContext, scope: ModuleScope, anchor: Anchor): Promise<Access> {
  if (scopeAllows(scope, { orgId: anchor.orgId, creatorId: anchor.createdBy })) return 'edit';
  if (!anchor.publicDown) return 'none';
  const result = await tx.execute(sql`SELECT ${publicDownSql(ctx, scope, sql`${anchor.orgId}::uuid`)} AS visible`);
  return rowsOf<{ visible: boolean }>(result)[0]?.visible === true ? 'view' : 'none';
}

/** 读取：不可见与不存在同为 404（不泄露是否存在）。 */
export async function requireReadable(tx: Tx, ctx: IdpContext, scope: ModuleScope, object: IdpObject, anchor: Anchor) {
  if ((await accessOf(tx, ctx, scope, anchor)) === 'none')
    throw new AppError('NOT_FOUND', `${IDP_LABELS[object]}不存在`);
}

/** 写入：不可见 404；仅因向下公开可见 403。 */
export async function requireEditable(tx: Tx, ctx: IdpContext, scope: ModuleScope, object: IdpObject, anchor: Anchor) {
  const access = await accessOf(tx, ctx, scope, anchor);
  if (access === 'none') throw new AppError('NOT_FOUND', `${IDP_LABELS[object]}不存在`);
  if (access === 'view') {
    throw new AppError('FORBIDDEN', `${IDP_LABELS[object]}由上级组织向下公开，只能查看与选用`, {
      reason: 'IDP_PUBLIC_DOWN_READONLY',
    });
  }
}

/** 新建 / 改所属组织：目标组织须在范围内（不因“使用用户”或向下公开放行，DEC-082）；范围外按不存在 404。 */
export function requireCreatable(scope: ModuleScope, object: IdpObject, orgId: string): void {
  visible(scope, orgId, `${IDP_LABELS[object]}不存在`);
}

/**
 * 列表的 SQL 侧范围谓词（分页之前生效）：所属组织在范围内、命中创建人，或向下公开且范围内有其下级组织。
 * 别名列由调用方给出（如 sql`p.org_id`）。
 */
export function readableSql(ctx: IdpContext, scope: ModuleScope, columns: { org: SQL; publicDown: SQL; creator: SQL }) {
  if (scope.all) return sql`true`;
  return sql`(${scopeSql(scope, { org: columns.org, creator: columns.creator })}
    OR (${columns.publicDown} AND ${publicDownSql(ctx, scope, columns.org)}))`;
}

/** 范围内组织（按组织维度展开后的组织 ID）。 */
function scopeOrgIds(scope: ModuleScope): string[] {
  const terms = scope.terms ?? [{ dimension: 'management', orgIds: scope.orgIds, personIds: scope.personIds }];
  const ids = new Set<string>();
  for (const term of terms) {
    if (term.dimension === 'management' || term.dimension === 'organization') term.orgIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}

/**
 * 向下公开：对象的所属组织是查看人范围内某个组织的上级（行政维度，按租户时区当天的组织版本）。
 * 范围内组织为空时恒为 false。
 */
function publicDownSql(ctx: IdpContext, scope: ModuleScope, org: SQL): SQL {
  const ids = scopeOrgIds(scope);
  if (!ids.length) return sql`false`;
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  return sql`${org} IN (
    WITH RECURSIVE up(org_id, depth) AS (
      SELECT unnest(${`{${ids.join(',')}}`}::uuid[]), 0
      UNION
      SELECT l.parent_org_id, up.depth + 1 FROM up
      CROSS JOIN LATERAL (
        SELECT v.id FROM org_versions v
        WHERE v.tenant_id = ${ctx.tenantId}::uuid AND v.org_id = up.org_id AND v.start_date <= ${asOf}::date
        ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
      ) cv
      JOIN org_hierarchy_links l ON l.tenant_id = ${ctx.tenantId}::uuid AND l.version_id = cv.id
        AND l.dimension = 'admin'
      WHERE up.depth < 64
    ) SELECT org_id FROM up)`;
}

/** 列表信封：查看人在该对象上有没有任何数据范围。 */
export function listEnvelope(page: { page: number; pageSize: number }, scope: ModuleScope) {
  return { page: page.page, pageSize: page.pageSize, hasDataPermission: scope.all || scope.hasDataPermission };
}

/** 一个对象的字段投影：没有对象查看权为 null（嵌套段整体省略），看全部为 undefined（不裁剪）。 */
export type Projection = ReadonlySet<string> | undefined | null;

export async function projectionOf(deps: TenantRouteDeps, ctx: IdpContext, object: IdpObject): Promise<Projection> {
  const code = codeOf(object);
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] }))) return null;
  return getModuleViewableFields(deps, ctx, code);
}

export function project<T extends object>(value: T, fields: Projection): Partial<T> {
  if (fields === undefined) return value;
  if (fields === null) return {};
  return Object.fromEntries(Object.entries(value).filter(([field]) => fields.has(field))) as Partial<T>;
}

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
