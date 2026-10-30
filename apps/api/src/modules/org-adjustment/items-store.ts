/**
 * 组织明细行的读写（`org_adjustment_org_items`，R2-T08 §2.2）。行按 seq 排序；连带行（停用整支的下级）指向发起行，
 * 删除时先删连带行（自引用外键）。所有写都在调用方已锁申请单行之后进行。
 */
import { sql, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { rowsOf } from '../org/read-model.js';
import type { WriteContext } from './service.js';

export interface OrgItemContent {
  readonly name: string | null;
  readonly code: string | null;
  readonly shortName: string | null;
  readonly parentOrgId: string | null;
  readonly parentItemId: string | null;
  readonly displayOrder: number | null;
  readonly level: number | null;
  readonly halfLevel: number | null;
  readonly updateDescendantLevels: boolean | null;
  readonly personInChargeId: string | null;
  readonly hrbpId: string | null;
  readonly addEmployment: boolean | null;
  readonly transferOldHeadSubordinates: boolean | null;
  readonly adjustNewHeadManager: boolean | null;
  readonly newHeadManagerId: string | null;
  readonly syncEstablishment: boolean | null;
  readonly deactivationEstablishmentMode: number | null;
  readonly establishmentTransferAmount: number | null;
  readonly batchTransfer: boolean | null;
  readonly transferToOrgId: string | null;
  readonly transferToItemId: string | null;
}

export interface OrgItem extends OrgItemContent {
  readonly id: string;
  readonly seq: number;
  readonly adjustType: 1 | 2 | 3;
  readonly targetOrgId: string | null;
  readonly baseVersionId: string | null;
  readonly baseOrgRevision: number | null;
  readonly cascadedFromItemId: string | null;
  readonly isStaged: boolean;
}

const CONTENT_COLUMNS = {
  name: 'name',
  code: 'code',
  shortName: 'short_name',
  parentOrgId: 'parent_org_id',
  parentItemId: 'parent_item_id',
  displayOrder: 'display_order',
  level: 'level',
  halfLevel: 'half_level',
  updateDescendantLevels: 'update_descendant_levels',
  personInChargeId: 'person_in_charge_id',
  hrbpId: 'hrbp_id',
  addEmployment: 'add_employment',
  transferOldHeadSubordinates: 'transfer_old_head_subordinates',
  adjustNewHeadManager: 'adjust_new_head_manager',
  newHeadManagerId: 'new_head_manager_id',
  syncEstablishment: 'sync_establishment',
  deactivationEstablishmentMode: 'deactivation_establishment_mode',
  establishmentTransferAmount: 'establishment_transfer_amount',
  batchTransfer: 'batch_transfer',
  transferToOrgId: 'transfer_to_org_id',
  transferToItemId: 'transfer_to_item_id',
} as const satisfies Record<keyof OrgItemContent, string>;

const COLUMNS = {
  id: 'id',
  seq: 'seq',
  adjustType: 'adjust_type',
  targetOrgId: 'target_org_id',
  baseVersionId: 'base_version_id',
  baseOrgRevision: 'base_org_revision',
  cascadedFromItemId: 'cascaded_from_item_id',
  isStaged: 'is_staged',
  ...CONTENT_COLUMNS,
} as const satisfies Record<keyof OrgItem, string>;

export const CONTENT_KEYS = Object.keys(CONTENT_COLUMNS) as (keyof OrgItemContent)[];
export const EMPTY_CONTENT = Object.fromEntries(CONTENT_KEYS.map((key) => [key, null])) as unknown as OrgItemContent;

const SELECT = sql.raw(
  Object.entries(COLUMNS)
    .map(([key, column]) => `${column} AS "${key}"`)
    .join(', '),
);

/** 本单全部组织明细，按 seq。 */
export async function loadItems(tx: Tx, tenantId: string, adjustmentId: string): Promise<OrgItem[]> {
  return rowsOf<OrgItem>(
    await tx.execute(sql`SELECT ${SELECT} FROM org_adjustment_org_items
      WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId} ORDER BY seq`),
  );
}

export async function loadItem(tx: Tx, tenantId: string, adjustmentId: string, itemId: string) {
  const [row] = rowsOf<OrgItem>(
    await tx.execute(sql`SELECT ${SELECT} FROM org_adjustment_org_items
      WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId} AND id = ${itemId}`),
  );
  return row;
}

export async function insertItem(tx: Tx, tenantId: string, adjustmentId: string, item: OrgItem) {
  const keys = Object.keys(COLUMNS) as (keyof OrgItem)[];
  await tx.execute(sql`INSERT INTO org_adjustment_org_items
    (tenant_id, adjustment_id, ${sql.raw(keys.map((key) => COLUMNS[key]).join(', '))})
    VALUES (${tenantId}, ${adjustmentId}, ${sql.join(
      keys.map((key) => sql`${item[key]}`),
      sql`, `,
    )})`);
}

/** 改内容与基线；行身份（类型、目标、连带、暂存）不改。 */
export async function updateItem(tx: Tx, tenantId: string, adjustmentId: string, item: OrgItem) {
  const keys = [...CONTENT_KEYS, 'baseVersionId', 'baseOrgRevision'] as const;
  const assignments = sql.join(
    keys.map((key) => sql`${sql.raw(COLUMNS[key])} = ${item[key]}`),
    sql`, `,
  );
  await tx.execute(sql`UPDATE org_adjustment_org_items SET ${assignments}
    WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId} AND id = ${item.id}`);
}

/** 先删连带行再删发起行（自引用外键）。 */
export async function deleteItems(tx: Tx, tenantId: string, adjustmentId: string, items: readonly OrgItem[]) {
  const ordered = [...items].sort((a, b) => Number(!a.cascadedFromItemId) - Number(!b.cascadedFromItemId));
  for (const item of ordered) {
    await tx.execute(sql`DELETE FROM org_adjustment_org_items
      WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId} AND id = ${item.id}`);
  }
}

/** 申请单 revision + 1，返回新值。 */
export async function bumpRevision(tx: Tx, ctx: WriteContext, adjustmentId: string): Promise<number> {
  const [row] = rowsOf<{ revision: number }>(
    await tx.execute(sql`UPDATE org_adjustments SET revision = revision + 1, updated_at = ${ctx.now.toISOString()}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${adjustmentId} RETURNING revision`),
  );
  return row!.revision;
}

/** 明细审计：before / after 带申请单 ID，便于按单检索（行删除后仍可查）。 */
export function auditItem(
  tx: Tx,
  ctx: WriteContext,
  action: string,
  scope: { readonly adjustmentId: string; readonly subjectOrgId: string },
  before: OrgItem | null,
  after: OrgItem | null,
) {
  const tag = (item: OrgItem | null) => item && { adjustmentId: scope.adjustmentId, ...item };
  return recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType: 'org-adjustment-item',
    objectId: (after ?? before)!.id,
    before: tag(before),
    after: tag(after),
    commandId: ctx.commandId || null,
    scope: { orgId: scope.subjectOrgId },
  });
}

export interface ItemsResult {
  readonly adjustmentId: string;
  readonly revision: number;
  readonly items: readonly OrgItem[];
}
