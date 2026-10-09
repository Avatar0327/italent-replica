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
import { IDP_OBJECTS, linkedViewable, withLinkedFields, type IdpObject } from '@italent/domain';
import type { Context } from 'hono';
import { type Authorizer, requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { authorizeInTransaction, getModuleViewableFields, scopeAllows } from '../permission/module-access.js';
import { publicDownSql } from '../permission/public-down.js';
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
  plan: '发展计划',
  goal: '发展目标',
  task: '目标任务',
  goalReview: '目标回顾',
  analysis: '综述',
  review: '回顾',
  tutorship: '带教信息',
  career: '职业发展信息',
  workShift: '轮岗信息',
};

/** 审计动作前缀（`<前缀>.create|update|delete`）；审计查询的查看规则按它登记（audit/visibility.ts）。 */
export const IDP_AUDIT_ACTIONS: Readonly<Record<IdpObject, string>> = {
  process: 'idp.process',
  subProcess: 'idp.sub-process',
  template: 'idp.template',
  templateModule: 'idp.template-module',
  commonGoal: 'idp.common-goal',
  plan: 'idp.plan',
  goal: 'idp.goal',
  task: 'idp.task',
  goalReview: 'idp.goal-review',
  analysis: 'idp.analysis',
  review: 'idp.review',
  tutorship: 'idp.tutorship',
  career: 'idp.career',
  workShift: 'idp.work-shift',
};

/** 配置对象按所属组织归属；计划及其组成部分、关键信息按员工归属（审计查看规则 audit/visibility.ts，DEC-197）。 */
export const IDP_ORG_OBJECTS: readonly IdpObject[] = [
  'process',
  'subProcess',
  'template',
  'templateModule',
  'commonGoal',
];
export const IDP_PERSON_OBJECTS: readonly IdpObject[] = [
  'plan',
  'goal',
  'task',
  'goalReview',
  'analysis',
  'review',
  'tutorship',
  'career',
  'workShift',
];
// 计划与关键信息按员工归属：组织类数据范围对它们带出“按人员”的谓词（K-50）
for (const object of IDP_PERSON_OBJECTS) registerPersonScopedObject(IDP_OBJECTS[object].code);

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
  const code = codeOf(object);
  const fields = withLinkedFields(code, Object.keys(payload));
  return writeFields(deps, ctx, code, operation, Object.fromEntries(fields.map((f) => [f, payload[f] ?? null])));
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
  | { readonly kind: 'view'; readonly object: IdpObject; readonly fields: readonly string[]; readonly carry?: true }
  /** 带出值的非 IDP 源对象（任职记录 / 组织，E3）：重放时复核对象查看权与字段查看权。 */
  | { readonly kind: 'source'; readonly objectCode: string; readonly fields: readonly string[] };

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
    fields: operation === 'delete' ? [] : withLinkedFields(codeOf(object), Object.keys(payload)),
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

export const viewable = (projection: Projection, fields: readonly string[]) =>
  projection !== null && (projection === undefined || fields.every((field) => projection.has(field)));

const sourceHidden = () => new AppError('FORBIDDEN', '看不到带出值的来源字段', { reason: 'IDP_CARRY_SOURCE_HIDDEN' });

/** 某对象的字段投影（没有对象查看权为 null）。 */
export async function objectFields(deps: TenantRouteDeps, ctx: IdpContext, objectCode: string): Promise<Projection> {
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: objectCode, fields: [] }))) return null;
  return linkedViewable(objectCode, await getModuleViewableFields(deps, ctx, objectCode));
}

/**
 * 幂等重放（与首次执行）返回前，按当前权限复核命令实际用到的每一项权限：嵌套写权限、复制继承字段与带出值源字段的
 * 查看权（第 2 轮 P2-6：带出源看不到了 → 403 IDP_CARRY_SOURCE_HIDDEN）。
 */
export async function replayChecks(deps: TenantRouteDeps, ctx: IdpContext, checks: readonly PermissionCheck[]) {
  const projections = new Map<string, Projection>();
  const fieldsOf = async (code: string) => {
    if (!projections.has(code)) projections.set(code, await objectFields(deps, ctx, code));
    return projections.get(code)!;
  };
  for (const check of checks) {
    if (check.kind === 'write') {
      await requireWrite(deps.authorize, ctx, check);
      continue;
    }
    if (check.kind === 'source') {
      if (!viewable(await fieldsOf(check.objectCode), check.fields)) throw sourceHidden();
      continue;
    }
    const projection = await fieldsOf(codeOf(check.object));
    if (check.carry) {
      if (!viewable(projection, check.fields)) throw sourceHidden();
      continue;
    }
    requireViewable(ctx, projection, check.object, [...check.fields]);
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

/** 列表信封：查看人在该对象上有没有任何数据范围。 */
export function listEnvelope(page: { page: number; pageSize: number }, scope: ModuleScope) {
  return { page: page.page, pageSize: page.pageSize, hasDataPermission: scope.all || scope.hasDataPermission };
}

/** 一个对象的字段投影：没有对象查看权为 null（嵌套段整体省略），看全部为 undefined（不裁剪）。 */
export type Projection = ReadonlySet<string> | undefined | null;

export async function projectionOf(deps: TenantRouteDeps, ctx: IdpContext, object: IdpObject): Promise<Projection> {
  return objectFields(deps, ctx, codeOf(object));
}

export function project<T extends object>(value: T, fields: Projection): Partial<T> {
  if (fields === undefined) return value;
  if (fields === null) return {};
  return Object.fromEntries(Object.entries(value).filter(([field]) => fields.has(field))) as Partial<T>;
}

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
