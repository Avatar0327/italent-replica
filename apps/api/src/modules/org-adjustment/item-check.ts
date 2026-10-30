/**
 * 组织明细的整单校验（R2-T08 §5，BE-10b2）：叠树（循环 / 层级 / 停用整支 / 引用）、引用暂存行、逐行业务规则
 * （目标与上级在生效日启用、人员资格、编码、调整范围；与保存同一入口 item-rules）、新负责人须在本组织（DEC-644 A-12）、
 * 停用整支须晚于设立日且无人无岗、编制结束关口（11e 前）、目标无晚于生效日的版本、基线（§2.5）。
 * 全部按当前生效日重判，刷新基线不豁免业务约束。只读、不写数据；暂存行除被引用外不报问题。
 * 结果并入路由 7 的校验信封，提交（10c）复用同一份判断。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { employeesInOrgs } from '../employment/org-people.js';
import { assertDeactivationVacant } from '../org/deactivation.js';
import { rowsOf } from '../org/read-model.js';
import { assertItemRules, planStop } from './item-rules.js';
import { orgContext, PLAN_MESSAGES, planIssues, type ItemWorld } from './item-tree.js';
import type { OrgItem } from './items-store.js';

export interface ItemIssue {
  readonly section: 'org';
  readonly itemId: string;
  readonly reason: string;
  readonly message: string;
  readonly orgId?: string;
}

export const BASELINE_CHANGED = 'ORG_ADJUSTMENT_BASELINE_CHANGED';
const idsSql = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const issue = (item: OrgItem, reason: string, message: string, orgId?: string): ItemIssue => ({
  section: 'org',
  itemId: item.id,
  reason,
  message,
  ...(orgId && { orgId }),
});

export async function checkOrgItems(tx: Tx, world: ItemWorld, now: Date): Promise<ItemIssue[]> {
  const live = world.items.filter((item) => !item.isStaged);
  const byId = new Map(world.items.map((item) => [item.id, item]));
  const issues: ItemIssue[] = planIssues(world, world.items).map((found) =>
    issue(byId.get(found.itemId)!, found.reason, PLAN_MESSAGES[found.reason]),
  );
  for (const item of live) {
    if ([item.parentItemId, item.transferToItemId].some((ref) => ref !== null && byId.get(ref)?.isStaged)) {
      issues.push(issue(item, 'ORG_ADJUSTMENT_STAGED_REFERENCE', '引用了暂存的明细，请先完成该明细或改为引用其它组织'));
    }
  }
  issues.push(...(await ruleIssues(tx, world, live, now)));
  issues.push(...(await headIssues(tx, world, live)));
  issues.push(...(await stopIssues(tx, world, live)));
  issues.push(...(await establishmentIssues(tx, world, live)));
  issues.push(...(await futureVersionIssues(tx, world, live)));
  issues.push(...baselineIssues(world, live));
  return issues;
}

/** 负责人变化的行：新负责人须在生效日于本组织任职（主职或兼职）；新增组织须在本单为其添加调动或兼职明细（随 10c）。 */
async function headIssues(tx: Tx, world: ItemWorld, live: readonly OrgItem[]) {
  const changed = live.filter(
    (item) =>
      item.adjustType !== 3 &&
      item.personInChargeId !== null &&
      item.personInChargeId !== (item.targetOrgId ? world.orgs.get(item.targetOrgId)?.personInChargeId : null),
  );
  const pairs = changed
    .filter((item) => item.targetOrgId)
    .map((item) => ({ employeeId: item.personInChargeId!, orgId: item.targetOrgId! }));
  const inOrg = await employeesInOrgs(tx, world.tenantId, pairs, world.view.effectiveDate);
  return changed
    .filter((item) => !item.targetOrgId || !inOrg.has(`${item.personInChargeId}:${item.targetOrgId}`))
    .map((item) => issue(item, 'ORG_ADJUSTMENT_HEAD_NOT_IN_ORG', '请在本单为新负责人添加调动或兼职明细'));
}

/** 发起行（连带行随发起行）逐行跑保存时的同一套规则；规则抛的业务错误转为该行的问题。 */
async function ruleIssues(tx: Tx, world: ItemWorld, live: readonly OrgItem[], now: Date) {
  const issues: ItemIssue[] = [];
  for (const item of live.filter((row) => !row.cascadedFromItemId)) {
    try {
      await assertItemRules(tx, now, world, world.items, item, 'all');
    } catch (error) {
      issues.push(fromError(item, error));
    }
  }
  return issues;
}

/** 停用发起行：停用日须晚于整支各组织设立日（与保存同口径）；整支自生效日起不能有在职人员或启用中的职位。 */
async function stopIssues(tx: Tx, world: ItemWorld, live: readonly OrgItem[]) {
  const issues: ItemIssue[] = [];
  const ctx = orgContext(world.tenantId);
  for (const item of live) {
    const target = item.targetOrgId ? world.orgs.get(item.targetOrgId) : undefined;
    if (item.adjustType !== 3 || item.cascadedFromItemId || !target) continue;
    try {
      await assertDeactivationVacant(tx, ctx, await planStop(tx, world, target, async () => {}));
    } catch (error) {
      const vacancy = error instanceof AppError && error.code === 'CONFLICT';
      issues.push(vacancy ? issue(item, 'ORG_SUBTREE_NOT_EMPTY', error.message, target.id) : fromError(item, error));
    }
  }
  return issues;
}

/** 业务错误（400 / 409 / 404）转为行问题：原因取错误的 reason，组织取 orgId 或 orgIds 的第一个。其它错误照抛。 */
function fromError(item: OrgItem, error: unknown): ItemIssue {
  const codes = ['VALIDATION_FAILED', 'CONFLICT', 'NOT_FOUND'];
  if (!(error instanceof AppError) || !codes.includes(error.code)) throw error;
  const details = (error.details ?? {}) as { reason?: string; orgId?: string; orgIds?: string[] };
  return issue(
    item,
    details.reason ?? 'ORG_ADJUSTMENT_ITEM_INVALID',
    error.message,
    details.orgId ?? details.orgIds?.[0],
  );
}

/** 11e 前不能结束编制：停用整支（含连带行）在生效日有编制对象 → 每个组织报一次。 */
async function establishmentIssues(tx: Tx, world: ItemWorld, live: readonly OrgItem[]) {
  const stops = live.filter((item) => item.adjustType === 3 && item.targetOrgId);
  if (!stops.length) return [];
  const date = world.view.effectiveDate;
  const covered = new Set(
    rowsOf<{ org_id: string }>(
      await tx.execute(sql`SELECT DISTINCT org_id FROM establishment_objects
        WHERE tenant_id = ${world.tenantId} AND org_id = ANY(${idsSql(stops.map((item) => item.targetOrgId!))})
          AND period_start <= ${date}::date AND period_end >= ${date}::date`),
    ).map((row) => row.org_id),
  );
  return stops
    .filter((item) => covered.has(item.targetOrgId!))
    .map((item) =>
      issue(
        item,
        'ORG_ADJUSTMENT_ESTABLISHMENT_END_NOT_AVAILABLE',
        '停用组织在生效日仍有编制，编制结束随编制模块上线后开放',
        item.targetOrgId!,
      ),
    );
}

/** 改组织 / 停用的目标在生效日之后已有版本：执行会被未来版本覆盖，先处理未来版本（与组织直改同口径）。 */
async function futureVersionIssues(tx: Tx, world: ItemWorld, live: readonly OrgItem[]) {
  const targets = live.filter((item) => item.targetOrgId);
  if (!targets.length) return [];
  const future = new Set(
    rowsOf<{ org_id: string }>(
      await tx.execute(sql`SELECT DISTINCT org_id FROM org_versions
        WHERE tenant_id = ${world.tenantId} AND org_id = ANY(${idsSql(targets.map((item) => item.targetOrgId!))})
          AND start_date > ${world.view.effectiveDate}::date`),
    ).map((row) => row.org_id),
  );
  return targets
    .filter((item) => future.has(item.targetOrgId!))
    .map((item) =>
      issue(item, 'ORG_FUTURE_VERSION_EXISTS', '目标组织在生效日之后已有版本，请先处理未来版本', item.targetOrgId!),
    );
}

/** §2.5：有目标的非暂存行（含连带行），生效日现行版本或组织 revision 与建行时不同 → 外部已改。 */
export function baselineIssues(world: ItemWorld, live: readonly OrgItem[]) {
  return live
    .filter((item) => item.targetOrgId && item.baseVersionId)
    .filter((item) => {
      const org = world.orgs.get(item.targetOrgId!);
      return !org || org.versionId !== item.baseVersionId || org.revision !== item.baseOrgRevision;
    })
    .map((item) => issue(item, BASELINE_CHANGED, '组织在添加明细后已被修改，请刷新基线', item.targetOrgId!));
}
