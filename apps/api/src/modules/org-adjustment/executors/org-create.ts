/**
 * R2-T08 §8.1 组织新增执行器：设立日期 = 单据生效日；上级引用同单新增行时解析为其正式 ID（§2.6）。
 * 建成后同事务回写 created_org_id / executed_version_id：接管重入见到 created_org_id 即视为已建，不重复创建。
 * 编码空 → 写服务按自动编码规则取；新上级为既有组织时须仍在申请人组织范围（§6.3）。
 */
import { lockOrganizationSettings } from '../../org/locks.js';
import { createOrganization, type OrganizationInput } from '../../org/write-service.js';
import { AppError } from '../../../errors.js';
import type { GroupExecutor } from '../execution-groups.js';
import { applicantScopes, type ApplicantScopeOf } from './applicant-scope.js';
import { groupItems, markItem, orgWriteContext, parentOf } from './context.js';

export function orgCreateExecutor(scopeOf: ApplicantScopeOf): GroupExecutor {
  return async (tx, input) => {
    const [item] = await groupItems(tx, input);
    if (item!.createdOrgId) return 'done';
    await lockOrganizationSettings(tx, input.tenantId);
    await applicantScopes(tx, scopeOf, input, input.adjustment).orgs([item!.parentOrgId]);
    const parentId = await parentOf(tx, input, item!);
    if (!parentId) throw new AppError('CONFLICT', '所依赖的同单明细未执行成功', { reason: 'DEPENDENCY_FAILED' });
    const organization: OrganizationInput = {
      name: item!.name ?? '',
      parents: { admin: { parentId } },
      establishedOn: input.adjustment.effectiveDate,
      ...(item!.code !== null && { code: item!.code }),
      ...(item!.shortName !== null && { shortName: item!.shortName }),
      displayOrder: item!.displayOrder,
      personInChargeId: item!.personInChargeId,
      hrbpId: item!.hrbpId,
    };
    const saved = await createOrganization(tx, await orgWriteContext(tx, input), organization);
    await markItem(tx, input, item!.id, { createdOrgId: saved.id, executedVersionId: saved.versionId });
    return 'done';
  };
}
