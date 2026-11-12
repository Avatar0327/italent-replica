import { randomUUID } from 'node:crypto';
import { and, eq, asc, approvalMatrixColumns, approvalMatrixRows, approvalMatrixCells, type Tx } from '@italent/db';
import { auditApproval, type ApprovalContext, type Row } from './context.js';
import { matrixInvalid, validateMatrixStructure, type MatrixStructureInput } from './matrix-input.js';

export interface MatrixColumn {
  id: string;
  kind: string;
  dimension: string | null;
  includeChildren: boolean;
  name: string;
  seq: number;
  allowMultiple: boolean;
}
export interface MatrixRow {
  id: string;
  seq: number;
  cells: Record<string, string[]>;
}
export interface MatrixStructure {
  columns: MatrixColumn[];
  rows: MatrixRow[];
}

export async function loadMatrixStructure(tx: Tx, tenantId: string, matrixId: string): Promise<MatrixStructure> {
  const columns = await tx
    .select({
      id: approvalMatrixColumns.id,
      kind: approvalMatrixColumns.kind,
      dimension: approvalMatrixColumns.dimension,
      includeChildren: approvalMatrixColumns.includeChildren,
      name: approvalMatrixColumns.name,
      seq: approvalMatrixColumns.seq,
      allowMultiple: approvalMatrixColumns.allowMultiple,
    })
    .from(approvalMatrixColumns)
    .where(and(eq(approvalMatrixColumns.tenantId, tenantId), eq(approvalMatrixColumns.matrixId, matrixId)))
    .orderBy(asc(approvalMatrixColumns.seq));
  const storedRows = await tx
    .select({ id: approvalMatrixRows.id, seq: approvalMatrixRows.seq })
    .from(approvalMatrixRows)
    .where(and(eq(approvalMatrixRows.tenantId, tenantId), eq(approvalMatrixRows.matrixId, matrixId)))
    .orderBy(asc(approvalMatrixRows.seq));
  const cells = await tx
    .select({
      rowId: approvalMatrixCells.rowId,
      columnId: approvalMatrixCells.columnId,
      refIds: approvalMatrixCells.refIds,
    })
    .from(approvalMatrixCells)
    .innerJoin(
      approvalMatrixRows,
      and(
        eq(approvalMatrixCells.tenantId, approvalMatrixRows.tenantId),
        eq(approvalMatrixCells.rowId, approvalMatrixRows.id),
      ),
    )
    .where(and(eq(approvalMatrixRows.tenantId, tenantId), eq(approvalMatrixRows.matrixId, matrixId)));
  const byRow = new Map(storedRows.map((r) => [r.id, new Map<string, string[]>()]));
  for (const cell of cells) byRow.get(cell.rowId)!.set(cell.columnId, cell.refIds);
  return {
    columns,
    rows: storedRows.map((r) => ({
      ...r,
      cells: Object.fromEntries(columns.map((c) => [c.id, byRow.get(r.id)!.get(c.id) ?? []])),
    })),
  };
}

function candidate(input: MatrixStructureInput, before: MatrixStructure): MatrixStructure {
  validateMatrixStructure(input);
  const oldColumns = new Set(before.columns.map((c) => c.id));
  const oldRows = new Set(before.rows.map((r) => r.id));
  if (input.columns.some((c) => c.id && !oldColumns.has(c.id)))
    matrixInvalid('COLUMN_ID_UNKNOWN', '列标识不属于当前矩阵');
  if (input.rows.some((r) => r.id && !oldRows.has(r.id))) matrixInvalid('ROW_ID_UNKNOWN', '行标识不属于当前矩阵');
  const columns = input.columns.map(({ key: _key, ...c }, index) => ({
    ...c,
    id: c.id ?? randomUUID(),
    dimension: c.dimension ?? null,
    seq: index + 1,
  }));
  const rows = input.rows.map((r, index) => ({
    id: r.id ?? randomUUID(),
    seq: index + 1,
    cells: Object.fromEntries(columns.map((c, i) => [c.id, r.cells[input.columns[i]!.key] ?? []])),
  }));
  return { columns, rows };
}

function auditEntries(structure: MatrixStructure): Row {
  return Object.fromEntries([
    ...structure.columns.map(({ id, ...column }) => [`column:${id}`, column]),
    ...structure.rows.map(({ id, ...row }) => [`row:${id}`, row]),
  ]);
}

/** 设计 §4.5：结构差异始终包含整列、整行，删除额外保留列名快照。 */
async function auditStructure(
  tx: Tx,
  ctx: ApprovalContext,
  matrix: { id: string; code: string },
  before: MatrixStructure,
  after: MatrixStructure,
) {
  await auditApproval(tx, ctx, {
    action: 'approval.matrix.structure',
    objectType: 'approval-matrix',
    objectId: matrix.id,
    before: auditEntries(before),
    after: auditEntries(after),
  });
  const kept = new Set(after.rows.map((r) => r.id));
  const columns = Object.fromEntries(before.columns.map((c) => [c.id, { name: c.name, kind: c.kind }]));
  for (const row of before.rows) {
    if (kept.has(row.id)) continue;
    await auditApproval(tx, ctx, {
      action: 'approval.matrix.row.delete',
      objectType: 'approval-matrix-row',
      objectId: row.id,
      before: { matrixId: matrix.id, matrixCode: matrix.code, seq: row.seq, cells: row.cells, columns },
      after: null,
    });
  }
}

/** 调用方已持有矩阵头锁。先检查候选态，再整体重写，稳定 ID 保留，任何失败由命令事务回滚。 */
export async function replaceMatrixStructure(
  tx: Tx,
  ctx: ApprovalContext,
  matrix: { id: string; code: string },
  input: MatrixStructureInput,
) {
  const before = await loadMatrixStructure(tx, ctx.tenantId, matrix.id);
  const after = candidate(input, before);
  await tx
    .delete(approvalMatrixRows)
    .where(and(eq(approvalMatrixRows.tenantId, ctx.tenantId), eq(approvalMatrixRows.matrixId, matrix.id)));
  await tx
    .delete(approvalMatrixColumns)
    .where(and(eq(approvalMatrixColumns.tenantId, ctx.tenantId), eq(approvalMatrixColumns.matrixId, matrix.id)));
  if (after.columns.length)
    await tx.insert(approvalMatrixColumns).values(
      after.columns.map((c) => ({
        ...c,
        tenantId: ctx.tenantId,
        matrixId: matrix.id,
      })),
    );
  if (after.rows.length)
    await tx.insert(approvalMatrixRows).values(
      after.rows.map(({ id, seq }) => ({
        id,
        seq,
        tenantId: ctx.tenantId,
        matrixId: matrix.id,
      })),
    );
  const cells = after.rows.flatMap((r) =>
    Object.entries(r.cells).map(([columnId, refIds]) => ({
      tenantId: ctx.tenantId,
      rowId: r.id,
      columnId,
      refIds,
    })),
  );
  // 最坏 7500 格，分批控制驱动参数数目，所有批次仍在同一事务内。
  for (let start = 0; start < cells.length; start += 500)
    await tx.insert(approvalMatrixCells).values(cells.slice(start, start + 500));
  await auditStructure(tx, ctx, matrix, before, after);
}
