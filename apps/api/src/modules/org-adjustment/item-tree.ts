/**
 * 组织明细与生效日行政树的叠加（R2-T08 §5.2 / §5.6）：写入、整单校验、改头收窄范围共用同一份快照与口径。
 * 范围判定按生效日原树 + 本单新增行（不以明细拟变更上级扩大已有组织范围）；循环 / 层级 / 停用整支 / 引用交 `planOrgTree`。
 */
import type { Tx } from '@italent/db';
import {
  isInAdjustmentRange,
  planOrgTree,
  type AdjustmentOrgRef,
  type AdjustmentRangeNode,
  type OrgPlanIssue,
  type OrgPlanItem,
  type OrgPlanReason,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { loadOrgSnapshot, type OrgRecord } from '../org/read-model.js';
import type { OrgWriteContext } from '../org/validation.js';
import { loadItems, type OrgItem } from './items-store.js';
import type { AdjustmentView } from './service.js';

export const OUT_OF_RANGE = 'ORG_ADJUSTMENT_OUT_OF_RANGE';
export const PLAN_MESSAGES: Record<OrgPlanReason, string> = {
  ORG_ADJUSTMENT_CYCLE: '上级组织不能是该组织自己或其下级',
  ORG_ADJUSTMENT_LEVEL_EXCEEDED: '组织层级不能超过 10 级',
  ORG_ADJUSTMENT_PARENT_STOPPED: '上级组织在本单中已停用',
  ORG_ADJUSTMENT_ITEM_REFERENCE: '引用的组织或明细不存在',
};

export interface ItemWorld {
  readonly tenantId: string;
  readonly view: AdjustmentView;
  readonly items: OrgItem[];
  /** 生效日快照（含停用组织）。 */
  readonly orgs: ReadonlyMap<string, OrgRecord>;
}

export async function loadWorld(tx: Tx, tenantId: string, view: AdjustmentView): Promise<ItemWorld> {
  const items = await loadItems(tx, tenantId, view.id);
  const snapshot = await loadOrgSnapshot(tx, tenantId, view.effectiveDate);
  return { tenantId, view, items, orgs: new Map(snapshot.map((org) => [org.id, org])) };
}

/** 复用组织模块只读判断所需的上下文：只用到租户与当前时刻（编码预占是否过期），不落组织版本。 */
export function orgContext(tenantId: string, now = new Date(0)): OrgWriteContext {
  return { tenantId, userId: '', timezone: 'UTC', rootName: '', now, commandId: '', expectedRevision: 0 };
}

const orgRef = (id: string): AdjustmentOrgRef => ({ kind: 'org', id });
const itemRef = (id: string): AdjustmentOrgRef => ({ kind: 'item', id });
const parentRef = (item: OrgItem) =>
  item.parentOrgId ? orgRef(item.parentOrgId) : item.parentItemId ? itemRef(item.parentItemId) : null;

function rangeNodes(world: ItemWorld, items: readonly OrgItem[]): AdjustmentRangeNode[] {
  const nodes: AdjustmentRangeNode[] = [...world.orgs.values()].map((org) => ({
    ref: orgRef(org.id),
    parent: org.parents.admin?.parentId ? orgRef(org.parents.admin.parentId) : null,
  }));
  for (const item of items) if (item.adjustType === 1) nodes.push({ ref: itemRef(item.id), parent: parentRef(item) });
  return nodes;
}

/** 行的目标与新上级须在调整范围内；返回第一个不在范围的组织（新增行取行 ID）。连带行随发起行，不单判。 */
export function outOfRange(world: ItemWorld, items: readonly OrgItem[], range: readonly string[]) {
  const nodes = rangeNodes(world, items);
  const misses: { itemId: string; orgId: string }[] = [];
  for (const item of items) {
    if (item.cascadedFromItemId) continue;
    const refs = item.adjustType === 1 ? [itemRef(item.id)] : [orgRef(item.targetOrgId!)];
    const parent = item.adjustType === 2 ? parentRef(item) : null;
    if (parent) refs.push(parent);
    const miss = refs.find((ref) => !isInAdjustmentRange(ref, range, nodes));
    if (miss) misses.push({ itemId: item.id, orgId: miss.id });
  }
  return misses;
}

export function assertInRange(world: ItemWorld, items: readonly OrgItem[], item: OrgItem) {
  const [miss] = outOfRange(world, items, world.view.adjustmentRange).filter((m) => m.itemId === item.id);
  if (miss) {
    throw new AppError('VALIDATION_FAILED', '组织不在本单调整范围内', { reason: OUT_OF_RANGE, orgId: miss.orgId });
  }
}

export function planIssues(world: ItemWorld, items: readonly OrgItem[]): OrgPlanIssue[] {
  const root = world.tenantId;
  const orgs = [...world.orgs.values()].map((org) => ({
    id: org.id,
    parentId: org.parents.admin?.parentId ?? (org.id === root ? null : root),
  }));
  const planItems = items.map((item): OrgPlanItem => ({
    id: item.id,
    adjustType: item.adjustType,
    targetOrgId: item.targetOrgId,
    parent: parentRef(item),
    isStaged: item.isStaged,
  }));
  return planOrgTree({ rootId: root, orgs, items: planItems });
}

/**
 * 写入时只拦本次操作新造成的问题：按“原因 + 违规节点”比较操作前后（问题行只是归属，可能落在别的行上，第 2 轮 P2-5）；
 * 操作前已有的问题保留，由整单校验列出。
 */
export function assertPlan(world: ItemWorld, before: readonly OrgItem[], after: readonly OrgItem[]) {
  const existing = new Set(planIssues(world, before).flatMap((i) => i.nodes.map((node) => `${i.reason}:${node}`)));
  const hit = planIssues(world, after).find((i) => i.nodes.some((node) => !existing.has(`${i.reason}:${node}`)));
  if (hit)
    throw new AppError('VALIDATION_FAILED', PLAN_MESSAGES[hit.reason], { reason: hit.reason, itemId: hit.itemId });
}
