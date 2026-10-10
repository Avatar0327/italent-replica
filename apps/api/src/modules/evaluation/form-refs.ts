/**
 * 评价表的引用访问（B4，设计 §5.2 #6）：评分项引用的两类对象各按查看人**当前**的权限呈现和校验——
 * - 通用评分项（TEvaluation.GeneralScoreItem，字典）：对象查看权 + 字典范围（看全部 ∪ 创建人）+ 名称字段权，才给名称；
 *   新增引用要有查看权（403）、行在范围内（不存在与范围外同一 404）、已启用（400 REFERENCE_DISABLED）；
 * - 隐藏指标（Qualification.Target，只放开查看，DEC-352）：对象查看权 + 名称字段权才给名称，否则只给 ID；新增隐藏指标经
 *   assertQualificationRefs（403 / 404 / 400）。已有引用原样保留，不重新校验（停用后照常显示，DEC-281⑧）。
 * 写命令的访问在命令事务内解析（resolveFormRefs，首次、直接重放、失败后回查都经过 route-support 的 before）；读接口按请求解析。
 * 评价表对通用评分项写命令的“引用方可见范围”（停用被引用时只列看得到的评价表，DEC-374⑥）也在这里解析。
 */
import { sql, type Tx } from '@italent/db';
import { EVALUATION_OBJECTS, QUALIFICATION_OBJECTS } from '@italent/domain';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { assertQualificationRefs, type QualificationRefAccess } from '../qualification/access.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { requestScope, type ModuleScope } from '../permission/module-route-access.js';
import { type EvaluationContext, rowsOf, scopePredicate } from './access.js';

const GENERAL = EVALUATION_OBJECTS.generalScoreItem.code;
const TARGET = QUALIFICATION_OBJECTS.target.code;
const FORM = EVALUATION_OBJECTS.evaluationForm.code;

/** 查看人对一类被引用对象的访问：null = 没有对象查看权（只给 ID，新增引用 403）。 */
export interface RefObjectAccess {
  readonly scope: ModuleScope;
  /** 可见字段；undefined = 全部。 */
  readonly fields: ReadonlySet<string> | undefined;
}
export interface FormRefAccess {
  readonly general: RefObjectAccess | null;
  readonly target: RefObjectAccess | null;
}

/** 通用评分项写命令里“引用方（评价表）看得到的范围”：不能看评价表的人一个都看不到，全部计入“其他 N 个”。 */
export interface FormVisibility {
  readonly canView: boolean;
  readonly scope: ModuleScope;
}

const shows = (access: RefObjectAccess | null, field: string): access is RefObjectAccess =>
  access !== null && (access.fields === undefined || access.fields.has(field));

type Authorize = TenantRouteDeps['authorize'];
const hasObjectView = (authorize: Authorize, ctx: ScopeBusinessContext, resource: string) =>
  authorize({ ...ctx, action: 'object.view', resource, fields: [] });

/** 读接口：按请求解析（范围带请求缓存）。 */
export async function formRefAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: EvaluationContext,
): Promise<FormRefAccess> {
  const one = async (resource: string): Promise<RefObjectAccess | null> =>
    (await hasObjectView(deps.authorize, ctx, resource))
      ? {
          scope: await requestScope(c, deps, ctx, resource),
          fields: await getModuleViewableFields(deps, ctx, resource),
        }
      : null;
  return { general: await one(GENERAL), target: await one(TARGET) };
}

/** 命令事务内：查看权、范围、字段全部按当前授权重新解析（不用带请求缓存的 requestScope，不沿用旧值）。 */
export async function resolveFormRefs(deps: TenantRouteDeps, ctx: EvaluationContext, tx: Tx): Promise<FormRefAccess> {
  const bound: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const one = async (resource: string): Promise<RefObjectAccess | null> =>
    (await hasObjectView(bound.authorize, ctx, resource))
      ? {
          scope: await resolveModuleScopeInTransaction(bound, ctx, tx, resource),
          fields: await getModuleViewableFieldsInTransaction(bound, ctx, resource, tx),
        }
      : null;
  return { general: await one(GENERAL), target: await one(TARGET) };
}

/** 通用评分项写命令（停用 / 删除）里引用方的可见范围，同样事务内解析。 */
export async function resolveFormVisibility(
  deps: TenantRouteDeps,
  ctx: EvaluationContext,
  tx: Tx,
): Promise<FormVisibility> {
  const bound: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  return {
    canView: await hasObjectView(bound.authorize, ctx, FORM),
    scope: await resolveModuleScopeInTransaction(bound, ctx, tx, FORM),
  };
}

const uuidList = (ids: readonly string[]) => `{${[...new Set(ids)].join(',')}}`;

/**
 * 写入：新增的引用校验（只传本次新增的 ID）。通用评分项：没有字典查看权 403 NO_GENERAL_ITEM_ACCESS；不存在或字典范围外同一
 * 404；已停用 400 REFERENCE_DISABLED。被引用行 FOR SHARE，与其停用 / 删除串行。隐藏指标经 assertQualificationRefs。
 */
export async function assertNewFormRefs(
  tx: Tx,
  ctx: ScopeBusinessContext,
  access: FormRefAccess,
  refs: { readonly generalItemIds: readonly string[]; readonly targetIds: readonly string[] },
): Promise<void> {
  const generalIds = [...new Set(refs.generalItemIds)];
  if (generalIds.length) {
    if (!access.general) {
      throw new AppError('FORBIDDEN', '无权查看通用评分项', { reason: 'NO_GENERAL_ITEM_ACCESS' });
    }
    const readable = scopePredicate(access.general.scope, 'generalScoreItem', 'g');
    const found = rowsOf<{ id: string; enabled: boolean; readable: boolean }>(
      await tx.execute(sql`SELECT g.id, g.enabled, (${readable}) AS readable FROM ev_general_items g
        WHERE g.tenant_id = ${ctx.tenantId}::uuid AND g.id = ANY(${uuidList(generalIds)}::uuid[])
        ORDER BY g.id FOR SHARE OF g`),
    );
    const byId = new Map(found.map((row) => [row.id, row]));
    for (const id of generalIds) {
      const row = byId.get(id);
      if (!row || !row.readable) throw new AppError('NOT_FOUND', '通用评分项不存在');
      if (!row.enabled) {
        throw new AppError('VALIDATION_FAILED', '通用评分项已停用，不能引用', { reason: 'REFERENCE_DISABLED', id });
      }
    }
  }
  if (refs.targetIds.length) {
    const qualification: QualificationRefAccess = { ctx, scopes: { target: access.target?.scope ?? null } };
    await assertQualificationRefs(tx, qualification, { targetIds: [...refs.targetIds] });
  }
}

/** 评分项的引用名称：{ 通用评分项 id → 名称, 指标 id → 名称 }，只含查看人看得到的（对象查看权 + 范围 + 名称字段权）。 */
export async function referenceNames(
  tx: Tx,
  tenantId: string,
  access: FormRefAccess,
  ids: { readonly generalItemIds: readonly string[]; readonly targetIds: readonly string[] },
): Promise<{ readonly general: Map<string, string>; readonly target: Map<string, string> }> {
  const general = new Map<string, string>();
  const target = new Map<string, string>();
  if (shows(access.general, 'name') && ids.generalItemIds.length) {
    const readable = scopePredicate(access.general.scope, 'generalScoreItem', 'g');
    for (const row of rowsOf<{ id: string; name: string }>(
      await tx.execute(sql`SELECT g.id, g.name FROM ev_general_items g
        WHERE g.tenant_id = ${tenantId}::uuid AND g.id = ANY(${uuidList(ids.generalItemIds)}::uuid[])
          AND ${readable}`),
    )) {
      general.set(row.id, row.name);
    }
  }
  if (shows(access.target, 'name') && ids.targetIds.length) {
    for (const row of rowsOf<{ id: string; name: string }>(
      await tx.execute(sql`SELECT t.id, t.name FROM ql_targets t
        WHERE t.tenant_id = ${tenantId}::uuid AND t.id = ANY(${uuidList(ids.targetIds)}::uuid[])`),
    )) {
      target.set(row.id, row.name);
    }
  }
  return { general, target };
}
