/**
 * 组织明细增改删（R2-T08 §6.1 路由 4～6，BE-10b2）。每次写：锁申请单 → revision → 申请人与状态（同改头）→
 * 关口与字段 → 内容完整（暂存行跳过）→ 逐行业务规则（item-rules，与整单校验同一入口）→ 停用整支展开连带行 →
 * 100 条上限 → 叠树校验（只拦本次操作新造成的问题）→ 写行 → revision + 1 → 每行一条审计。
 * 组织层数据范围由调用方在命令守卫里先判（access.ts）；同级新增解析出的上级在命令内再判。
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import type { CascadeAuthorizer } from '../org/deactivation.js';
import { validateEmploymentChoice } from '../org/employment-linkage.js';
import type { OrgRecord } from '../org/read-model.js';
import { invalid, type OrganizationPatch } from '../org/validation.js';
import { activeOrg, assertItemRules, createdRow, existingOrg, planStop, type Submitted } from './item-rules.js';
import { assertPlan, loadWorld, type ItemWorld } from './item-tree.js';
import { type AddItemInput, assertItemFields, CHANGE_FIELDS, type ItemPatch, toContent } from './item-validation.js';
import {
  auditItem,
  bumpRevision,
  deleteItems,
  EMPTY_CONTENT,
  insertItem,
  type ItemsResult,
  loadItems,
  type OrgItem,
  type OrgItemContent,
  updateItem,
} from './items-store.js';
import { editable, type AdjustmentView, type WriteContext } from './service.js';

export const ORG_ITEM_LIMIT = 100;

export interface ItemWrite {
  readonly status: 200 | 201;
  readonly result: ItemsResult;
}

/** 路由 4：新增一条明细（停用非暂存行连带整支下级）；拖拽命中本组织已有的改组织行时改该行上级（200）。 */
export async function addOrgItem(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  input: AddItemInput,
  authorize: CascadeAuthorizer,
): Promise<ItemWrite> {
  const view = await editable(tx, ctx, id);
  const drag = input.entry === 'editor.drag';
  assertItemFields(drag ? 'drag' : input.adjustType, input);
  if (drag && !input.parent) throw invalid('parent', '拖拽必须选择上级组织');
  const world = await loadWorld(tx, ctx.tenantId, view);
  const target = input.targetOrgId ? activeOrg(world, input.targetOrgId) : undefined;
  const content = { ...EMPTY_CONTENT, ...toContent(input), ...(await siblingParent(tx, world, input, authorize)) };
  const existing = target && world.items.find((item) => item.targetOrgId === target.id);
  if (existing) {
    if (drag && existing.adjustType === 2 && !existing.cascadedFromItemId) {
      return { status: 200, result: await dragOnto(tx, ctx, world, existing, content) };
    }
    throw duplicate(target.id);
  }
  const item: OrgItem = {
    ...content,
    id: randomUUID(),
    seq: 0,
    adjustType: input.adjustType,
    targetOrgId: target?.id ?? null,
    baseVersionId: target?.versionId ?? null,
    baseOrgRevision: target?.revision ?? null,
    cascadedFromItemId: null,
    isStaged: input.isStaged ?? false,
  };
  if (!item.isStaged) validateContent(item, target);
  await assertItemRules(tx, ctx.now, world, [...world.items, item], item, 'all');
  const cascaded = item.adjustType === 3 && !item.isStaged ? await cascade(tx, world, item, target!, authorize) : [];
  const written = numbered(world.items, [item, ...cascaded]);
  const count = world.items.length + written.length;
  if (count > ORG_ITEM_LIMIT) {
    throw new AppError('PAYLOAD_TOO_LARGE', `组织明细最多 ${ORG_ITEM_LIMIT} 条`, {
      reason: 'ORG_ADJUSTMENT_LIMIT_EXCEEDED',
      section: 'org',
      limit: ORG_ITEM_LIMIT,
      count,
    });
  }
  assertPlan(world, world.items, [...world.items, ...written]);
  for (const row of written) await insertItem(tx, ctx.tenantId, id, row);
  const revision = await finish(
    tx,
    ctx,
    view,
    'org-adjustment.item.create',
    written.map((row) => [null, row]),
  );
  return { status: 201, result: { adjustmentId: id, revision, items: written } };
}

/** 路由 5：改一行内容（行身份与基线不变）；连带行随发起行，不能单独改。 */
export async function patchOrgItem(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  itemId: string,
  patch: ItemPatch,
): Promise<ItemsResult> {
  const view = await editable(tx, ctx, id);
  const world = await loadWorld(tx, ctx.tenantId, view);
  const before = ownRow(world.items, itemId);
  assertItemFields(before.adjustType, patch);
  const after: OrgItem = { ...before, ...toContent(patch) };
  return { adjustmentId: id, ...(await rewrite(tx, ctx, world, before, after, Object.keys(patch))) };
}

/** 路由 6：删一行及其连带行；被本单其它行引用（上级 / 转移组织指向它）时拒绝。返回被删的行（供重放复核范围）。 */
export async function deleteOrgItem(tx: Tx, ctx: WriteContext, id: string, itemId: string): Promise<ItemsResult> {
  const view = await editable(tx, ctx, id);
  const items = await loadItems(tx, ctx.tenantId, id);
  ownRow(items, itemId);
  const removed = items.filter((item) => item.id === itemId || item.cascadedFromItemId === itemId);
  const ids = new Set(removed.map((item) => item.id));
  const referencing = items.find(
    (item) =>
      !ids.has(item.id) && [item.parentItemId, item.transferToItemId].some((ref) => ref !== null && ids.has(ref)),
  );
  if (referencing) {
    throw new AppError('CONFLICT', '该明细被本单其它明细引用为上级或转移组织，请先修改引用行', {
      reason: 'ORG_ADJUSTMENT_ITEM_REFERENCED',
      itemId: referencing.id,
    });
  }
  await deleteItems(tx, ctx.tenantId, id, removed);
  const revision = await finish(
    tx,
    ctx,
    view,
    'org-adjustment.item.delete',
    removed.map((row) => [row, null]),
  );
  return { adjustmentId: id, revision, items: removed };
}

async function dragOnto(
  tx: Tx,
  ctx: WriteContext,
  world: ItemWorld,
  before: OrgItem,
  content: OrgItemContent,
): Promise<ItemsResult> {
  const after: OrgItem = {
    ...before,
    parentOrgId: content.parentOrgId,
    parentItemId: content.parentItemId,
    addEmployment: content.addEmployment,
  };
  return { adjustmentId: world.view.id, ...(await rewrite(tx, ctx, world, before, after, [])) };
}

/** 改一行（修改 / 拖拽共用）：内容完整 → 逐行规则 → 叠树（比较改前改后）→ 写行与审计。 */
async function rewrite(
  tx: Tx,
  ctx: WriteContext,
  world: ItemWorld,
  before: OrgItem,
  after: OrgItem,
  submitted: Submitted,
): Promise<Omit<ItemsResult, 'adjustmentId'>> {
  if (!after.isStaged) validateContent(after, before.targetOrgId ? existingOrg(world, before.targetOrgId) : undefined);
  const items = world.items.map((item) => (item.id === after.id ? after : item));
  await assertItemRules(tx, ctx.now, world, items, after, submitted);
  assertPlan(world, world.items, items);
  await updateItem(tx, ctx.tenantId, world.view.id, after);
  const revision = await finish(tx, ctx, world.view, 'org-adjustment.item.update', [[before, after]]);
  return { revision, items: [after] };
}

/**
 * 同级新增（`editor.peer`，§6.2）：上级取同级来源的上级——既有组织取其生效日行政上级（须在数据范围内），
 * 本单新增行取其上级引用。来源没有上级（根组织）时不能建同级。
 */
async function siblingParent(
  tx: Tx,
  world: ItemWorld,
  input: AddItemInput,
  authorize: CascadeAuthorizer,
): Promise<Pick<OrgItemContent, 'parentOrgId' | 'parentItemId'> | undefined> {
  const sibling = input.siblingOf;
  if (!sibling) return undefined;
  const source =
    'orgId' in sibling
      ? { parentOrgId: existingOrg(world, sibling.orgId).parents.admin?.parentId ?? null, parentItemId: null }
      : createdRow(world.items, sibling.itemId);
  if (!source.parentOrgId && !source.parentItemId) throw invalid('siblingOf', '根组织不能新建同级组织');
  if (source.parentOrgId) await authorize(tx, [source.parentOrgId]);
  return { parentOrgId: source.parentOrgId, parentItemId: source.parentItemId };
}

/** 停用整支：按生效日展开各级下级（含数据范围校验、设立日校验），生效日仍启用的下级各生成一条连带行。 */
async function cascade(
  tx: Tx,
  world: ItemWorld,
  root: OrgItem,
  target: OrgRecord,
  authorize: CascadeAuthorizer,
): Promise<OrgItem[]> {
  const plan = await planStop(tx, world, target, authorize);
  const descendants = new Set(plan.descendants);
  const rows = plan.atFrom
    .filter((org) => descendants.has(org.id) && org.enabled)
    .map((org): OrgItem => ({
      ...EMPTY_CONTENT,
      id: randomUUID(),
      seq: 0,
      adjustType: 3,
      targetOrgId: org.id,
      baseVersionId: org.versionId,
      baseOrgRevision: org.revision,
      cascadedFromItemId: root.id,
      isStaged: false,
    }));
  const taken = rows.find((row) => world.items.some((item) => item.targetOrgId === row.targetOrgId));
  if (taken) throw duplicate(taken.targetOrgId!);
  return rows;
}

/**
 * 内容完整：新增须有名称与上级；改组织至少改一项、改名 / 改上级须选是否新增任职（OA-R3，与组织直改同一判断）；
 * 负责人变化时两项联动必填（11e 前只能选“否”），未变化不许填。
 */
function validateContent(item: OrgItem, current: OrgRecord | undefined) {
  if (item.adjustType === 1) {
    if (!item.name) throw invalid('name', '新增组织必须填写名称');
    if (!item.parentOrgId && !item.parentItemId) throw invalid('parent', '新增组织必须选择上级组织');
  }
  if (item.adjustType === 2) {
    if (!CHANGE_FIELDS.some((key) => item[key] !== null)) throw invalid('name', '改组织明细至少修改一项');
    const parentId = item.parentOrgId ?? item.parentItemId;
    validateEmploymentChoice(current!, {
      effectiveDate: '',
      ...(item.name !== null && { name: item.name }),
      ...(parentId !== null && { parents: { admin: { parentId } } }),
      ...(item.addEmployment !== null && { addEmployment: item.addEmployment }),
    } as OrganizationPatch);
  }
  if (item.adjustType === 3) return;
  const changed = item.personInChargeId !== null && item.personInChargeId !== (current?.personInChargeId ?? null);
  const flags = [item.transferOldHeadSubordinates, item.adjustNewHeadManager];
  if (changed && flags.some((flag) => flag === null)) {
    throw invalid('transferOldHeadSubordinates', '负责人变化时必须选择是否转移原负责人下属及是否调整新负责人上级');
  }
  if (!changed && flags.some((flag) => flag !== null)) {
    throw invalid('transferOldHeadSubordinates', '负责人未变化时不能选择负责人联动');
  }
}

/** 本单的行；连带行不能单独改删。 */
function ownRow(items: readonly OrgItem[], itemId: string): OrgItem {
  const row = items.find((item) => item.id === itemId);
  if (!row) throw new AppError('NOT_FOUND', '组织调整明细不存在');
  if (row.cascadedFromItemId) {
    throw new AppError('CONFLICT', '连带停用的明细随发起行，不能单独修改或删除', {
      reason: 'ORG_ADJUSTMENT_ITEM_CASCADED',
    });
  }
  return row;
}

function duplicate(orgId: string) {
  return new AppError('CONFLICT', '本单已有该组织的明细', { reason: 'ORG_ADJUSTMENT_ITEM_DUPLICATE', orgId });
}

function numbered(existing: readonly OrgItem[], rows: readonly OrgItem[]): OrgItem[] {
  const last = existing.reduce((max, item) => Math.max(max, item.seq), 0);
  return rows.map((row, index) => ({ ...row, seq: last + index + 1 }));
}

async function finish(
  tx: Tx,
  ctx: WriteContext,
  view: AdjustmentView,
  action: string,
  changes: readonly (readonly [OrgItem | null, OrgItem | null])[],
): Promise<number> {
  const revision = await bumpRevision(tx, ctx, view.id);
  const scope = { adjustmentId: view.id, subjectOrgId: view.approvalSubjectOrgId };
  for (const [before, after] of changes) await auditItem(tx, ctx, action, scope, before, after);
  return revision;
}
