/**
 * 评定活动的引用访问（B5，设计 §3.2、§5.1）：活动引用的几类对象各按操作人**当前**的权限校验，全部在命令事务内解析
 * （resolveActivityRefs，首次、直接重放、失败后回查都经 route-support 的 before 重新解析，DEC-388①）：
 * - 活动类型 / 活动周期（字典，TEvaluation）：对象查看权 + 字典范围（看全部 ∪ 创建人）；
 * - 环节评价表（TEvaluation，按所属组织）：对象查看权 + 评价表的所属组织 ∪ 所属人范围；
 * - 申请类别 / 级别（Qualification，只放开查看，DEC-352）：对象查看权，经 assertQualificationRefs；
 * - 所属组织 / 适用组织范围 / 通知范围：组织须存在且在操作人 TEvaluation 范围内（DEC-082，范围外与不存在同一 404）；
 * - 负责人：人员引用出口（person-refs.ts，B3）。
 * 只校验**新增**的引用，原有引用原样保留不重校（停用后照常显示，DEC-281⑧）；不存在与范围外同一个 404，无查看权 403，已停用 400
 * REFERENCE_DISABLED；被引用行 FOR SHARE，与其停用 / 删除串行。同时解析活动“名称”字段的可见性：适用范围重复提示只在名称字段可见、
 * 且冲突活动在操作人范围内时才带名称（scope-dup 提示，不泄露范围外或被裁剪字段）。
 */
import { sql, type Tx } from '@italent/db';
import { EVALUATION_OBJECTS, QUALIFICATION_OBJECTS } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  scopeAllows,
} from '../permission/module-access.js';
import { assertQualificationRefs, type QualificationRefAccess } from '../qualification/access.js';
import { EVALUATION_LABELS, type EvaluationContext, type EvaluationObject, rowsOf, scopePredicate } from './access.js';
import type { RefObjectAccess } from './form-refs.js';
import type { ModuleScope } from './access.js';

const TYPE = EVALUATION_OBJECTS.activityType.code;
const CYCLE = EVALUATION_OBJECTS.activityCycle.code;
const FORM = EVALUATION_OBJECTS.evaluationForm.code;
const ACTIVITY = EVALUATION_OBJECTS.evaluationActivity.code;
const CATEGORY = QUALIFICATION_OBJECTS.category.code;
const LEVEL = QUALIFICATION_OBJECTS.level.code;

/** 操作人对被引用对象的访问：null = 没有对象查看权（新增引用 403）。 */
export interface ActivityRefAccess {
  readonly type: RefObjectAccess | null;
  readonly cycle: RefObjectAccess | null;
  readonly form: RefObjectAccess | null;
  /** 类别 / 级别只放开查看：只需知道有没有查看权（范围随 assertQualificationRefs 的签名一起传）。 */
  readonly category: ModuleScope | null;
  readonly level: ModuleScope | null;
  /** 活动“名称”字段对操作人可见（不可见时重复提示不带名称）。 */
  readonly nameVisible: boolean;
  /** 活动“环节”字段对操作人可见（不可见时校验提示不带环节名称）。 */
  readonly chainsVisible: boolean;
}

export async function resolveActivityRefs(
  deps: TenantRouteDeps,
  ctx: EvaluationContext,
  tx: Tx,
): Promise<ActivityRefAccess> {
  const bound: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const canView = (resource: string) => bound.authorize({ ...ctx, action: 'object.view', resource, fields: [] });
  const object = async (resource: string): Promise<RefObjectAccess | null> =>
    (await canView(resource))
      ? {
          scope: await resolveModuleScopeInTransaction(bound, ctx, tx, resource),
          fields: await getModuleViewableFieldsInTransaction(bound, ctx, resource, tx),
        }
      : null;
  const scopeOnly = async (resource: string) =>
    (await canView(resource)) ? resolveModuleScopeInTransaction(bound, ctx, tx, resource) : null;
  const activityFields = (await canView(ACTIVITY))
    ? await getModuleViewableFieldsInTransaction(bound, ctx, ACTIVITY, tx)
    : new Set<string>();
  return {
    type: await object(TYPE),
    cycle: await object(CYCLE),
    form: await object(FORM),
    category: await scopeOnly(CATEGORY),
    level: await scopeOnly(LEVEL),
    nameVisible: activityFields === undefined || activityFields.has('name'),
    chainsVisible: activityFields === undefined || activityFields.has('chains'),
  };
}

export interface NewActivityRefs {
  readonly typeId?: string;
  readonly cycleId?: string;
  readonly formIds: readonly string[];
  readonly categoryIds: readonly string[];
  readonly levelIds: readonly string[];
}

const uuidList = (ids: readonly string[]) => `{${[...new Set(ids)].join(',')}}`;

/** 一类被引用的 TEvaluation 对象：无查看权 403；不存在或范围外同一 404；已停用 400。 */
async function assertRefs(
  tx: Tx,
  tenantId: string,
  access: RefObjectAccess | null,
  spec: { object: EvaluationObject; table: string; reason: string },
  ids: readonly string[],
) {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return;
  const label = EVALUATION_LABELS[spec.object];
  if (!access) throw new AppError('FORBIDDEN', `无权查看${label}`, { reason: spec.reason });
  const readable = scopePredicate(access.scope, spec.object, 'r');
  const found = rowsOf<{ id: string; enabled: boolean; readable: boolean }>(
    await tx.execute(sql`SELECT r.id, r.enabled, (${readable}) AS readable FROM ${sql.identifier(spec.table)} r
      WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY(${uuidList(wanted)}::uuid[])
      ORDER BY r.id FOR SHARE OF r`),
  );
  const byId = new Map(found.map((row) => [row.id, row]));
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row || !row.readable) throw new AppError('NOT_FOUND', `${label}不存在`);
    if (!row.enabled) {
      throw new AppError('VALIDATION_FAILED', `${label}已停用，不能引用`, { reason: 'REFERENCE_DISABLED', id });
    }
  }
}

/** 写入：新增的引用校验（只传本次新增的 ID）。 */
export async function assertNewActivityRefs(
  tx: Tx,
  ctx: EvaluationContext,
  access: ActivityRefAccess,
  refs: NewActivityRefs,
): Promise<void> {
  const one = (id: string | undefined) => (id ? [id] : []);
  await assertRefs(
    tx,
    ctx.tenantId,
    access.type,
    { object: 'activityType', table: 'ev_activity_types', reason: 'NO_ACTIVITY_TYPE_ACCESS' },
    one(refs.typeId),
  );
  await assertRefs(
    tx,
    ctx.tenantId,
    access.cycle,
    { object: 'activityCycle', table: 'ev_cycles', reason: 'NO_ACTIVITY_CYCLE_ACCESS' },
    one(refs.cycleId),
  );
  await assertRefs(
    tx,
    ctx.tenantId,
    access.form,
    { object: 'evaluationForm', table: 'ev_forms', reason: 'NO_EVALUATION_FORM_ACCESS' },
    refs.formIds,
  );
  const qualification: QualificationRefAccess = {
    ctx,
    scopes: { category: access.category, level: access.level },
  };
  await assertQualificationRefs(tx, qualification, {
    categoryIds: [...refs.categoryIds],
    levelIds: [...refs.levelIds],
  });
}

/** 所属组织 / 适用组织范围 / 通知范围里新增的组织：须存在且在操作人范围内，范围外与不存在同一个 404。 */
export async function assertNewOrgs(
  tx: Tx,
  ctx: EvaluationContext & { readonly scope: ModuleScope },
  orgIds: readonly string[],
): Promise<void> {
  const wanted = [...new Set(orgIds)];
  if (!wanted.length) return;
  const found = new Set(
    rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM org_objects
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${uuidList(wanted)}::uuid[])`),
    ).map((row) => row.id),
  );
  if (wanted.some((id) => !found.has(id) || !scopeAllows(ctx.scope, { orgId: id }))) {
    throw new AppError('NOT_FOUND', '组织不存在');
  }
}
