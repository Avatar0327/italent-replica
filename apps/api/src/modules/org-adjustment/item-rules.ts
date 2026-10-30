/**
 * 组织明细的逐行业务规则（R2-T08 §5.2 / §5.6，BE-10b2 第 2 轮）：保存（增 / 改 / 拖拽）与整单校验走同一入口，
 * 都按申请单当前生效日判（DEC-431①）。保存时抛错；整单校验逐行捕获转为问题。人员资格、编码、停用设立日
 * 复用组织模块的判断（assertOrgPeopleEligible / assertCodeAvailable / assertDeactivationAfterEstablished）。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { assertCodeAvailable } from '../org/codes.js';
import {
  assertDeactivationAfterEstablished,
  planDeactivationSubtree,
  type CascadeAuthorizer,
} from '../org/deactivation.js';
import { assertOrgPeopleEligible } from '../org/people.js';
import type { OrgRecord } from '../org/read-model.js';
import { assertInRange, orgContext, type ItemWorld } from './item-tree.js';
import type { OrgItem, OrgItemContent } from './items-store.js';
import { ORG_INACTIVE } from './range.js';

/** 本次提交的内容字段：新增与整单校验为全部，修改为 PATCH 的键，拖拽只改上级（引用照判）。 */
export type Submitted = 'all' | readonly string[];

const PEOPLE = ['personInChargeId', 'hrbpId'] as const satisfies readonly (keyof OrgItemContent)[];

/**
 * 一行的业务规则：目标在生效日启用 → 引用可用 → 人员资格 → 编码 → 调整范围。暂存行只判目标、引用与范围
 * （其余随完成再判）；连带行随发起行，不单判目标启用，但照判调整范围（第 3 轮 P2-R2-2）。
 */
export async function assertItemRules(
  tx: Tx,
  now: Date,
  world: ItemWorld,
  items: readonly OrgItem[],
  item: OrgItem,
  submitted: Submitted,
) {
  if (item.targetOrgId && !item.cascadedFromItemId) activeOrg(world, item.targetOrgId);
  assertRefs(world, items, item);
  if (!item.isStaged) {
    const given = (key: string) => submitted === 'all' || submitted.includes(key);
    const current = item.targetOrgId ? world.orgs.get(item.targetOrgId) : undefined;
    // 改组织行与组织现值相同的人员不算本次变更（现任离职不由本单负责），同组织直改的 submittedPeople。
    const changed = (key: (typeof PEOPLE)[number]) =>
      given(key) && item[key] !== null && item[key] !== (current?.[key] ?? null);
    const people = Object.fromEntries(PEOPLE.filter(changed).map((key) => [key, item[key]]));
    await assertOrgPeopleEligible(tx, orgContext(world.tenantId, now), people, world.view.effectiveDate);
    if (given('code') && item.code !== null && item.code !== (current?.code ?? null)) {
      await assertItemCode(tx, now, world, items, item, item.code);
    }
  }
  assertInRange(world, items, item);
}

/** 停用整支：按生效日展开各级下级（含数据范围校验）并判停用日晚于整支各组织设立日；保存展开连带行与整单校验共用。 */
export async function planStop(tx: Tx, world: ItemWorld, target: OrgRecord, authorize: CascadeAuthorizer) {
  const ctx = orgContext(world.tenantId);
  const plan = await planDeactivationSubtree(tx, ctx, target, world.view.effectiveDate, authorize);
  await assertDeactivationAfterEstablished(tx, ctx, [target.id, ...plan.descendants], plan.from);
  return plan;
}

/** 编码与组织直改同一口径（格式 / 保留编码 / 生效日起被其它组织或未过期预占使用），另判本单其它非暂存行重复。 */
async function assertItemCode(
  tx: Tx,
  now: Date,
  world: ItemWorld,
  items: readonly OrgItem[],
  item: OrgItem,
  code: string,
) {
  const used = () => new AppError('CONFLICT', `组织编码【${code}】在生效日已被使用`, { reason: 'ORG_CODE_DUPLICATE' });
  try {
    await assertCodeAvailable(
      tx,
      orgContext(world.tenantId, now),
      code,
      world.view.effectiveDate,
      item.targetOrgId ?? undefined,
    );
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === 'CONFLICT') throw used();
    if (error.code !== 'VALIDATION_FAILED') throw error;
    throw new AppError('VALIDATION_FAILED', error.message, {
      reason: 'ORG_CODE_INVALID',
      fields: { code: error.message },
    });
  }
  if (items.some((other) => other.id !== item.id && !other.isStaged && other.code === code)) throw used();
}

/** 引用的既有上级须在生效日存在且启用；引用本单行须是本单的新增行。 */
function assertRefs(world: ItemWorld, items: readonly OrgItem[], item: OrgItem) {
  if (item.parentOrgId) activeOrg(world, item.parentOrgId);
  if (item.parentItemId) createdRow(items, item.parentItemId);
}

/** 本单的新增行（被引用为上级 / 同级来源）。 */
export function createdRow(items: readonly OrgItem[], itemId: string): OrgItem {
  const row = items.find((candidate) => candidate.id === itemId && candidate.adjustType === 1);
  if (!row) throw new AppError('NOT_FOUND', '组织调整明细不存在');
  return row;
}

export function existingOrg(world: ItemWorld, orgId: string): OrgRecord {
  const org = world.orgs.get(orgId);
  if (!org) throw new AppError('NOT_FOUND', '组织不存在');
  return org;
}

export function activeOrg(world: ItemWorld, orgId: string): OrgRecord {
  const org = existingOrg(world, orgId);
  if (!org.enabled) {
    throw new AppError('VALIDATION_FAILED', '组织在生效日已停用', { reason: ORG_INACTIVE, orgIds: [orgId] });
  }
  return org;
}
