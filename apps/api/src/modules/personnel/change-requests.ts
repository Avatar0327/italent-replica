import { randomUUID } from 'node:crypto';
import { sql, type Db, type Tx } from '@italent/db';
import { PERSONNEL_REQUEST_OBJECT, SUBSETS, type SubsetKind } from '@italent/domain';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import {
  audit,
  assertRevision,
  camel,
  insert,
  lockPerson,
  rows,
  update,
  type PersonnelContext,
  type Row,
} from './store.js';
import { loadSubset, saveSubset } from './subsets.js';
import { subsetInput } from './validation.js';

export interface ChangeInput {
  readonly employeeId: string;
  readonly subset: SubsetKind;
  readonly recordId?: string;
  readonly targetRevision?: number;
  readonly values: Row;
}
export async function requireSelf(tx: Tx, ctx: PersonnelContext, employeeId: string) {
  const [link] = rows(
    await tx.execute(sql`SELECT employee_id FROM permission_user_person_links
    WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId} AND employee_id=${employeeId}::uuid LIMIT 1`),
  );
  if (!link) throw new AppError('NOT_FOUND', '个人信息不存在');
}
export async function createChange(tx: Tx, ctx: PersonnelContext, input: ChangeInput) {
  assertRevision(ctx.expectedRevision, 0);
  await requireSelf(tx, ctx, input.employeeId);
  await lockPerson(tx, ctx, input.employeeId);
  if (input.recordId) {
    const record = await loadSubset(tx, ctx, input.employeeId, input.subset, input.recordId);
    assertRevision(input.targetRevision ?? 0, Number(record.revision));
  } else assertRevision(input.targetRevision ?? 0, 0);
  const row = {
    id: randomUUID(),
    tenantId: ctx.tenantId,
    employeeId: input.employeeId,
    subset: input.subset,
    recordId: input.recordId ?? null,
    targetRevision: input.targetRevision ?? 0,
    revision: 1,
    status: 'pending_approval',
    values: input.values,
    createdBy: ctx.userId,
    commandId: ctx.commandId,
    createdAt: ctx.now.toISOString(),
  };
  await insert(tx, 'personnel_change_requests', { ...row, values: JSON.stringify(row.values) });
  await audit(tx, ctx, PERSONNEL_REQUEST_OBJECT, input.employeeId, row.id, 1, null, row);
  return row;
}
export async function loadChange(tx: Tx, ctx: PersonnelContext, id: string) {
  const [row] = rows(
    await tx.execute(sql`SELECT * FROM personnel_change_requests
    WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid LIMIT 1`),
  );
  if (!row) throw new AppError('NOT_FOUND', '个人信息变更申请不存在');
  return camel(row);
}
/**
 * TODO(R1-T07)：仅在审批中心完成节点鉴权、非自审与审批决定持久化后同事务调用。
 * 此函数不代表审批决定，不挂公开 HTTP 路由；用于履行已通过申请的业务落地。
 */
export async function applyApprovedChangeInTransaction(tx: Tx, ctx: PersonnelContext, id: string) {
  const initial = await loadChange(tx, ctx, id);
  await lockPerson(tx, ctx, String(initial.employeeId));
  const before = await loadChange(tx, ctx, id);
  assertRevision(ctx.expectedRevision, Number(before.revision));
  if (before.status !== 'pending_approval') throw new AppError('CONFLICT', '申请不在待审批状态');
  const kind = before.subset as SubsetKind;
  if (!Object.hasOwn(SUBSETS, kind)) throw new AppError('VALIDATION_FAILED', '申请子集不存在');
  const values = subsetInput(kind, before.values, true);
  const result = await saveSubset(
    tx,
    { ...ctx, expectedRevision: Number(before.targetRevision) },
    String(before.employeeId),
    kind,
    values,
    before.recordId ? String(before.recordId) : undefined,
    false,
    { type: 'self_service', id },
  );
  const after = { ...before, status: 'applied', revision: Number(before.revision) + 1 };
  await update(
    tx,
    'personnel_change_requests',
    { status: 'applied', revision: after.revision },
    sql`tenant_id=${ctx.tenantId} AND id=${id}::uuid`,
  );
  await audit(tx, ctx, PERSONNEL_REQUEST_OBJECT, String(before.employeeId), id, after.revision, before, after);
  return { ...after, resultId: result.id };
}
export async function applyApprovedChange(db: Db, ctx: PersonnelContext, id: string) {
  return runCommand(db, ctx, {
    id: ctx.commandId,
    fingerprint: { operation: 'personnel.apply-approved-change', id, revision: ctx.expectedRevision },
    execute: async (tx, commandId) => ({
      status: 200,
      body: await applyApprovedChangeInTransaction(tx, { ...ctx, commandId }, id),
    }),
  });
}
