/**
 * 调动明细增改删（R2-T08 §6.1 路由 16～18，BE-11c-b）。每次写：锁申请单 → revision → 申请人与状态（同改头）→
 * 500 条上限 → 同员工只一行 → 员工现行任职基线 → 授权与调动表单校验（gate，与人工调动同一条链）→
 * 同日入职关口 → 调整范围 → 写行 → revision + 1 → 每行一条审计。
 * 基线（`base_record_id` + `base_employee_revision`）在建行时取生效日现行任职；“变更前”部门不单独建列（硬规则 3）。
 * 授权与表单校验由调用方注入（`TransferGate`）：服务本身不碰权限与请求上下文，首次与幂等重放用同一个 gate。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { isInAdjustmentRange } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { rowsOf } from '../employment/record-store.js';
import { invalid } from '../org/validation.js';
import type { TransferInput } from '../transfer/service.js';
import { ROW_NOT_FOUND } from './hidden-rows.js';
import { bumpRevision } from './items-store.js';
import { itemRef, loadWorld, orgRef, OUT_OF_RANGE, rangeNodes, type ItemWorld } from './item-tree.js';
import { editable, type AdjustmentView, type WriteContext } from './service.js';
import {
  auditTransfer,
  deleteTransfer,
  insertTransfer,
  nextTransferSeq,
  updateTransfer,
  type TransferItem,
} from './transfer-items-store.js';

export const TRANSFER_ITEM_LIMIT = 500;
export const SAME_DAY_ENTRY = 'ORG_ADJUSTMENT_SAME_DAY_ENTRY_NOT_AVAILABLE';
const ENTRY_KINDS = ['hire', 'rehire', 'retire_rehire'];

const uuid = z.uuid().transform((value) => value.toLowerCase());
const reference = z.union([z.strictObject({ orgId: uuid }), z.strictObject({ itemId: uuid })]);
const content = {
  department: reference,
  positionId: uuid.nullable().optional(),
  postId: uuid.nullable().optional(),
  levelId: uuid.nullable().optional(),
  directManagerId: uuid.nullable().optional(),
  // 显式给 null 表示清空虚线经理；不给则继承调动表单（11c-a 交接记录 be11ca_dev_result_r1.md 的 dottedManagerSpecified）
  dottedManagerId: uuid.nullable().optional(),
  transferTypeCode: z.string().min(1).max(64),
  // 新增必须给表单 ID（第 2 轮 P2-3 保守口径：不按调动类型取默认表单）；PATCH 为 partial，可不给
  formId: z.string().min(1).max(128),
  reasonCode: z.string().min(1).max(64).nullable().optional(),
  withEstablishment: z.boolean().optional(),
  // 联动选项的结构与业务校验交 normalizeLinkage / normalizeTransferInput，这里只收对象
  linkage: z.record(z.string(), z.unknown()).nullable().optional(),
};
export const addTransferSchema = z.strictObject({ employeeId: uuid, ...content });
export const patchTransferSchema = z
  .strictObject(content)
  .partial()
  .refine((value) => Object.keys(value).length > 0, '至少修改一个字段');
export type AddTransferInput = z.infer<typeof addTransferSchema>;
export type TransferPatch = z.infer<typeof patchTransferSchema>;

/**
 * 授权与调动表单校验（路由层注入）：全部在命令事务内、锁住申请单之后判，新旧两侧都判（§6.3）。
 * `before` 为修改前的整行（新建为 null）；`save` 返回规范化后的调动输入。
 */
export interface TransferGate {
  save(
    tx: Tx,
    view: Pick<AdjustmentView, 'approvalSubjectOrgId' | 'effectiveDate'>,
    employeeId: string,
    draft: TransferContent,
    before: TransferItem | null,
  ): Promise<TransferInput>;
  remove(
    tx: Tx,
    view: Pick<AdjustmentView, 'approvalSubjectOrgId' | 'effectiveDate'>,
    row: TransferItem,
  ): Promise<void>;
  /** 幂等重放（保存类）：结果行按新建口径（before = null）按当前权限再判，不重写。 */
  rejudge(tx: Tx, view: AdjustmentView, rows: readonly TransferItem[]): Promise<void>;
  /** 幂等重放（删除类）：被删的行是旧值，按删除口径再判。 */
  rejudgeRemoved(tx: Tx, view: AdjustmentView, rows: readonly TransferItem[]): Promise<void>;
}

/** 行内容 → normalizeTransferInput 的原始入参（HR 入口、直接生效口径，与执行器同形）。 */
export function transferRaw(effectiveDate: string, row: TransferContent): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ['departmentId', 'positionId', 'postId', 'levelId', 'directManagerId'] as const) {
    if (row[key]) fields[key] = row[key];
  }
  if (row.dottedManagerSpecified) fields.dottedManagerId = row.dottedManagerId;
  return {
    initiator: 'hr',
    transferTypeCode: row.transferTypeCode,
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    mode: 'direct',
    effectiveDate,
    formId: row.formId,
    fields,
    submit: false,
    withEstablishment: row.withEstablishment,
    ...(row.linkage ? { linkage: row.linkage } : {}),
  };
}

export type TransferContent = Pick<
  TransferItem,
  | 'departmentId'
  | 'departmentItemId'
  | 'positionId'
  | 'postId'
  | 'levelId'
  | 'directManagerId'
  | 'dottedManagerId'
  | 'dottedManagerSpecified'
  | 'transferTypeCode'
  | 'formId'
  | 'reasonCode'
  | 'withEstablishment'
  | 'linkage'
>;

export interface TransferResult {
  readonly adjustmentId: string;
  readonly revision: number;
  readonly items: TransferItem[];
}

export interface TransferWrite {
  readonly status: 200 | 201;
  readonly result: TransferResult;
}

/** 路由 16：新增一行；同单已有该员工、超过 500 条、目标 / 来源不在调整范围均拒绝。 */
export async function addTransferItem(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  input: AddTransferInput,
  gate: TransferGate,
  hidden: ReadonlySet<string>,
): Promise<TransferWrite> {
  const view = await editable(tx, ctx, id);
  const world = await loadWorld(tx, ctx.tenantId, view);
  const count = world.transfers.length + 1;
  if (count > TRANSFER_ITEM_LIMIT) {
    throw new AppError('PAYLOAD_TOO_LARGE', `调动明细最多 ${TRANSFER_ITEM_LIMIT} 条`, {
      reason: 'ORG_ADJUSTMENT_LIMIT_EXCEEDED',
      section: 'transfer',
      limit: TRANSFER_ITEM_LIMIT,
      count,
    });
  }
  if (world.transfers.some((row) => row.employeeId === input.employeeId)) throw duplicate(input.employeeId);
  const draft = draftOf(EMPTY, input);
  assertOrgItemTarget(world, draft, hidden);
  const prepared = await gate.save(tx, view, input.employeeId, draft, null);
  const base = await captureBaseline(tx, ctx.tenantId, input.employeeId, view.effectiveDate);
  const row: TransferItem = {
    ...draft,
    ...resolved(prepared),
    id: randomUUID(),
    tenantId: ctx.tenantId,
    adjustmentId: id,
    seq: await nextTransferSeq(tx, ctx.tenantId, id),
    employeeId: input.employeeId,
    baseRecordId: base.recordId,
    baseEmployeeRevision: base.revision,
    positionItemId: null, // 同单职位引用随 11d
    generatedByItemId: null,
    generatedReason: null,
    createdBusinessId: null,
    execPhase: 0,
    executionResult: null,
    executionReason: null,
    executionMessage: null,
  };
  assertTransferInRange(world, row, base.departmentId);
  await insertTransfer(tx, row);
  return { status: 201, result: await finish(tx, ctx, world, 'org-adjustment.transfer-item.create', [[null, row]]) };
}

/** 路由 17：改一行内容（员工与基线不变）。生成行（11c2）不能单独改。 */
export async function patchTransferItem(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  itemId: string,
  patch: TransferPatch,
  gate: TransferGate,
  hidden: ReadonlySet<string>,
): Promise<TransferWrite> {
  const view = await editable(tx, ctx, id);
  const world = await loadWorld(tx, ctx.tenantId, view);
  const before = ownRow(world, itemId);
  const merged = draftOf(before, patch);
  assertOrgItemTarget(world, merged, hidden);
  const prepared = await gate.save(tx, view, before.employeeId, merged, before);
  const after: TransferItem = { ...before, ...merged, ...resolved(prepared) };
  assertTransferInRange(world, after, world.transferSources.get(before.id) ?? null);
  await updateTransfer(tx, after);
  const result = await finish(tx, ctx, world, 'org-adjustment.transfer-item.update', [[before, after]]);
  return { status: 200, result };
}

/** 路由 18：删一行。被删的行随结果返回，供重放复核范围。 */
export async function deleteTransferItem(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  itemId: string,
  gate: TransferGate,
): Promise<TransferWrite> {
  const view = await editable(tx, ctx, id);
  const world = await loadWorld(tx, ctx.tenantId, view);
  const before = ownRow(world, itemId);
  await gate.remove(tx, view, before);
  await deleteTransfer(tx, before);
  const result = await finish(tx, ctx, world, 'org-adjustment.transfer-item.delete', [[before, null]]);
  return { status: 200, result };
}

export const EMPTY: TransferContent = {
  departmentId: null,
  departmentItemId: null,
  positionId: null,
  postId: null,
  levelId: null,
  directManagerId: null,
  dottedManagerId: null,
  dottedManagerSpecified: false,
  transferTypeCode: '',
  formId: '',
  reasonCode: null,
  withEstablishment: false,
  linkage: null,
};

/** 请求里给了的键才覆盖（PATCH 没给的保持原值）；联动传入时先规范化再存。 */
function contentOf(input: Partial<AddTransferInput>): Partial<TransferContent> {
  const out: Partial<Record<keyof TransferContent, unknown>> = {};
  for (const key of ['positionId', 'postId', 'levelId', 'directManagerId', 'reasonCode', 'transferTypeCode'] as const) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (input.formId !== undefined) out.formId = input.formId;
  if (input.withEstablishment !== undefined) out.withEstablishment = input.withEstablishment;
  if (input.dottedManagerId !== undefined) {
    out.dottedManagerId = input.dottedManagerId;
    out.dottedManagerSpecified = true;
  }
  if (input.linkage !== undefined) out.linkage = input.linkage;
  return out as Partial<TransferContent>;
}

/** gate 规范化后的值落库：表单 ID（缺省取类型默认表单）与联动选项以规范化结果为准。 */
export function resolved(input: TransferInput) {
  return { formId: input.employment.formId, linkage: input.linkage, reasonCode: input.reasonCode ?? null };
}

/** 请求内容叠到现有内容上（新增时现有内容为空）；路由守卫与写服务共用，两边算出同一份调动表单入参。 */
export function draftOf(base: TransferContent, input: Partial<AddTransferInput>): TransferContent {
  const department = input.department
    ? 'orgId' in input.department
      ? { departmentId: input.department.orgId, departmentItemId: null }
      : { departmentId: null, departmentItemId: input.department.itemId }
    : {};
  return { ...base, ...department, ...contentOf(input) };
}

/** 目标引用本单新增组织行时：行须存在且是新增（隐藏行与不存在同一 404）。 */
export function assertOrgItemTarget(world: ItemWorld, draft: TransferContent, hidden: ReadonlySet<string>) {
  if (!draft.departmentItemId) return;
  const item = world.items.find((row) => row.id === draft.departmentItemId);
  if (!item || hidden.has(item.id)) throw new AppError('NOT_FOUND', ROW_NOT_FOUND);
  if (item.adjustType !== 1) throw invalid('department', '调动目标只能引用本单新增的组织明细');
}

function ownRow(world: ItemWorld, itemId: string): TransferItem {
  const row = world.transfers.find((item) => item.id === itemId);
  if (!row) throw new AppError('NOT_FOUND', ROW_NOT_FOUND);
  if (row.generatedByItemId) {
    throw new AppError('CONFLICT', '系统生成的调动明细随来源行，不能单独修改或删除', {
      reason: 'ORG_ADJUSTMENT_ITEM_GENERATED',
    });
  }
  return row;
}

const duplicate = (employeeId: string) =>
  new AppError('CONFLICT', '本单已有该员工的调动明细', { reason: 'ORG_ADJUSTMENT_ITEM_DUPLICATE', employeeId });

/** 生效日现行任职 + 员工 revision；没有现行任职的员工不能调动；同日入职走 11c2 才开放。 */
async function captureBaseline(tx: Tx, tenantId: string, employeeId: string, effectiveDate: string) {
  const record = await findCurrentRecord(tx, tenantId, employeeId, effectiveDate);
  if (!record) throw invalid('employeeId', '员工在生效日没有现行任职');
  if (record.effectiveDate === effectiveDate && ENTRY_KINDS.includes(record.kind)) {
    throw new AppError('CONFLICT', '同日入职的组织调整调动暂不可用', { reason: SAME_DAY_ENTRY });
  }
  const [employee] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_employees
      WHERE tenant_id = ${tenantId} AND id = ${employeeId}::uuid`),
  );
  return {
    recordId: record.id,
    revision: employee!.revision,
    departmentId: (record.fields.departmentId as string | null | undefined) ?? null,
  };
}

/** §5.6：来源（基线任职）与目标部门都须在调整范围内；目标是本单新增组织时按行 ID 判。 */
export function assertTransferInRange(world: ItemWorld, row: TransferItem, source: string | null) {
  const miss = transferMiss(world, row, source);
  if (miss) {
    throw new AppError('VALIDATION_FAILED', '组织不在本单调整范围内', {
      reason: OUT_OF_RANGE,
      section: 'transfer',
      orgId: miss,
    });
  }
}

/** 返回第一个不在范围内的组织（来源部门或目标部门）；都在范围内返回 undefined。 */
export function transferMiss(world: ItemWorld, row: TransferItem, source: string | null): string | undefined {
  const nodes = rangeNodes(world, world.items);
  const target = row.departmentId
    ? orgRef(row.departmentId)
    : row.departmentItemId
      ? itemRef(row.departmentItemId)
      : null;
  const refs = [source ? orgRef(source) : null, target].filter((ref) => ref !== null);
  return refs.find((ref) => !isInAdjustmentRange(ref, world.view.adjustmentRange, nodes))?.id;
}

async function finish(
  tx: Tx,
  ctx: WriteContext,
  world: ItemWorld,
  action: string,
  changes: readonly (readonly [TransferItem | null, TransferItem | null])[],
): Promise<TransferResult> {
  const adjustmentId = world.view.id;
  const revision = await bumpRevision(tx, ctx, adjustmentId);
  const scope = { adjustmentId, subjectOrgId: world.view.approvalSubjectOrgId };
  for (const [before, after] of changes) await auditTransfer(tx, ctx, action, scope, before, after);
  return { adjustmentId, revision, items: changes.map(([before, after]) => (after ?? before)!) };
}

/**
 * 审批中编辑（BE-11c-b 第 2 轮 P2-1）：已授权、已按候选状态校验过的改动一次落库（不 bump revision，由编辑入口统一 + 1）。
 * 每行一条明细审计，与申请人改行同一动作名。
 */
export async function persistTransferEdits(
  tx: Tx,
  ctx: WriteContext,
  view: Pick<AdjustmentView, 'id' | 'approvalSubjectOrgId'>,
  edits: readonly (readonly [before: TransferItem, after: TransferItem])[],
): Promise<void> {
  const scope = { adjustmentId: view.id, subjectOrgId: view.approvalSubjectOrgId };
  for (const [before, after] of edits) {
    await updateTransfer(tx, after);
    await auditTransfer(tx, ctx, 'org-adjustment.transfer-item.update', scope, before, after);
  }
}

/** 改头收窄范围 / 改生效日时，已有调动明细仍须在范围内（§5.6）；列出不在范围的行（只带行 ID）。 */
export function transferMisses(world: ItemWorld) {
  return world.transfers
    .filter((row) => transferMiss(world, row, world.transferSources.get(row.id) ?? null))
    .map((row) => ({ section: 'transfer' as const, itemId: row.id }));
}
