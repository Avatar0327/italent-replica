/** §6.2：项目管理 ∪ 行政向下公开 ∪ 共享组织；写入与重放共用可编辑判定。 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { scopeAllows, scopeSql } from '../permission/module-access.js';
import { publicDownSql, type PublicDownContext } from '../permission/public-down.js';
import { notFoundMessage, type ModuleScope } from './access.js';

export interface ProjectAnchor {
  readonly id: string;
  readonly ownerOrgId: string;
  readonly ownerId: string;
  readonly downwardPublic: boolean;
}
/** 共享组织只匹配范围展开后的管理 / 组织维度，人员及创建人范围不能推导组织。 */
function sharedSql(ctx: PublicDownContext, scope: ModuleScope, projectId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM talent_review_project_shared_orgs s
    WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.project_id = ${projectId}
      AND ${scopeSql(scope, { org: sql`s.org_id` })})`;
}
export function projectReadable(ctx: PublicDownContext, scope: ModuleScope): SQL {
  return sql`(${scopeSql(scope, { org: sql`owner_org_id`, creator: sql`owner_id` })}
    OR (downward_public AND ${publicDownSql(ctx, scope, sql`owner_org_id`)})
    OR ${sharedSql(ctx, scope, sql`id`)})`;
}
export function projectListAccess(scope: ModuleScope, row: ProjectAnchor): 'manage' | 'readonly' {
  return scopeAllows(scope, { orgId: row.ownerOrgId, creatorId: row.ownerId }) ? 'manage' : 'readonly';
}
export async function requireProjectReadable(tx: Tx, ctx: PublicDownContext, scope: ModuleScope, row: ProjectAnchor) {
  if (projectListAccess(scope, row) === 'manage') return 'manage' as const;
  const result = await tx.execute(sql`SELECT (
    (${row.downwardPublic} AND ${publicDownSql(ctx, scope, sql`${row.ownerOrgId}::uuid`)})
    OR ${sharedSql(ctx, scope, sql`${row.id}::uuid`)}) AS visible`);
  const rows = (Array.isArray(result) ? result : (result as { rows: { visible: boolean }[] }).rows) as {
    visible: boolean;
  }[];
  if (!rows[0]?.visible) throw new AppError('NOT_FOUND', notFoundMessage('project'));
  return 'readonly' as const;
}
/** 所有项目写操作（包括 PR-C / D 的 calculate / sync）复用此入口，状态或 revision 校验之前拒绝只读。 */
export async function requireProjectEditable(tx: Tx, ctx: PublicDownContext, scope: ModuleScope, row: ProjectAnchor) {
  if ((await requireProjectReadable(tx, ctx, scope, row)) === 'readonly') {
    throw new AppError('FORBIDDEN', '盘点项目只能查看，不能修改', { reason: 'PROJECT_READONLY' });
  }
}
