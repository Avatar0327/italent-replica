/**
 * R2-T08 §6.3 授权矩阵“执行”列：执行时按**申请人（单据创建人）当时**的范围复核，三层——
 * 主体层（申请单对象范围含审批主体组织、账号仍有效）、组织层（目标与新上级在组织对象范围）、任职层（逐员工）。
 * 范围为空一律拒绝（硬规则 1）；拒绝统一记 APPLICANT_OUT_OF_SCOPE，不披露范围外组织。
 */
import { type Tx } from '@italent/db';
import { MODULE_OBJECTS, ORG_ADJUSTMENT_OBJECT_CODE, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { isActiveAccount } from '../../approval/resolver.js';
import { EMPLOYMENT_OBJECT } from '../../employment/context.js';
import type { CascadeAuthorizer } from '../../org/deactivation.js';
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

/** 组织层与任职层：同一组事务内按需取范围并缓存。 */
export function applicantScopes(tx: Tx, scopeOf: ApplicantScopeOf, at: ScopeAt, adjustment: AdjustmentHead) {
  let orgScope: Promise<ModuleScope> | undefined;
  const ctx = { tenantId: at.tenantId, userId: adjustment.createdBy, timezone: at.timezone, now: at.now };
  const orgs = async (ids: readonly (string | null | undefined)[]) => {
    orgScope ??= scopeOf(tx, query(at, adjustment, MODULE_OBJECTS.organization.code));
    const scope = await orgScope;
    for (const id of ids) {
      if (!id) continue;
      try {
        await authorizeOrgResult(tx, { ...ctx, expectedRevision: 0, commandId: '' }, scope, id, false);
      } catch (error) {
        if (error instanceof AppError && error.code === 'NOT_FOUND') throw outOfScope();
        throw error;
      }
    }
  };
  const cascade: CascadeAuthorizer = (_cascadeTx, ids) => orgs(ids);
  const employment = () => scopeOf(tx, query(at, adjustment, EMPLOYMENT_OBJECT));
  return { orgs, cascade, employment };
}
