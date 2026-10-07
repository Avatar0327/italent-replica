/**
 * 活动授权（DEC-027；AC-360-13）：系统 / 高级管理员可见全部活动；一般管理员只见自己持有（创建或被转移）
 * 或被授权的活动。不可见的活动一律按不存在处理（404），不泄露是否存在。
 * TODO(需取证 #104)：原站三类 360 管理员的能力边界只有规格 §4 一句话，此处按“系统管全部、高级管全部活动、
 * 一般管自己的与被授权的”实现，集中在本文件便于取证后替换。
 */
import { type Db, sql, type Tx, withTenant } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { type Admin, fail, loadAdmin, rows } from './context.js';

/** 活动可见谓词（别名 a = survey360_activities）。 */
export function activityVisibleSql(admin: Pick<Admin, 'role' | 'userId'>, alias = sql`a`): SQL {
  if (admin.role !== 'general') return sql`true`;
  return sql`(${alias}.owner_user_id = ${admin.userId}::uuid OR EXISTS (SELECT 1 FROM survey360_activity_grants g
    WHERE g.tenant_id = ${alias}.tenant_id AND g.activity_id = ${alias}.id AND g.user_id = ${admin.userId}::uuid))`;
}

export interface ActivityRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly scene: string | null;
  readonly status: 'draft' | 'enabled' | 'disabled';
  readonly form: 'single' | 'multiple';
  readonly welcome: string | null;
  readonly show_appraiser_name: boolean;
  readonly role_display: 'name' | 'fixed_text' | 'hidden';
  readonly owner_user_id: string;
  readonly started_at: Date | string | null;
  readonly score_batch_id: string | null;
  readonly scored_at: Date | string | null;
  readonly revision: number;
  readonly created_by: string;
}

/** 读取当前管理员可见的活动；lock 时行锁（同一活动下的写入串行：数量上限、状态机）。 */
export async function requireActivity(tx: Tx, admin: Admin, id: string, lock = false): Promise<ActivityRow> {
  const [row] = rows<ActivityRow>(
    await tx.execute(sql`SELECT a.* FROM survey360_activities a
      WHERE a.id = ${id}::uuid AND NOT a.deleted AND ${activityVisibleSql(admin)}
      ${lock ? sql`FOR UPDATE OF a` : sql``}`),
  );
  if (!row) fail('NOT_FOUND', '活动不存在');
  return row;
}

export function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function activityView(row: ActivityRow) {
  return {
    id: row.id,
    name: row.name,
    scene: row.scene,
    status: row.status,
    form: row.form,
    welcome: row.welcome,
    showAppraiserName: row.show_appraiser_name,
    roleDisplay: row.role_display,
    ownerUserId: row.owner_user_id,
    startedAt: iso(row.started_at),
    scoredAt: iso(row.scored_at),
    revision: row.revision,
  };
}

/** 评价对象须属于该活动且未移除。 */
export async function requireObject(tx: Tx, activityId: string, objectId: string, lock = false) {
  const [row] = rows<{ id: string; person_id: string; revision: number; activity_id: string }>(
    await tx.execute(sql`SELECT o.id, o.person_id, o.revision, o.activity_id FROM survey360_objects o
      WHERE o.id = ${objectId}::uuid AND o.activity_id = ${activityId}::uuid AND NOT o.removed
      ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) fail('NOT_FOUND', '评价对象不存在');
  return row;
}

/**
 * 审计查看（DEC-216，audit/visibility.ts 登记）：360 日志按查看人当前的 360 身份裁剪，不走组织员工的对象权限。
 * - activity：活动内对象（活动、评价对象、评价关系、确认单、答卷）——查看人可见的活动编号集合（子查询）；
 * - system：人员、管理员、角色、同步冲突——只有 360 系统管理员；
 * - any：套卷——任一 360 管理员。
 * 不是 360 管理员返回 null（看不到任何 360 日志），被评价人与评价者因此不能经审计反推评价者身份。
 */
export function survey360AuditScope(kind: 'activity' | 'system' | 'any') {
  return async (deps: { db: Db }, ctx: { tenantId: string; userId: string }): Promise<SQL | null> => {
    const admin = await withTenant(deps.db, ctx.tenantId, (tx) => loadAdmin(tx, ctx.userId));
    if (!admin) return null;
    if (kind === 'any') return sql`true`;
    if (kind === 'system') return admin.role === 'system' ? sql`true` : null;
    return sql`SELECT a.id::text FROM survey360_activities a WHERE a.tenant_id = ${ctx.tenantId}::uuid
      AND ${activityVisibleSql(admin)}`;
  };
}
