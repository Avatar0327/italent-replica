/**
 * 系统任务（R1-T08 定时生效等）的操作人标识。审计操作人记为空（tenancy.ts audit_events：“系统任务写入时为空，
 * 记为系统”），不冒用任何真实用户（AGENTS.md §10「审计」不得伪造）；只在必须非空的用户列（如人员子集 created_by）
 * 上以全零 UUID 表示“系统”。它不是任何租户的成员，经不过 tenantContext，进不了租户接口。
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** 审计 actor_user_id：系统任务为空。 */
export function auditActor(userId: string): string | null {
  return userId === SYSTEM_USER_ID ? null : userId;
}
