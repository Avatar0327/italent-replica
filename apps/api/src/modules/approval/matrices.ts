import { or, ilike } from 'drizzle-orm';
import { and, eq, asc, inArray, approvalMatrices, type Tx } from '@italent/db';
import { statusAfter, type VariableStatus, type VariableStatusAction } from '@italent/domain';
import type { z } from 'zod';
import { approvalError, assertRevision, auditApproval, emitOutbox, type ApprovalContext, type Row } from './context.js';
import type { matrixCreateSchema, matrixUpdateSchema, matrixListSchema, MatrixStructureInput } from './matrix-input.js';
import { loadMatrixStructure, replaceMatrixStructure } from './matrix-structure.js';
import { matrixReferenceNames } from './matrix-names.js';

type Head = typeof approvalMatrices.$inferSelect;
const where = (tenantId: string, id: string) =>
  and(eq(approvalMatrices.tenantId, tenantId), eq(approvalMatrices.id, id));
const viewHead = ({ tenantId: _tenantId, ...head }: Head) => head;

export async function lockMatrixHead(tx: Tx, tenantId: string, id: string): Promise<Head> {
  const query = tx.select().from(approvalMatrices).where(where(tenantId, id));
  const [head] = await query.for('update');
  if (!head) throw approvalError('NOT_FOUND', 'APPROVAL_MATRIX_NOT_FOUND', '审批矩阵不存在');
  return head;
}

export async function matrixDetail(tx: Tx, ctx: ApprovalContext, id: string) {
  // 详情中的头、行列与名称在同一个共享锁快照内，避免读到整体保存中间的新旧组合。
  const [head] = await tx.select().from(approvalMatrices).where(where(ctx.tenantId, id)).for('share');
  if (!head) throw approvalError('NOT_FOUND', 'APPROVAL_MATRIX_NOT_FOUND', '审批矩阵不存在');
  const structure = await loadMatrixStructure(tx, ctx.tenantId, id);
  return { ...viewHead(head), ...structure, referenceNames: await matrixReferenceNames(tx, ctx, structure) };
}

export async function listMatrices(tx: Tx, tenantId: string, query: z.infer<typeof matrixListSchema>) {
  const pattern = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await tx
    .select()
    .from(approvalMatrices)
    .where(
      and(
        eq(approvalMatrices.tenantId, tenantId),
        inArray(approvalMatrices.status, query.status === 'active' ? ['draft', 'enabled'] : ['disabled']),
        or(ilike(approvalMatrices.code, pattern), ilike(approvalMatrices.name, pattern)),
      ),
    )
    .orderBy(asc(approvalMatrices.code), asc(approvalMatrices.id))
    .limit(query.limit + 1)
    .offset(query.offset);
  return {
    items: rows.slice(0, query.limit).map(viewHead),
    offset: query.offset,
    limit: query.limit,
    hasMore: rows.length > query.limit,
  };
}

function auditHead(head: Head): Row {
  return { code: head.code, name: head.name, description: head.description, status: head.status };
}
async function audited(tx: Tx, ctx: ApprovalContext, action: string, before: Head | null, after: Head) {
  await auditApproval(tx, ctx, {
    action: `approval.matrix.${action}`,
    objectType: 'approval-matrix',
    objectId: after.id,
    before: before ? auditHead(before) : null,
    after: auditHead(after),
  });
}
async function event(tx: Tx, ctx: ApprovalContext, head: Head, action: string) {
  await emitOutbox(tx, ctx, {
    objectType: 'approval-matrix',
    objectId: head.id,
    eventType: `approval.matrix.${action}`,
    revision: head.revision,
  });
}

export async function createMatrix(tx: Tx, ctx: ApprovalContext, input: z.infer<typeof matrixCreateSchema>) {
  const [head] = await tx
    .insert(approvalMatrices)
    .values({
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      status: 'draft',
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: [approvalMatrices.tenantId, approvalMatrices.code] })
    .returning();
  if (!head) throw approvalError('CONFLICT', 'APPROVAL_MATRIX_CODE_EXISTS', '矩阵编码已存在');
  await audited(tx, ctx, 'create', null, head);
  await event(tx, ctx, head, 'create');
  if (input.enable) {
    const [enabled] = await tx
      .update(approvalMatrices)
      .set({ status: 'enabled' })
      .where(where(ctx.tenantId, head.id))
      .returning();
    await audited(tx, ctx, 'enable', head, enabled!);
    await event(tx, ctx, enabled!, 'enable');
  }
  return matrixDetail(tx, ctx, head.id);
}

async function changedHead(tx: Tx, ctx: ApprovalContext, before: Head, fields: Partial<Head>) {
  const [after] = await tx
    .update(approvalMatrices)
    .set({
      ...fields,
      revision: before.revision + 1,
      updatedBy: ctx.userId,
      updatedAt: ctx.now,
    })
    .where(where(ctx.tenantId, before.id))
    .returning();
  return after!;
}
async function locked(tx: Tx, ctx: ApprovalContext, id: string) {
  const head = await lockMatrixHead(tx, ctx.tenantId, id);
  assertRevision(ctx.expectedRevision, head.revision);
  return head;
}

export async function updateMatrix(
  tx: Tx,
  ctx: ApprovalContext,
  id: string,
  input: z.infer<typeof matrixUpdateSchema>,
) {
  const before = await locked(tx, ctx, id);
  const { revision: _revision, ...fields } = input;
  const after = await changedHead(tx, ctx, before, fields);
  await audited(tx, ctx, 'update', before, after);
  await event(tx, ctx, after, 'update');
  return matrixDetail(tx, ctx, id);
}

export async function changeMatrixStatus(tx: Tx, ctx: ApprovalContext, id: string, action: VariableStatusAction) {
  const before = await locked(tx, ctx, id);
  const status = statusAfter(before.status as VariableStatus, action);
  if (!status) throw approvalError('CONFLICT', 'APPROVAL_MATRIX_STATUS_INVALID', '矩阵当前状态不支持该操作');
  const after = await changedHead(tx, ctx, before, { status });
  await audited(tx, ctx, action, before, after);
  await event(tx, ctx, after, action);
  return matrixDetail(tx, ctx, id);
}

export async function saveMatrixStructure(tx: Tx, ctx: ApprovalContext, id: string, input: MatrixStructureInput) {
  const before = await locked(tx, ctx, id);
  await replaceMatrixStructure(tx, ctx, before, input);
  const after = await changedHead(tx, ctx, before, {});
  await event(tx, ctx, after, 'structure');
  return matrixDetail(tx, ctx, id);
}
