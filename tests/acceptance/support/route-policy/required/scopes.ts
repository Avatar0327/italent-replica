/**
 * 义务的范围绑定登记（F-039 PR-B1，设计 B-03）：`need` 的构造器与“强制范围判定处”证据（role: 'scope'）。
 * 每个范围名字（谓词 / 定位器 / 守卫）对应的证据，是逐条读源码后审定的判定处：锚点必须出现在所指单元里，
 * 单元一改摘要就失效（evidence.ts）。需要 need 的义务由各模块表文件用 `withNeeds` 按权限键绑定；
 * 键对不上任何义务会抛错，防止登记漂移。
 */
import type { Evidence, Need, Obligation } from './types.js';

const M = 'apps/api/src/modules';

/** 随主对象的范围，不另行过滤（声明为 mode: none 或没有 scope 字段）。 */
export const NONE: Need = { scope: 'none' };
export const point = (locator: string): Need => ({ scope: 'point', locator });
export const list = (predicate: string): Need => ({ scope: 'list', predicate });
export const guardScope = (guard: string): Need => ({ scope: 'guard', guard });

const scope = (unit: string, anchor: string): Evidence => ({ role: 'scope', unit, anchor });

/** 范围名字 → 强制判定处证据。 */
export const SCOPE_AT = {
  // F-082 字段改名失败时的定位披露：规则逐项按操作人的计算规则范围（看全部或创建人）判定，范围外只计入匿名计数
  'talentReview.configScope(talent_review_calc_rules)': [
    scope(
      `${M}/talent-review/field-rename-guard.ts#partitionBroken`,
      "visibleTo(disclosure.scope, 'calcRule', item.ruleCreatedBy) &&",
    ),
  ],
  'contracts.employeeVisibility': [
    scope(`${M}/contracts/context.ts#checkScope`, "throw new AppError('NOT_FOUND', '合同数据不存在')"),
  ],
  'contracts.scope': [
    scope(
      `${M}/transfer/linkage/routes.ts#route:GET /transfers/:id/linkage`,
      'scope: await resolveModuleScope(deps, tenant, undefined, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`)',
    ),
  ],
  'personnel.personScope(subsets)': [
    scope(`${M}/personnel/lists.ts#listSubsets`, 'return rows( await tx.execute(sql`SELECT s.*,e.code,u.user_id'),
  ],
  'personnel.personScope(nested)': [
    scope(
      `${M}/personnel/routes.ts#nestedSubsets`,
      'const scope = await resolveModuleScope(deps, ctx, undefined, objectCode, `${objectCode}.list`)',
    ),
  ],
  'survey360.personScope': [scope(`${M}/survey360/people.ts#visiblePersonIds`, 'const filter = personFilter(admin);')],
  'survey360.employeeScope': [
    scope(
      `${M}/survey360/sync.ts#syncAccess`,
      "if (!scope) fail('FORBIDDEN', '无权查看组织员工信息', 'NO_EMPLOYEE_ACCESS')",
    ),
    scope(
      `${M}/survey360/sync.ts#syncView`,
      'const inScope = await employeesInScope(tx, employees, [...listed, ...(position ? [position] : [])]);',
    ),
  ],
  'survey360.object.byId': [
    scope(
      `${M}/survey360/relations.ts#registerAutoAdd`,
      'const object = await requireVisibleObject(tx, ctx.admin, id, objectId);',
    ),
  ],
  'survey360.employeeScope(auto)': [
    scope(
      `${M}/survey360/relations.ts#registerAutoAdd`,
      'await requireTargetInScope(tx, employees!, (await requireObject(tx, id, objectId)).person_id);',
    ),
  ],
  'talent.criterion.byId': [
    scope(`${M}/talent/model-image-routes.ts#write`, 'await service.imageOwner(tx, ctx.tenantId, id, scope);'),
  ],
  'talent.criterion.byId(present)': [
    scope(
      `${M}/talent/model-image-routes.ts#present`,
      'const owner = await service.imageOwner(tx, ctx.tenantId, id, scope);',
    ),
  ],
  'talent.formScope(operation)': [
    scope(`${M}/talent/form-access.ts#talentFormHandler`, 'requireVisible(scope, spec.object, spec.owner(found))'),
  ],
  'talent.ownedScope(talent_dimensions)': [
    scope(
      `${M}/talent/access.ts#nestedDimensionReader`,
      'if (!dimension || !canSee(scope, { orgId: dimension.ownerOrgId, ' +
        'ownerId: dimension.ownerId })) return undefined;',
    ),
  ],
  'org.scope': [
    scope(
      `${M}/talent/candidates.ts#organizationAccess`,
      'visible: scopeSql(scope, { org: orgId, ' +
        "creator: creatorSql(ctx.tenantId, orgId, 'org.create', 'organization'), }),",
    ),
  ],
  'org.scope(qualification)': [
    scope(
      `${M}/qualification/candidates.ts#organizationAccess`,
      'visible: scopeSql(scope, { org: orgId, ' +
        "creator: creatorSql(ctx.tenantId, orgId, 'org.create', 'organization'), }),",
    ),
  ],
  'ql.openRead(ql_targets)': [
    scope(
      `${M}/qualification/route-support.ts#readableIds`,
      'const scope = await qualificationScope(c, deps, ctx, object);',
    ),
  ],
  'ql.openRead(ql_categories)': [
    scope(
      `${M}/qualification/config-service.ts#replaceJobLinks`,
      "throw conflict(taken.readable && fieldVisible(ctx.fields[object], 'name') ? `【${taken.name}】` : '');",
    ),
    scope(
      `${M}/qualification/access.ts#accessSql`,
      "readable: kind === 'open' ? sql`true` : qlReadable(ctx, scope, alias),",
    ),
  ],
  'ql.openRead(ql_levels)': [
    scope(
      `${M}/qualification/config-service.ts#replaceJobLinks`,
      "throw conflict(taken.readable && fieldVisible(ctx.fields[object], 'name') ? `【${taken.name}】` : '');",
    ),
    scope(
      `${M}/qualification/access.ts#accessSql`,
      "readable: kind === 'open' ? sql`true` : qlReadable(ctx, scope, alias),",
    ),
  ],
  'employment.scopeSql': [
    scope(
      `${M}/job/sequence-receipts.ts#visibleSequenceReceipts`,
      'const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, code);',
    ),
  ],
  'approval.adminScope': [
    scope(
      `${M}/approval/access.ts#adminScope`,
      "allowed ||= await hasButton(deps, ctx, button, button === 'adminLogs' ? 'list' : 'detail')",
    ),
  ],
  'idp.process.byId': [
    scope(`${M}/idp/process-service.ts#lockProcess`, "await requireEditable(tx, ctx, ctx.scope, 'process', row);"),
  ],
  'idp.template.byId': [
    scope(`${M}/idp/template-service.ts#lockTemplate`, "await requireEditable(tx, ctx, ctx.scope, 'template', row);"),
  ],
  'idp.template.byId(copy)': [
    scope(
      `${M}/idp/template-service.ts#copyTemplate`,
      "await requireReadable(tx, ctx, ctx.scope, 'template', source);",
    ),
  ],
  'idp.plan.byId': [
    scope(
      `${M}/idp/plan-service.ts#lockPlanForHr`,
      "if (!(await hrSees(tx, ctx.hr, row))) throw new AppError('NOT_FOUND', '发展计划不存在')",
    ),
  ],
  'idp.planScope(issue)': [
    scope(
      `${M}/idp/plan-routes.ts#route:POST /api/tenant/idp/plans/tasks/issue`,
      'for (const item of result.created) await stillVisible(tx, ctx, hr, item.planId);',
    ),
  ],
  'idp.planScope(responseView)': [
    scope(
      `${M}/idp/plan-routes.ts#showPlan`,
      'const viewer = await requireViewer(tx, ctx, hr, plan, await loadStages(tx, ctx.tenantId, [planId]))',
    ),
    scope(
      `${M}/idp/plan-access.ts#requireViewer`,
      "if (!at.participant) throw new AppError('NOT_FOUND', '发展计划不存在')",
    ),
  ],
} as const satisfies Record<string, readonly Evidence[]>;

export interface Binding {
  readonly need: Need;
  /** 范围证据（need.scope 不是 none 时必须有）。 */
  readonly at?: readonly Evidence[];
}

/** 无范围绑定（随主对象）。 */
export const bound = (need: Need, at?: readonly Evidence[]): Binding => ({ need, ...(at ? { at } : {}) });

/**
 * 按“权限键”（准入义务）或“权限键|用途”（其余用途）给一组义务补 need 与范围证据；
 * 键对不上任何义务就抛错，防止登记漂移。
 */
export function withNeeds(
  obligations: readonly Obligation[],
  bindings: Readonly<Record<string, Binding>>,
): Obligation[] {
  const used = new Set<string>();
  const out = obligations.map((o) => {
    const key = o.purpose === undefined ? o.perm : `${o.perm}|${o.purpose}`;
    const binding = bindings[key];
    if (!binding) return o;
    used.add(key);
    return { ...o, need: binding.need, at: [...o.at, ...(binding.at ?? [])] };
  });
  for (const key of Object.keys(bindings)) {
    if (!used.has(key)) throw new Error(`withNeeds：没有可绑定的义务 ${key}`);
  }
  return out;
}
