/**
 * 组织明细基线（R2-T08 §2.5，BE-10b2）：建行时记目标组织生效日现行版本与组织 revision；提交（10c）前判外部变更，
 * 刷新基线（路由 8 单行 / 路由 9 整单）把基线改成当前值。刷新即使无变化也 revision + 1 并审计，便于追溯。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { loadOrgSnapshot } from '../org/read-model.js';
import { BASELINE_CHANGED, baselineIssues } from './item-check.js';
import { loadWorld } from './item-tree.js';
import { auditItem, bumpRevision, loadItems, updateItem, type ItemsResult, type OrgItem } from './items-store.js';
import { ORG_INACTIVE } from './range.js';
import { editable, loadAdjustment, type WriteContext } from './service.js';

/** 提交关口：任一非暂存行基线过期 → 409，列出行。 */
export async function assertBaselines(tx: Tx, tenantId: string, adjustmentId: string, _stage: 'submit') {
  const view = await loadAdjustment(tx, tenantId, adjustmentId);
  if (!view) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  const world = await loadWorld(tx, tenantId, view);
  const live = world.items.filter((item) => !item.isStaged);
  const stale = baselineIssues(world, live);
  if (stale.length) {
    throw new AppError('CONFLICT', '组织在添加明细后已被修改，请刷新基线', {
      reason: BASELINE_CHANGED,
      items: stale.map(({ section, itemId }) => ({ section, itemId })),
    });
  }
}

export async function rebaseItem(tx: Tx, ctx: WriteContext, id: string, itemId: string): Promise<ItemsResult> {
  const view = await editable(tx, ctx, id);
  const item = (await loadItems(tx, ctx.tenantId, id)).find((row) => row.id === itemId);
  if (!item) throw new AppError('NOT_FOUND', '组织调整明细不存在');
  return rebase(tx, ctx, view.approvalSubjectOrgId, id, view.effectiveDate, [item]);
}

export async function rebaseAll(tx: Tx, ctx: WriteContext, id: string): Promise<ItemsResult> {
  const view = await editable(tx, ctx, id);
  const items = (await loadItems(tx, ctx.tenantId, id)).filter((item) => item.targetOrgId);
  return rebase(tx, ctx, view.approvalSubjectOrgId, id, view.effectiveDate, items);
}

async function rebase(
  tx: Tx,
  ctx: WriteContext,
  subjectOrgId: string,
  id: string,
  effectiveDate: string,
  items: readonly OrgItem[],
): Promise<ItemsResult> {
  const orgs = new Map((await loadOrgSnapshot(tx, ctx.tenantId, effectiveDate)).map((org) => [org.id, org]));
  const missing = items.filter((item) => item.targetOrgId && !orgs.has(item.targetOrgId));
  if (missing.length) {
    throw new AppError('VALIDATION_FAILED', '组织在生效日不存在或未生效', {
      reason: ORG_INACTIVE,
      orgIds: missing.map((item) => item.targetOrgId),
    });
  }
  const after = items.map((item): OrgItem => {
    const org = item.targetOrgId ? orgs.get(item.targetOrgId) : undefined;
    return org ? { ...item, baseVersionId: org.versionId, baseOrgRevision: org.revision } : item;
  });
  for (const [index, item] of after.entries()) {
    await updateItem(tx, ctx.tenantId, id, item);
    await auditItem(tx, ctx, 'org-adjustment.rebase', { adjustmentId: id, subjectOrgId }, items[index]!, item);
  }
  return { adjustmentId: id, revision: await bumpRevision(tx, ctx, id), items: after };
}
