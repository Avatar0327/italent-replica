/**
 * R2-T08 §8.1 组织新增执行器：设立日期 = 单据生效日；上级引用同单新增行时解析为其正式 ID（§2.6）。
 * 建成后同事务回写 created_org_id / executed_version_id：接管重入见到 created_org_id 即视为已建，不重复创建。
 * 编码空 → 按自动编码规则先取号再按指定编码消费（系统身份不建预占，见 `allocateCode`）；
 * 新上级（既有组织或同单新增行解析出的正式 ID）须仍在申请人组织范围（§6.3）。
 */
import { allocateCode } from '../../org/codes.js';
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
    const parentId = await parentOf(tx, input, item!);
    if (!parentId) throw new AppError('CONFLICT', '所依赖的同单明细未执行成功', { reason: 'DEPENDENCY_FAILED' });
    // 按解析后的正式上级授权：引用同单新增行时原始列为空，且组间可能已撤权，不能沿用被引用组当时的授权（§6.3）。
    await applicantScopes(tx, scopeOf, input, input.adjustment).orgs([parentId]);
    const ctx = await orgWriteContext(tx, input);
    const organization: OrganizationInput = {
      name: item!.name ?? '',
      parents: { admin: { parentId } },
      establishedOn: input.adjustment.effectiveDate,
      code: item!.code ?? (await allocateCode(tx, ctx)),
      ...(item!.shortName !== null && { shortName: item!.shortName }),
      displayOrder: item!.displayOrder,
      personInChargeId: item!.personInChargeId,
      hrbpId: item!.hrbpId,
    };
    const saved = await createOrganization(tx, ctx, organization);
    await markItem(tx, input, item!.id, { createdOrgId: saved.id, executedVersionId: saved.versionId });
    return 'done';
  };
}
