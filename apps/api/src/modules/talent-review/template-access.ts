/**
 * 盘点模板的数据范围（设计 §6.2；DEC-043 / 082）：模板有所属组织（owner_org_id），按（用户 × TalentReview）的组织范围 ∪ 创建人
 * 判定；可「向下公开」——查看人范围内有其下级组织时可查看与选用（B7 项目选模板同谓词），不能修改（403 TEMPLATE_PUBLIC_DOWN_READONLY）。
 * 范围外与不存在同一个 404；新建 / 改所属组织要求目标组织在范围内（不因创建人或向下公开放行）。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { publicDownSql, readableSql, type PublicDownContext } from '../permission/public-down.js';
import { scopeAllows } from '../permission/module-access.js';
import { visible } from '../permission/module-route-access.js';
import { notFoundMessage, type ModuleScope } from './access.js';

/** 范围锚点：所属组织、是否向下公开、创建人。 */
export interface TemplateAnchor {
  readonly ownerOrgId: string;
  readonly downwardPublic: boolean;
  readonly createdBy: string | null;
}
export type TemplateAccess = 'manage' | 'readonly' | 'none';

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

/** 范围内（所属组织在范围内或命中创建人）可管理；仅因向下公开可见的只读。 */
export async function accessOf(
  tx: Tx,
  ctx: PublicDownContext,
  scope: ModuleScope,
  anchor: TemplateAnchor,
): Promise<TemplateAccess> {
  if (scopeAllows(scope, { orgId: anchor.ownerOrgId, creatorId: anchor.createdBy })) return 'manage';
  if (!anchor.downwardPublic) return 'none';
  const result = await tx.execute(sql`SELECT ${publicDownSql(ctx, scope, sql`${anchor.ownerOrgId}::uuid`)} AS visible`);
  return rowsOf<{ visible: boolean }>(result)[0]?.visible === true ? 'readonly' : 'none';
}

/** 读取：不可见与不存在同为 404。 */
export async function requireReadable(tx: Tx, ctx: PublicDownContext, scope: ModuleScope, anchor: TemplateAnchor) {
  const access = await accessOf(tx, ctx, scope, anchor);
  if (access === 'none') throw new AppError('NOT_FOUND', notFoundMessage('template'));
  return access;
}

/** 写入：不可见 404；仅因向下公开可见 403。 */
export async function requireEditable(tx: Tx, ctx: PublicDownContext, scope: ModuleScope, anchor: TemplateAnchor) {
  if ((await requireReadable(tx, ctx, scope, anchor)) === 'readonly') {
    throw new AppError('FORBIDDEN', '盘点模板由上级组织向下公开，只能查看与选用', {
      reason: 'TEMPLATE_PUBLIC_DOWN_READONLY',
    });
  }
}

/** 新建 / 改所属组织：目标组织须在范围内（DEC-082）；范围外按不存在 404。 */
export function requireCreatable(scope: ModuleScope, ownerOrgId: string): void {
  visible(scope, ownerOrgId, notFoundMessage('template'));
}

/** 列表的 SQL 侧读取谓词（分页之前生效；B7 项目选用模板复用）：范围内 ∪ 创建人 ∪ 向下公开。 */
export const templateReadable = (ctx: PublicDownContext, scope: ModuleScope): SQL =>
  readableSql(ctx, scope, {
    org: sql`owner_org_id`,
    publicDown: sql`downward_public`,
    creator: sql`created_by`,
  });

/** 列表里的访问级别（谓词已保证可读）：命中范围 / 创建人为可管理，其余是向下公开的只读。 */
export const listAccess = (scope: ModuleScope, anchor: TemplateAnchor): 'manage' | 'readonly' =>
  scopeAllows(scope, { orgId: anchor.ownerOrgId, creatorId: anchor.createdBy }) ? 'manage' : 'readonly';
