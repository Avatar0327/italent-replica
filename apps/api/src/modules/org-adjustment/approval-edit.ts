/**
 * 审批中编辑组织调整申请（R2-T08 §6.3 OA-R7，BE-10c；审批中心独立编辑与“编辑并同意”都经适配器 edit）。
 * 引擎已按“节点开放 ∩ 审批人可查看”过滤字段编码（editableInput），这里在同一事务内按审批人当前授权复核：
 * `EditApprovalIngApply@detail`（按名称推断，待取证）+ 字段编辑权 + 主体组织在申请单范围（审批人不豁免，AC-OA-39）+
 * 调整范围与所改行涉及的组织在组织对象范围；改头 / 改行的业务规则与申请人改单相同。整次编辑 revision 只 + 1。
 * 载荷：头字段按编码给值；明细字段 `orgItems.<列>` 给 `[{ itemId, value }]`，上级 / 转移组织的值是组织 ID 或
 * `{ itemRef }`（与快照同形）。行不存在、跨单、连带行一律 400 且不回显行 ID（范围外与不存在同口径，F-339 ③）。
 * 一次构造、一次校验、一次写入（§4.4）：先在内存里算出“改后的头 + 改后的明细”，对这份候选状态跑头校验与整单关口
 * （whole-check，与提交 / 重提、同意前同一入口），全部通过才写头、写行、revision + 1；任何一步失败都不写。
 * 错误信封按审批人字段查看权裁剪（F-339 ②）。
 */
import type { Tx } from '@italent/db';
import { ORG_ADJUSTMENT_APPROVAL_STATUS as STATUS } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ApprovalContext } from '../approval/context.js';
import { invalid } from '../org/validation.js';
import { authorizeHead, orgScopeAuthorizer } from './access.js';
import { trimmedForViewer } from './envelope.js';
import { patchItemSchema, type ItemPatch } from './item-validation.js';
import { loadWorld } from './item-tree.js';
import { bumpRevision } from './items-store.js';
import { persistRevisions, planRevisions } from './org-items.js';
import { assertHeadPatch, loadAdjustment, persistHead, type AdjustmentView } from './service.js';
import { rowOrgIds } from './submission.js';
import { normalizeHead, patchSchema, type HeadPatch } from './validation.js';
import { assertWhole } from './whole-check.js';

type Row = Readonly<Record<string, unknown>>;

const ITEM_PREFIX = 'orgItems.';
/** 明细编码 → 申请人改行载荷的键；行身份、调整类型、暂存标记不在审批中改。 */
const ITEM_KEYS: Readonly<Record<string, string>> = { parentOrgId: 'parent', transferToOrgId: 'transferTo' };
const FIXED_ITEM_COLUMNS = new Set(['adjustType', 'targetOrgId', 'isStaged']);
const ROW_MISSING = '组织调整明细不存在或不能单独修改';

const reference = (value: unknown) => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return { orgId: value };
  const ref = (value as { itemRef?: unknown }).itemRef;
  return ref === undefined ? value : { itemId: ref };
};

function parseHead(fields: Row): HeadPatch | undefined {
  const head = Object.fromEntries(Object.entries(fields).filter(([code]) => !code.startsWith(ITEM_PREFIX)));
  if (!Object.keys(head).length) return undefined;
  const parsed = patchSchema.safeParse(head);
  if (!parsed.success) throw invalid(Object.keys(head)[0]!, parsed.error.issues[0]?.message ?? '字段格式不正确');
  return normalizeHead(parsed.data);
}

/** 明细编码按行分组成改行载荷；每行再按申请人改行同一 schema 校验。 */
function parseItems(fields: Row): Map<string, ItemPatch> {
  const raw = new Map<string, Record<string, unknown>>();
  for (const [code, rows] of Object.entries(fields)) {
    if (!code.startsWith(ITEM_PREFIX)) continue;
    const column = code.slice(ITEM_PREFIX.length);
    if (FIXED_ITEM_COLUMNS.has(column)) throw invalid(code, '该明细字段不能在审批中修改');
    if (!Array.isArray(rows) || !rows.length) throw invalid(code, '明细字段须按行给值');
    for (const entry of rows as { itemId?: unknown; value?: unknown }[]) {
      if (typeof entry?.itemId !== 'string' || !('value' in entry)) throw invalid(code, '明细字段须按行给值');
      const key = ITEM_KEYS[column] ?? column;
      const value = key === column ? entry.value : reference(entry.value);
      raw.set(entry.itemId.toLowerCase(), { ...raw.get(entry.itemId.toLowerCase()), [key]: value });
    }
  }
  const patches = new Map<string, ItemPatch>();
  for (const [itemId, patch] of raw) {
    const parsed = patchItemSchema.safeParse(patch);
    if (!parsed.success) throw invalid('orgItems', parsed.error.issues[0]?.message ?? '明细字段格式不正确');
    patches.set(itemId, parsed.data);
  }
  return patches;
}

/** 审批人对某一版头（主体组织 / 调整范围）的授权：按钮 + 字段编辑权 + 范围（authorizeHead 同一入口）。 */
async function authorizeApprover(tx: Tx, ctx: ApprovalContext, head: AdjustmentView, fields: Row) {
  if (!ctx.exitEditAuthorize) throw new AppError('FORBIDDEN', '没有编辑组织调整申请的权限');
  await authorizeHead(tx, approverDeps(ctx), ctx, {
    actor: 'current_approver',
    operation: 'update',
    button: null,
    fields: Object.keys(fields),
    subjectOrgId: head.approvalSubjectOrgId,
    rangeOrgIds: head.adjustmentRange,
  });
}

const approverDeps = (ctx: ApprovalContext) => ({ authorize: ctx.exitEditAuthorize!, clock: () => ctx.now });

/**
 * 先按现值授权，再解析载荷、找行：范围外的审批人拿不到“行是否存在”的差别（F-339 ③）。
 * 改头时对改后值再判一次；所改行改前改后涉及的组织逐个在组织对象范围。之后按候选状态一次校验、一次写入。
 */
async function edit(tx: Tx, ctx: ApprovalContext, id: string, fields: Row) {
  const view = await loadAdjustment(tx, ctx.tenantId, id, true);
  if (!view) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  await authorizeApprover(tx, ctx, view, fields);
  if (view.approvalStatus !== STATUS.reviewing) {
    throw new AppError('CONFLICT', '申请单不在审批中，不能编辑', { reason: 'ORG_ADJUSTMENT_NOT_IN_REVIEW' });
  }
  const head = parseHead(fields);
  const patches = parseItems(fields);
  const next: AdjustmentView = head ? { ...view, ...head } : view;
  const world = await loadWorld(tx, ctx.tenantId, next);
  const touched = [...patches.keys()].map((itemId) =>
    world.items.find((item) => item.id === itemId && !item.cascadedFromItemId),
  );
  if (touched.some((item) => !item)) throw invalid('orgItems', ROW_MISSING);
  const before = touched.map((item) => item!);
  const after = before.map((item) => ({ ...item, ...toRefs(patches.get(item.id)!) }));
  if (head) await authorizeApprover(tx, ctx, next, fields);
  await orgScopeAuthorizer(approverDeps(ctx), ctx)(tx, rowOrgIds([...before, ...after]));
  const planned = patches.size ? await planRevisions(tx, ctx.now, world, patches) : { items: world.items, changes: [] };
  const candidate = { ...world, items: planned.items };
  if (head) await assertHeadPatch(tx, candidate, head);
  await assertWhole(tx, candidate, ctx.now);
  if (head) await persistHead(tx, ctx, view, head);
  else await bumpRevision(tx, ctx, id);
  await persistRevisions(tx, ctx, next, planned.changes);
}

/** 改行后涉及的已有组织（只为授权取组织 ID，不落库）。 */
function toRefs(patch: ItemPatch) {
  const out: { parentOrgId?: string | null; transferToOrgId?: string | null } = {};
  if (patch.parent !== undefined) out.parentOrgId = patch.parent && 'orgId' in patch.parent ? patch.parent.orgId : null;
  if (patch.transferTo !== undefined) {
    out.transferToOrgId = patch.transferTo && 'orgId' in patch.transferTo ? patch.transferTo.orgId : null;
  }
  return out;
}

export async function editFromApproval(tx: Tx, ctx: ApprovalContext, id: string, fields: Row): Promise<void> {
  await trimmedForViewer(tx, ctx, () => edit(tx, ctx, id, fields));
}

/**
 * 同意前兜底（beforeApprove）：按库里的头与明细跑整单关口，与审批中编辑同一入口、同一裁剪。编辑并同意时引擎先落编辑
 * 再调本函数（approval/actions.ts approveTask），库里即编辑后的最终候选态。
 */
export async function assertApprovable(tx: Tx, ctx: ApprovalContext, id: string): Promise<void> {
  await trimmedForViewer(tx, ctx, async () => {
    const view = await loadAdjustment(tx, ctx.tenantId, id);
    if (!view) throw new AppError('NOT_FOUND', '组织调整申请不存在');
    await assertWhole(tx, await loadWorld(tx, ctx.tenantId, view), ctx.now);
  });
}
