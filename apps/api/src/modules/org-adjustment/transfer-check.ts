/**
 * 调动明细的整单校验（R2-T08 §5 / §2.5，BE-11c-b）：提交 / 重提、审批中编辑、同意前兜底与路由 7 共用。
 * 来源与目标部门须在调整范围（§5.6）；目标引用的同单新增组织不能是暂存行；
 * 基线（§2.5）：员工现行任职或 revision 与建行时不同 → 外部已改；同日入职的员工 11c2 前不开放。
 * 问题只带行 ID，不带员工 / 组织 ID（调动行的字段披露按 `transferItems.*` 查看权，F-339 ②）。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { rowsOf } from '../employment/record-store.js';
import type { ItemIssue } from './item-check.js';
import { BASELINE_CHANGED } from './item-check.js';
import { OUT_OF_RANGE, type ItemWorld } from './item-tree.js';
import { SAME_DAY_ENTRY, transferMiss } from './transfer-items.js';
import type { TransferItem } from './transfer-items-store.js';

const ENTRY_KINDS = ['hire', 'rehire', 'retire_rehire'];
const issue = (row: TransferItem, reason: string, message: string): ItemIssue => ({
  section: 'transfer',
  itemId: row.id,
  reason,
  message,
});

/** §2.5：现行任职记录或员工 revision 与建行时不同 → BASELINE_CHANGED。 */
export async function transferBaselineIssues(tx: Tx, world: ItemWorld): Promise<ItemIssue[]> {
  const issues: ItemIssue[] = [];
  for (const row of world.transfers) {
    const record = await findCurrentRecord(tx, world.tenantId, row.employeeId, world.view.effectiveDate);
    const [employee] = rowsOf<{ revision: number }>(
      await tx.execute(sql`SELECT revision FROM employment_employees
        WHERE tenant_id = ${world.tenantId} AND id = ${row.employeeId}::uuid`),
    );
    if (record?.id !== row.baseRecordId || employee?.revision !== row.baseEmployeeRevision) {
      issues.push(issue(row, BASELINE_CHANGED, '员工任职在添加明细后已被修改，请重新添加'));
    }
  }
  return issues;
}

export async function checkTransferItems(tx: Tx, world: ItemWorld): Promise<ItemIssue[]> {
  const issues: ItemIssue[] = [];
  const date = world.view.effectiveDate;
  const orgItems = new Map(world.items.map((item) => [item.id, item]));
  for (const row of world.transfers) {
    if (transferMiss(world, row, world.transferSources.get(row.id) ?? null)) {
      issues.push(issue(row, OUT_OF_RANGE, '调动的来源或目标组织不在本单调整范围内'));
    }
    const referenced = row.departmentItemId ? orgItems.get(row.departmentItemId) : undefined;
    if (row.departmentItemId && (!referenced || referenced.isStaged)) {
      issues.push(issue(row, 'ORG_ADJUSTMENT_STAGED_REFERENCE', '调动目标引用的组织明细不存在或仍是暂存'));
    }
    const record = await findCurrentRecord(tx, world.tenantId, row.employeeId, date);
    if (record && record.effectiveDate === date && ENTRY_KINDS.includes(record.kind)) {
      issues.push(issue(row, SAME_DAY_ENTRY, '同日入职的组织调整调动暂不可用'));
    }
  }
  return [...issues, ...(await transferBaselineIssues(tx, world))];
}

/** 整单关口的基线步（与组织明细的 assertWorldBaselines 同一 409 信封）。 */
export async function assertTransferBaselines(tx: Tx, world: ItemWorld): Promise<void> {
  const stale = await transferBaselineIssues(tx, world);
  if (stale.length) {
    throw new AppError('CONFLICT', '员工任职在添加明细后已被修改，请重新添加', {
      reason: BASELINE_CHANGED,
      items: stale.map(({ section, itemId }) => ({ section, itemId })),
    });
  }
}
