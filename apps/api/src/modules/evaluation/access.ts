/**
 * 人才评定配置的权限接入（DEC-080 单一权限模型；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §5.1；AGENTS §10）：
 * - 功能权限：对象的查看 / 新增 / 编辑 / 删除 + 写入口按钮，写入按载荷逐字段校验编辑权（含显式清空）；
 * - 数据范围：按对象所属应用 TEvaluation 解析（DEC-043，数据范围按用户 × 应用一份），缺省为空（fail-closed）；
 *   活动类型、活动周期、通用评分项没有组织字段，是字典：看全部 ∪ 创建人（DEC-121），新建只认看全部（DEC-082 / DEC-356②）。
 *   评审组、评价表、评定活动按所属组织（owner_org_id）∪ 创建人，不做向下公开（DEC-324②；B3～B5 追加）；
 * - TEvaluation 没有“只能看不能改”的一层（无向下公开），读写同一谓词：范围外的行不可见，读写都是 404。
 */
import { sql } from '@italent/db';
import { EVALUATION_OBJECTS, type EvaluationObject } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, scopeSql, trimModuleResponse } from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import {
  button,
  hasCreatorScope,
  objectContext,
  requestScope,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';

export type { EvaluationObject, ModuleScope };
export type EvaluationContext = ScopeBusinessContext;

export const EVALUATION_LABELS: Readonly<Record<EvaluationObject, string>> = {
  activityType: '活动类型',
  activityCycle: '活动周期',
  generalScoreItem: '通用评分项',
  reviewGroup: '评审组',
  evaluationForm: '评价表',
  evaluationActivity: '评定活动',
};

export const codeOf = (object: EvaluationObject) => EVALUATION_OBJECTS[object].code;

const column = (alias: string, name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

/** 范围锚点：字典（无组织字段，按创建人）；所属组织对象（评审组，B4 评价表、B5 活动同口径）按所属组织 ∪ 创建人。 */
export type AnchorKind = 'dictionary' | 'owned';

export const ANCHOR: Readonly<Partial<Record<EvaluationObject, AnchorKind>>> = {
  activityType: 'dictionary',
  activityCycle: 'dictionary',
  generalScoreItem: 'dictionary',
  reviewGroup: 'owned',
  evaluationForm: 'owned',
};

/** 对象表上的范围谓词（分页之前生效）：别名指向对象表；看全部时为真，创建人维度取 `created_by`。 */
export function scopePredicate(scope: ModuleScope, object: EvaluationObject, alias = 't'): SQL {
  const anchor = ANCHOR[object];
  if (!anchor) throw new Error(`没有登记${EVALUATION_LABELS[object]}的范围锚点`);
  // 所属组织对象：所属组织在范围内 ∪ 创建人（所属人）；不做向下公开（DEC-324②）
  if (anchor === 'owned')
    return scopeSql(scope, { org: column(alias, 'owner_org_id'), creator: column(alias, 'owner_id') });
  return scopeSql(scope, { creator: column(alias, 'created_by') });
}

/** 读写同一谓词：不可见与不存在同为 404。 */
export function requireVisible(visible: boolean, object: EvaluationObject): void {
  if (!visible) throw new AppError('NOT_FOUND', `${EVALUATION_LABELS[object]}不存在`);
}

export function evaluationContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: EvaluationObject,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<EvaluationContext> {
  return objectContext(c, deps, codeOf(object), operation, expectedRevision);
}

const BUTTON_LEVEL = { create: 'list', update: 'detail', delete: 'detail' } as const;

/** 写入口：数据操作权 + 按钮（REQ-PRM-001 R6），在命令台账之前校验，首次与幂等重放都经过这里。 */
export async function evaluationWriteContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: EvaluationObject,
  operation: 'create' | 'update' | 'delete',
  expectedRevision: number,
): Promise<EvaluationContext> {
  const ctx = await evaluationContext(c, deps, object, operation, expectedRevision);
  await button(deps, ctx, codeOf(object), operation, BUTTON_LEVEL[operation]);
  return ctx;
}

/** 载荷字段编辑权（含显式清空），键即字段编码。 */
export function checkWriteFields(
  deps: TenantRouteDeps,
  ctx: EvaluationContext,
  object: EvaluationObject,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
) {
  return writeFields(deps, ctx, codeOf(object), operation, payload);
}

export const evaluationScope = (
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EvaluationContext,
  object: EvaluationObject,
) => requestScope(c, deps, ctx, codeOf(object));

export const trimEvaluation = <T extends object>(
  deps: TenantRouteDeps,
  ctx: EvaluationContext,
  object: EvaluationObject,
  value: T[],
): Promise<Partial<T>[]> => trimModuleResponse(deps, ctx, codeOf(object), value) as Promise<Partial<T>[]>;

/** 查看人当前对某对象的可见字段（undefined = 全部）。 */
export const viewableFields = (deps: TenantRouteDeps, ctx: EvaluationContext, object: EvaluationObject) =>
  getModuleViewableFields(deps, ctx, codeOf(object));

/**
 * 列表筛选用到的字段须有查看权，否则 403 FILTER_FIELD_HIDDEN：不能用筛选结果还原被裁掉的字段值（照 talent-review
 * requireFilterVisible）。
 */
export function requireFilterVisible(fields: ReadonlySet<string> | undefined, field: string): void {
  if (fields !== undefined && !fields.has(field)) {
    throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field });
  }
}

/** 列表信封：查看人在该对象上有没有任何数据范围（字典看看全部或创建人；所属组织对象看有没有任何范围，同 talent）。 */
export function listEnvelope(page: { page: number; pageSize: number }, scope: ModuleScope, object: EvaluationObject) {
  const hasDataPermission =
    scope.all || (ANCHOR[object] === 'owned' ? scope.hasDataPermission : hasCreatorScope(scope));
  return { page: page.page, pageSize: page.pageSize, hasDataPermission };
}

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}
