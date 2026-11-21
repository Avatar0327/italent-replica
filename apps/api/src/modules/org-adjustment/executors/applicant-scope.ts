/**
 * R2-T08 §6.3 授权矩阵“执行”列：执行时按**申请人（单据创建人）当时**的范围复核，三层——
 * 主体层（申请单对象范围含审批主体组织、账号仍有效）、组织层（目标与新上级在组织对象范围）、任职层（逐员工）。
 * 范围为空一律拒绝（硬规则 1）；拒绝统一记 APPLICANT_OUT_OF_SCOPE，不披露范围外组织。
 */
import { and, eq, orgAdjustmentOrgItems, sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { isActiveAccount } from '../../approval/resolver.js';
import { checkScope as checkContractScope } from '../../contracts/context.js';
import { rowsOf } from '../../approval/context.js';
import { employmentCreator, EMPLOYMENT_OBJECT } from '../../employment/context.js';
import { isEmploymentRecordVisible } from '../../employment/visibility.js';
import type { EmploymentRecord } from '../../employment/types.js';
import type { CascadeAuthorizer } from '../../org/deactivation.js';
import { loadOrgSnapshot } from '../../org/read-model.js';
import { scopeAllows, scopeAppOf } from '../../permission/module-access.js';
import { authorizeOrgResult } from '../../permission/org-result-scope.js';
import { resolveDataScope } from '../../permission/scope-resolver.js';
import type { ModuleScope, ScopeQuery } from '../../permission/scope-types.js';
import type { AdjustmentHead } from '../execution-groups.js';

export type ApplicantScopeQuery = ScopeQuery & { readonly objectCode: string };
/** 取申请人在某对象上的数据范围；产品用权限引擎，测试可注入。 */
export type ApplicantScopeOf = (tx: Tx, query: ApplicantScopeQuery) => Promise<ModuleScope>;

export const resolveApplicantScope: ApplicantScopeOf = (tx, query) => resolveDataScope(tx, query);

export interface ScopeAt {
  readonly tenantId: string;
  readonly timezone: string;
  readonly now: Date;
}

const OUT_OF_SCOPE = 'APPLICANT_OUT_OF_SCOPE';
export const outOfScope = () => new AppError('FORBIDDEN', '申请人已无权调整该组织', { reason: OUT_OF_SCOPE });

function query(at: ScopeAt, adjustment: AdjustmentHead, objectCode: string): ApplicantScopeQuery {
  const asOf = tenantLocalDate(at.now, at.timezone);
  return { tenantId: at.tenantId, userId: adjustment.createdBy, appCode: scopeAppOf(objectCode), asOf, objectCode };
}

/** 主体层：账号在本租户仍有效，且申请单对象范围仍含审批主体组织。 */
export function applicantSubjectCheck(scopeOf: ApplicantScopeOf) {
  return async (tx: Tx, adjustment: AdjustmentHead, at: ScopeAt) => {
    if (!(await isActiveAccount(tx, at.tenantId, adjustment.createdBy))) return false;
    const scope = await scopeOf(tx, query(at, adjustment, ORG_ADJUSTMENT_OBJECT_CODE));
    return scopeAllows(scope, { orgId: adjustment.subjectOrgId });
  };
}

/** 调入未来的同单新增组织时，只沿已执行的行政链追溯当前权限。 */
async function assertCreatedOrgScope(
  tx: Tx,
  at: ScopeAt,
  adjustment: AdjustmentHead,
  orgAllowed: (id: string) => Promise<boolean>,
  { orgId, itemId }: { orgId: string; itemId: string },
) {
  const today = tenantLocalDate(at.now, at.timezone);
  const visited = new Set<string>();
  const items = orgAdjustmentOrgItems;
  let id: string | null = orgId;
  while (id && !visited.has(id)) {
    if (await orgAllowed(id)) return;
    visited.add(id);
    // 尚未生效的同单新增才沿生效日的行政链追溯；已存在的组织必须按申请人当前范围直接通过。
    const [item] = await tx
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.tenantId, at.tenantId),
          eq(items.adjustmentId, adjustment.id),
          eq(items.createdOrgId, id),
          eq(items.adjustType, 1),
          eq(items.executionResult, 1),
          id === orgId ? eq(items.id, itemId) : undefined,
        ),
      );
    if (!item) break;
    const [org] = await loadOrgSnapshot(tx, at.tenantId, adjustment.effectiveDate, undefined, { id });
    if (!org || org.establishedOn <= today) break;
    id = org.parents.admin?.parentId ?? null;
  }
  throw outOfScope();
}

/** 组织层与任职层：同一组事务内按需取范围并缓存。 */
export function applicantScopes(tx: Tx, scopeOf: ApplicantScopeOf, at: ScopeAt, adjustment: AdjustmentHead) {
  let orgScope: Promise<ModuleScope> | undefined;
  let employeeScope: Promise<ModuleScope> | undefined;
  let contractScope: Promise<ModuleScope> | undefined;
  const ctx = {
    tenantId: at.tenantId,
    userId: adjustment.createdBy,
    timezone: at.timezone,
    now: at.now,
    expectedRevision: 0,
    commandId: '',
  };
  const orgAllowed = async (id: string) => {
    orgScope ??= scopeOf(tx, query(at, adjustment, MODULE_OBJECTS.organization.code));
    try {
      await authorizeOrgResult(tx, ctx, await orgScope, id, false);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  };
  const orgs = async (ids: readonly (string | null | undefined)[]) => {
    for (const id of ids) {
      if (id && !(await orgAllowed(id))) throw outOfScope();
    }
  };
  const createdOrg = (orgId: string, itemId: string) =>
    assertCreatedOrgScope(tx, at, adjustment, orgAllowed, { orgId, itemId });
  const cascade: CascadeAuthorizer = (_cascadeTx, ids) => orgs(ids);
  const employment = () => (employeeScope ??= scopeOf(tx, query(at, adjustment, EMPLOYMENT_OBJECT)));
  const employee = async (id: string, record: EmploymentRecord | null) => {
    const scope = await employment();
    const creator =
      record && scope.terms?.some((term) => term.dimension === 'using_user')
        ? rowsOf<{ id: string | null }>(
            await tx.execute(sql`SELECT ${employmentCreator(at.tenantId, sql`${record.id}::uuid`, true)} AS id`),
          )[0]?.id
        : undefined;
    if (
      !(await isEmploymentRecordVisible(tx, at.tenantId, scope, {
        employeeId: id,
        departmentId: record?.fields.departmentId ?? null,
        creatorId: creator,
      }))
    )
      throw outOfScope();
  };
  const contract = async (employeeId: string, targetId: string) => {
    const [target] = rowsOf<{ created_by: string | null }>(
      await tx.execute(sql`
      SELECT created_by FROM contract_records WHERE tenant_id=${at.tenantId}
        AND id=${targetId}::uuid AND employee_id=${employeeId}::uuid AND NOT deleted
    `),
    );
    if (!target) throw outOfScope();
    contractScope ??= scopeOf(tx, query(at, adjustment, CONTRACT_OBJECT));
    try {
      await checkContractScope(tx, { ...ctx, scope: await contractScope }, employeeId, target.created_by ?? undefined);
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') throw outOfScope();
      throw error;
    }
  };
  return { orgs, createdOrg, cascade, employment, employee, contract };
}
