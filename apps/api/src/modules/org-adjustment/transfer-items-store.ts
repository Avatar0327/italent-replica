/**
 * 调动明细行的读写（`org_adjustment_transfer_items`，R2-T08 §2.3）。行按 seq 排序；基线（`base_record_id` +
 * `base_employee_revision`）在建行时取生效日现行任职与员工 revision，“变更前”部门不单独建列，从基线任职记录读（硬规则 3）。
 * 所有写都在调用方已锁申请单行之后进行。
 */
import { and, asc, contractRecords, eq, inArray, orgAdjustmentTransferItems as table, sql, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { rowsOf } from '../org/read-model.js';
import type { LinkageOptions } from '../transfer/linkage/input.js';
import type { WriteContext } from './service.js';

export type TransferItem = Omit<typeof table.$inferSelect, 'linkage'> & { readonly linkage: LinkageOptions | null };

type Row = typeof table.$inferSelect;
const asItem = (row: Row): TransferItem => ({ ...row, linkage: row.linkage as LinkageOptions | null });

/** 本单全部调动明细，按 seq。 */
export async function loadTransfers(tx: Tx, tenantId: string, adjustmentId: string): Promise<TransferItem[]> {
  const rows = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.adjustmentId, adjustmentId)))
    .orderBy(asc(table.seq));
  return rows.map(asItem);
}

export async function insertTransfer(tx: Tx, item: TransferItem): Promise<void> {
  await tx.insert(table).values(item);
}

/** 改内容与基线；行身份（员工、生成来源）不改。 */
export async function updateTransfer(tx: Tx, item: TransferItem): Promise<void> {
  const { id, tenantId, adjustmentId, seq: _seq, employeeId: _employee, ...content } = item;
  await tx
    .update(table)
    .set(content)
    .where(and(eq(table.tenantId, tenantId), eq(table.adjustmentId, adjustmentId), eq(table.id, id)));
}

export async function deleteTransfer(tx: Tx, item: TransferItem): Promise<void> {
  await tx
    .delete(table)
    .where(and(eq(table.tenantId, item.tenantId), eq(table.adjustmentId, item.adjustmentId), eq(table.id, item.id)));
}

/** 新行序号：同单最大 seq + 1（调用方已锁申请单行，不会并发）。 */
export async function nextTransferSeq(tx: Tx, tenantId: string, adjustmentId: string): Promise<number> {
  const [row] = rowsOf<{ seq: number }>(
    await tx.execute(sql`SELECT coalesce(max(seq), 0)::int AS seq FROM org_adjustment_transfer_items
      WHERE tenant_id = ${tenantId} AND adjustment_id = ${adjustmentId}`),
  );
  return row!.seq + 1;
}

/** 基线任职记录里的部门（“变更前”）：行 ID → 部门 ID（无部门为 null）。 */
export async function sourceDepartments(
  tx: Tx,
  tenantId: string,
  rows: readonly TransferItem[],
): Promise<Map<string, string | null>> {
  if (!rows.length) return new Map();
  const found = rowsOf<{ id: string; department_id: string | null }>(
    await tx.execute(sql`SELECT t.id, r.department_id FROM org_adjustment_transfer_items t
      JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.employee_id = t.employee_id
        AND r.id = t.base_record_id
      WHERE t.tenant_id = ${tenantId} AND t.id = ANY(${`{${rows.map((row) => row.id).join(',')}}`}::uuid[])`),
  );
  return new Map(found.map((row) => [row.id, row.department_id]));
}

/** 明细审计：before / after 带申请单 ID，便于按单检索（行删除后仍可查）。 */
export function auditTransfer(
  tx: Tx,
  ctx: WriteContext,
  action: string,
  scope: { readonly adjustmentId: string; readonly subjectOrgId: string },
  before: TransferItem | null,
  after: TransferItem | null,
) {
  const tag = (item: TransferItem | null) => item && { ...item, adjustmentId: scope.adjustmentId };
  return recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType: 'org-adjustment-transfer-item',
    objectId: (after ?? before)!.id,
    before: tag(before),
    after: tag(after),
    commandId: ctx.commandId || null,
    scope: { orgId: scope.subjectOrgId },
  });
}

export interface ContractOwner {
  readonly employeeId: string;
  readonly creatorId: string | null;
}

/** 合同变更目标合同的归属（员工与创建人），盲审按合同对象范围判可见用；目标合同已删则不在表里。 */
export async function contractOwners(
  tx: Tx,
  tenantId: string,
  rows: readonly TransferItem[],
): Promise<Map<string, ContractOwner>> {
  const ids = [...new Set(rows.flatMap((row) => (row.linkage?.contract ? [row.linkage.contract.targetId] : [])))];
  if (!ids.length) return new Map();
  const found = rowsOf<{ id: string; employeeId: string; creatorId: string | null }>(
    await tx.execute(sql`SELECT id, employee_id AS "employeeId", created_by AS "creatorId" FROM contract_records
      WHERE tenant_id = ${tenantId} AND id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND NOT deleted`),
  );
  return new Map(found.map((row) => [row.id, { employeeId: row.employeeId, creatorId: row.creatorId }]));
}

/** 合同现值：合同对象字段编码（标准字段名 / `custom:<id>`）→ 当前值，缺省为 null。 */
export type ContractValues = Readonly<Record<string, unknown>>;

const NUMERIC_FIELDS = ['probationSalary', 'regularSalary'] as const;

/**
 * 合同变更目标合同的现值（审批快照的“原值”，§4.5）：取提交 / 重算那一刻的现值，与新值同口径（日期字符串、金额数字）。
 * 目标合同已删则不在表里（按“无原值”处理，披露侧本就 fail-closed）。
 */
export async function contractCurrentValues(
  tx: Tx,
  tenantId: string,
  rows: readonly TransferItem[],
): Promise<Map<string, ContractValues>> {
  const ids = [...new Set(rows.flatMap((row) => (row.linkage?.contract ? [row.linkage.contract.targetId] : [])))];
  if (!ids.length) return new Map();
  const found = await tx
    .select()
    .from(contractRecords)
    .where(
      and(eq(contractRecords.tenantId, tenantId), inArray(contractRecords.id, ids), eq(contractRecords.deleted, false)),
    );
  return new Map(
    found.map((record): [string, ContractValues] => {
      const { customFields, ...standard } = record;
      const values: Record<string, unknown> = { ...standard };
      for (const field of NUMERIC_FIELDS) if (record[field] !== null) values[field] = Number(record[field]);
      for (const [id, value] of Object.entries(customFields ?? {})) values[`custom:${id}`] = value;
      return [record.id, values];
    }),
  );
}
