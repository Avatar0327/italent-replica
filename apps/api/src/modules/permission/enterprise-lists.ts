/**
 * 企业设置三张列表（用户 / 用户授权 / 管理员）的共用投影与筛选（F-474-5 #21～23，R1bd §2.8～2.10）。
 * 只读：不新增写入口、不新增权限操作；账号信息只经受限函数 tenant_member_accounts 读取（迁移 0032），
 * 总数与当页用同一过滤口径（同一个 where），分页只在排序稳定的前提下取窗口。
 * 原站有而本系统没有记录的列（登录手机号、来源、创建人等）不伪造，见各列表的 unrecorded。
 */
import { permissionMous, permissionUserAppScopes, sql, type Tx } from '@italent/db';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../errors.js';

export const listPage = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};
/** 文本筛选：去空白、非空、有上限；包含匹配、不区分大小写，% _ \ 按字面处理。 */
export const textFilter = z.string().trim().min(1).max(100);

export function parseQuery<T extends z.ZodType>(schema: T, raw: Record<string, string | undefined>): z.infer<T> {
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
  const parsed = schema.safeParse(present);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '查询参数不合法', parsed.error.issues);
  return parsed.data;
}

export function likePattern(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

/** 姓名或登录邮箱包含 q 的本租户成员（账号表不对业务角色直接开放，只能走受限函数）。 */
export function accountMatch(userId: SQL | SQL.Aliased | object, q: string): SQL {
  const pattern = likePattern(q);
  return sql`${userId} IN (SELECT a.account_id
    FROM tenant_member_accounts(ARRAY(SELECT m.user_id FROM tenant_memberships m)) a
    WHERE lower(a.display_name) LIKE ${pattern} OR lower(coalesce(a.email, '')) LIKE ${pattern})`;
}

/** 用户按（用户 × 应用）已分配的管理单元；撤销身份不影响这里（DEC-043）。 */
export interface UserMou {
  readonly appCode: string;
  readonly mouId: string;
  readonly name: string;
}

export async function mousOfUsers(tx: Tx, userIds: readonly string[]): Promise<Map<string, UserMou[]>> {
  const result = new Map<string, UserMou[]>();
  if (userIds.length === 0) return result;
  const rows = await tx
    .select({
      userId: permissionUserAppScopes.userId,
      appCode: permissionUserAppScopes.appCode,
      mouId: permissionMous.id,
      name: permissionMous.name,
    })
    .from(permissionUserAppScopes)
    .innerJoin(
      permissionMous,
      and(
        eq(permissionMous.tenantId, permissionUserAppScopes.tenantId),
        eq(permissionMous.id, permissionUserAppScopes.mouId),
      ),
    )
    .where(and(eq(permissionUserAppScopes.kind, 'mou'), inArray(permissionUserAppScopes.userId, [...userIds])));
  for (const row of rows.sort((a, b) => a.appCode.localeCompare(b.appCode))) {
    const list = result.get(row.userId) ?? [];
    list.push({ appCode: row.appCode, mouId: row.mouId, name: row.name });
    result.set(row.userId, list);
  }
  return result;
}

/** 有指定管理单元分配的用户（任一应用）。 */
export function hasMou(userId: SQL | object, mouId: string): SQL {
  return sql`${userId} IN (SELECT s.user_id FROM permission_user_app_scopes s
    WHERE s.kind = 'mou' AND s.mou_id = ${mouId}::uuid)`;
}
