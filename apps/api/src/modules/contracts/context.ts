import { auditEvents, contractOutbox, sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, tenantLocalDate } from '@italent/domain';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import type { ApprovalContext } from '../approval/context.js';
import { rowsOf } from '../approval/context.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import { type ModuleScope } from '../permission/module-access.js';
import { isEmploymentRecordVisible } from '../employment/visibility.js';
import { personnelCreationScope } from '../permission/scope-resolver.js';
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
/** 合同关联只取主职，复用任职读取端口的有效时间线及更正快照。 */
export async function currentPrimary(tx: Tx, tenantId: string, employeeId: string, asOf: string) {
  const [current] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT r.id FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId}::uuid
      AND r.service_type='primary' AND t.valid_during @> ${asOf}::date LIMIT 1`),
  );
  return current ? loadEmploymentRecord(tx, tenantId, current.id, asOf) : null;
}
export async function checkScope(tx: Tx, ctx: ContractContext, employeeId: string, creatorId?: string) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  let scope = ctx.scope;
  // DEC-180④：没有已存在记录的创建人时，按已有人员新建范围端口解析。
  if (scope && !creatorId)
    scope = await personnelCreationScope(
      tx,
      { ...ctx, appCode: 'TenantBase', objectCode: CONTRACT_OBJECT, asOf: today },
      scope,
    );
  if (!(await isEmploymentRecordVisible(tx, ctx.tenantId, scope, { employeeId, departmentId: null, creatorId }))) {
    throw new AppError('NOT_FOUND', '合同数据不存在');
  }
  return currentPrimary(tx, ctx.tenantId, employeeId, today);
}
/** DEC-202：续签生成新记录，走人员新建范围；维护操作只能使用目标合同的真实创建人。 */
export async function checkOperationScope(
  tx: Tx,
  ctx: ContractContext,
  input: { employeeId: string; operation: string },
  target: { employeeId: string; createdBy: string } | null | undefined,
) {
  if (target && target.employeeId !== input.employeeId) throw new AppError('NOT_FOUND', '合同数据不存在');
  return checkScope(
    tx,
    ctx,
    input.employeeId,
    input.operation === 'create' || input.operation === 'renew' ? undefined : target?.createdBy,
  );
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
