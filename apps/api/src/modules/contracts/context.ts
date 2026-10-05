import { auditEvents, contractOutbox, sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import type { ApprovalContext } from '../approval/context.js';
import { rowsOf } from '../approval/context.js';
import { findCurrentRecord } from '../employment/read-model.js';
import { scopeAllowsInTransaction, type ModuleScope } from '../permission/module-access.js';
import { requireObjectWrite } from '../permission/object-write.js';
export { rowsOf };
export interface ContractContext extends ApprovalContext {
  readonly scope?: ModuleScope;
  readonly authorize?: Authorizer;
}
export function revision(expected: number, actual: number) {
  if (expected !== actual)
    throw new AppError('REVISION_CONFLICT', '合同数据已变更，请刷新后显式重提', { expected, actual });
}
export async function lockEmployee(tx: Tx, ctx: ContractContext, id: string) {
  const [employee] = rowsOf(
    await tx.execute(sql`SELECT id FROM employment_employees
    WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid FOR UPDATE`),
  );
  if (!employee) throw new AppError('NOT_FOUND', '员工不存在');
}
export async function checkScope(tx: Tx, ctx: ContractContext, employeeId: string, creatorId = ctx.userId) {
  const current = await findCurrentRecord(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  const orgId = current?.fields.departmentId ?? null;
  if (ctx.scope && !(await scopeAllowsInTransaction(tx, ctx.scope, { personId: employeeId, orgId, creatorId }))) {
    throw new AppError('NOT_FOUND', '合同数据不存在');
  }
  return current;
}
export async function checkFields(
  ctx: ContractContext,
  operation: 'create' | 'update',
  fields: Record<string, unknown>,
) {
  if (!ctx.authorize) return;
  const { customFields, ...standard } = fields;
  await requireObjectWrite(ctx.authorize, ctx, {
    objectCode: CONTRACT_OBJECT,
    operation,
    payload: {
      ...standard,
      ...Object.fromEntries(Object.entries((customFields ?? {}) as object).map(([k, v]) => [`custom:${k}`, v])),
    },
  });
}
export async function audit(tx: Tx, ctx: ContractContext, action: string, id: string, before: unknown, after: unknown) {
  await tx.insert(auditEvents).values({
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action,
    objectType: CONTRACT_OBJECT,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.insert(contractOutbox).values({
    tenantId: ctx.tenantId,
    objectId: id,
    eventType: action,
    commandId: ctx.commandId,
    payload: { before, after },
    createdAt: ctx.now,
  });
}
