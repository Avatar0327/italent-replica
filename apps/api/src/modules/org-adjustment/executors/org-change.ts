/**
 * R2-T08 §8.1 组织变更 / 停用执行器（组织写入复用 `org/write-service.ts`，校验与直接改组织同一口径）。
 * 变更 T1：组织层范围 → 基线 → 写版本（任职延后，不在组织写事务里联动）→ 记 executed_version_id；
 *   选“是”且整支有人 → exec_phase = 1 并 pending，后续由 T2 / T3 分页追加；选“否”或无人 → done（§7.5）。
 *   exec_phase = 1 时为接管：不做基线、不再写组织，按游标续 T2。
 * 停用：组首 + 连带行一组；基线逐行判，写服务整支同日级联停用（连带下级按申请人组织范围逐个授权），
 *   有在职人员 / 编制等仍按直接停用的拒绝口径整组失败。
 */
import { type Tx } from '@italent/db';
import { lockOrganizationSettings } from '../../org/locks.js';
import { requiresEmploymentChoice } from '../../org/employment-linkage.js';
import { updateOrganization, type OrganizationPatch } from '../../org/write-service.js';
import type { GroupExecutor, GroupInput } from '../execution-groups.js';
import { applicantScopes, type ApplicantScopeOf } from './applicant-scope.js';
import { assertBaseline, groupItems, liveOrg, markItem, orgWriteContext, parentOf, type ExecItem } from './context.js';
import { linkEmploymentPage } from './org-employment.js';
import { orgEmploymentTargetsPage } from '../../org/employment-linkage.js';

export function orgChangeExecutor(scopeOf: ApplicantScopeOf): GroupExecutor {
  return async (tx, input) => {
    const [item] = await groupItems(tx, input);
    if (item!.execPhase === 1) return linkEmploymentPage(tx, scopeOf, input, item!);
    await lockOrganizationSettings(tx, input.tenantId);
    const parentId = await parentOf(tx, input, item!);
    await applicantScopes(tx, scopeOf, input, input.adjustment).orgs([item!.targetOrgId, item!.parentOrgId]);
    await assertBaseline(tx, input, [item!]);
    const patch = await changePatch(tx, input, item!, parentId);
    const ctx = await orgWriteContext(tx, input, item!.targetOrgId!);
    const saved = await updateOrganization(tx, ctx, item!.targetOrgId!, patch, { employmentLinkage: 'deferred' });
    const date = input.adjustment.effectiveDate;
    const link =
      patch.addEmployment === true &&
      (await orgEmploymentTargetsPage(tx, input.tenantId, saved.id, date, null, 1)).length > 0;
    await markItem(tx, input, item!.id, { executedVersionId: saved.versionId, ...(link && { execPhase: 1 }) });
    return link ? 'pending' : 'done';
  };
}

/**
 * 明细只存要改的值，null = 不变（§2.2）。层级 / 半级 / 更新下级层级在组织模型里没有对应字段，执行时不写（结果文件“假设”）。
 * 是否新增任职只在改名或改行政上级时传给写服务，与直接改组织的必填 / 禁填规则一致。
 */
async function changePatch(tx: Tx, input: GroupInput, item: ExecItem, parentId: string | null) {
  const patch: { -readonly [K in keyof OrganizationPatch]: OrganizationPatch[K] } = {
    effectiveDate: input.adjustment.effectiveDate,
  };
  if (item.name !== null) patch.name = item.name;
  if (item.code !== null) patch.code = item.code;
  if (item.shortName !== null) patch.shortName = item.shortName;
  if (item.displayOrder !== null) patch.displayOrder = item.displayOrder;
  if (item.personInChargeId !== null) patch.personInChargeId = item.personInChargeId;
  if (item.hrbpId !== null) patch.hrbpId = item.hrbpId;
  if (parentId) patch.parents = { admin: { parentId } };
  const current = await liveOrg(tx, input, item.targetOrgId!);
  if (current && requiresEmploymentChoice(current, patch)) patch.addEmployment = item.addEmployment ?? undefined;
  return patch;
}

export function orgDeactivateExecutor(scopeOf: ApplicantScopeOf): GroupExecutor {
  return async (tx, input) => {
    const items = await groupItems(tx, input);
    const lead = items[0]!;
    await lockOrganizationSettings(tx, input.tenantId);
    const scopes = applicantScopes(tx, scopeOf, input, input.adjustment);
    await scopes.orgs([lead.targetOrgId]);
    await assertBaseline(tx, input, items);
    const ctx = await orgWriteContext(tx, input, lead.targetOrgId!);
    const patch = { effectiveDate: input.adjustment.effectiveDate, enabled: false };
    const saved = await updateOrganization(tx, ctx, lead.targetOrgId!, patch, { authorizeCascade: scopes.cascade });
    await markItem(tx, input, lead.id, { executedVersionId: saved.versionId });
    for (const row of items.slice(1)) {
      const version = row.targetOrgId && (await liveOrg(tx, input, row.targetOrgId))?.versionId;
      if (version) await markItem(tx, input, row.id, { executedVersionId: version });
    }
    return 'done';
  };
}
