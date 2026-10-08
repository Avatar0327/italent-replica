/**
 * IDP 配置写入的公共部分：每个写入在命令台账的同一租户事务里完成“业务写 + 审计”（DEC-019 / 216），审计行带所属
 * 组织作归属（审计查询按查看人当前的 IDP 范围裁剪）。
 * 取锁顺序：模板 → 流程 → 子流程 → 审批流程。模板写入对引用的流程加 FOR SHARE、写节点配置对子流程行加 FOR SHARE；
 * 流程修改先锁流程行、再锁子流程行（FOR UPDATE），之后才判断“是否被模板引用 / 是否已有节点配置”，因此 IDP-R5 与
 * K-28 在并发下同样成立（AC-IDP-concurrency-pg）；外键 RESTRICT 兜底。
 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import type { IdpApprovalType, IdpObject } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { codeOf, IDP_AUDIT_ACTIONS, type IdpContext, type ModuleScope, rowsOf } from './access.js';

export interface WriteContext extends IdpContext {
  readonly scope: ModuleScope;
}

export async function audit(
  tx: Tx,
  ctx: IdpContext,
  object: IdpObject,
  operation: 'create' | 'update' | 'delete',
  id: string,
  change: { before: unknown; after: unknown; orgId: string },
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${IDP_AUDIT_ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before: change.before,
    after: change.after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    // DEC-197 归属：审计查询按查看人当前的组织范围裁剪，删除后仍可判断
    scope: { orgId: change.orgId },
  });
}

export const created = (ctx: IdpContext) => ({ createdBy: ctx.userId, createdAt: ctx.now });
export const bumped = (ctx: IdpContext) => ({ revision: ctx.expectedRevision + 1, updatedAt: ctx.now });

export function conflict(reason: string, message: string): never {
  throw new AppError('CONFLICT', message, { reason });
}

export function invalid(message: string, details?: unknown): never {
  throw new AppError('VALIDATION_FAILED', message, details);
}

export function requireRevision(ctx: IdpContext, actual: number, label: string): void {
  if (actual !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', `${label}已变更，请刷新后显式重提`, {
      expected: ctx.expectedRevision,
      actual,
    });
  }
}

/** 所属组织须存在（组织不做物理删除，停用只是新版本；外键兜底）。 */
export async function requireOrg(tx: Tx, tenantId: string, orgId: string): Promise<void> {
  const result = await tx.execute(
    sql`SELECT id FROM org_objects WHERE tenant_id = ${tenantId} AND id = ${orgId}::uuid`,
  );
  if (!rowsOf(result).length) throw new AppError('NOT_FOUND', '所属组织不存在');
}

/**
 * 子流程引用的审批流程（IDP-R1，口径 K-08）：须存在（否则 404）、未废弃且有已发布版本、审批类型与子流程一致（409）。
 * 共享锁与审批流程的废弃串行。返回当前已发布版本 ID。
 */
export async function requireApprovalProcess(
  tx: Tx,
  tenantId: string,
  approvalProcessId: string,
  approvalType: IdpApprovalType,
): Promise<string> {
  const [row] = rowsOf<{ approval_type: string; status: string; current_version_id: string | null }>(
    await tx.execute(sql`SELECT approval_type, status, current_version_id FROM approval_processes
      WHERE tenant_id = ${tenantId} AND id = ${approvalProcessId}::uuid FOR SHARE`),
  );
  if (!row) throw new AppError('NOT_FOUND', '审批流程不存在');
  if (row.status !== 'active' || !row.current_version_id) {
    conflict('IDP_APPROVAL_PROCESS_UNAVAILABLE', '只能引用已发布且未废弃的审批流程');
  }
  if (row.approval_type !== approvalType) {
    conflict('IDP_APPROVAL_TYPE_MISMATCH', '审批流程的审批类型与子流程关联的审批流程不一致');
  }
  return row.current_version_id;
}

/** 唯一约束冲突转成业务冲突（模板名称等）。 */
export async function unique<T>(write: () => Promise<T>, reason: string, message: string): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') conflict(reason, message);
    throw error;
  }
}
