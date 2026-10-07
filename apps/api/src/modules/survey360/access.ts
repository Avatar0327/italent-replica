/**
 * 活动可见（DEC-280①；AC-360-13）：持“全部活动”按钮者（360 系统管理员）看全部；其余 360 身份只看自己创建的
 * （owner_user_id）与被授权的活动。不可见的活动一律按不存在处理（404），不泄露是否存在。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../../routes.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { type Admin, can, fail, isHolder, loadAdmin, OBJECTS, rows } from './context.js';

// 360 对象登记进权限对象目录（身份对象权限配置校验、按钮判定、数据范围按对象所属应用取）
for (const object of Object.values(OBJECTS)) registerObjectDefinition(object);

/** 活动可见谓词（别名 a = survey360_activities）。 */
export function activityVisibleSql(admin: Admin, alias = sql`a`): SQL {
  if (admin.allActivities) return sql`true`;
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
  readonly ended_at: Date | string | null;
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
    endedAt: iso(row.ended_at),
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

type AuditDeps = Pick<TenantRouteDeps, 'db' | 'authorize'>;
type Viewer = { tenantId: string; userId: string; timezone?: string };

/** “精细化权限”开关（DEC-280⑤）；未设置即关闭。 */
export async function finePermission(tx: Tx): Promise<boolean> {
  const [row] = rows<{ fine_permission: boolean }>(
    await tx.execute(sql`SELECT fine_permission FROM survey360_settings LIMIT 1`),
  );
  return row?.fine_permission === true;
}

/**
 * 审计查看（DEC-216，audit/visibility.ts 登记）：360 日志按查看人当前的 360 身份裁剪，与接口同一判定。
 * - activity：活动内对象（活动、评价对象、评价关系、确认单、答卷）——查看人可见的活动编号集合（子查询）；
 * - person：人员、同步冲突——有人员查看权，且持“全部活动”或精细化权限关闭（开启时不经审计看到范围外人员）；
 * - settings：评价角色、设置——任一 360 身份持有人；
 * - questionnaire：套卷——有套卷查看权。
 * 没有 360 身份返回 null（看不到任何 360 日志），被评价人与评价者因此不能经审计反推评价者身份。
 */
export function survey360AuditScope(kind: 'activity' | 'person' | 'settings' | 'questionnaire') {
  return async (deps: AuditDeps, ctx: Viewer): Promise<SQL | null> =>
    withTenant(deps.db, ctx.tenantId, async (tx) => {
      const tenant = { timezone: 'UTC', ...ctx };
      if (kind === 'settings') return (await isHolder(tx, ctx.userId)) ? sql`true` : null;
      if (kind === 'questionnaire') return (await can(tx, deps, tenant, 'questionnaire')) ? sql`true` : null;
      const admin = await loadAdmin(tx, deps, tenant);
      if (kind === 'person') {
        if (!(await can(tx, deps, tenant, 'person'))) return null;
        return admin.allActivities || !(await finePermission(tx)) ? sql`true` : null;
      }
      if (!(await can(tx, deps, tenant, 'activity'))) return null;
      return sql`SELECT a.id::text FROM survey360_activities a WHERE a.tenant_id = ${ctx.tenantId}::uuid
        AND ${activityVisibleSql(admin)}`;
    });
}

/**
 * 失败命令审计的 360 裁剪（第 1 轮审查 P2-5）：失败记录带请求来源（IP、终端、时间、命令 ID、TraceID），
 * 匿名作答 / 确认链接的失败只给持“全部活动”者（360 系统管理员），360 管理端命令的失败只给 360 身份持有人；
 * 其他查看人（含只持日志审计能力者）看不到，无法据此关联评价者身份。谓词作用于 audit_command_failures 的 path 列。
 */
export async function survey360FailureVisibility(deps: AuditDeps, ctx: Viewer, path: SQL) {
  const { link, manage } = await withTenant(deps.db, ctx.tenantId, async (tx) => ({
    link: (await loadAdmin(tx, deps, { timezone: 'UTC', ...ctx })).allActivities,
    manage: await isHolder(tx, ctx.userId),
  }));
  return sql`(CASE WHEN ${path} LIKE '/api/survey360/%' THEN ${link ? sql`true` : sql`false`}
    WHEN ${path} LIKE '/api/tenant/survey360/%' THEN ${manage ? sql`true` : sql`false`} ELSE true END)`;
}
