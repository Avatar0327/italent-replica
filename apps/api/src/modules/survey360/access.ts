/**
 * 活动可见（DEC-280①；AC-360-13）：持“全部活动”按钮者（360 系统管理员）看全部；其余 360 身份只看自己创建的
 * （owner_user_id）与被授权的活动。不可见的活动一律按不存在处理（404），不泄露是否存在。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import { PERSONNEL_OBJECT } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../../routes.js';
import { registerObjectDefinition } from '../permission/catalog.js';
import { scopeSql } from '../permission/module-access.js';
import { type Admin, allActivitiesOf, BUTTONS, can, fail, finePermission, isHolder, OBJECTS, rows } from './context.js';
import { loadPerson, personVisible } from './people.js';
import { employeeScope } from './sync.js';

// 360 对象登记进权限对象目录（身份对象权限配置校验、按钮判定、数据范围按对象所属应用取）
for (const object of Object.values(OBJECTS)) registerObjectDefinition(object);

/** 活动可见谓词（别名 a = survey360_activities）。 */
export function activityVisibleSql(admin: Pick<Admin, 'userId' | 'allActivities'>, alias = sql`a`): SQL {
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

/**
 * 读取当前管理员可见的活动；lock 时行锁（同一活动下的写入串行：数量上限、状态机）。deleted = 删除命令的命令前
 * 校验（含重放）：已删除的活动按删除前的行判定可见，重放返回原回执；新命令在事务内仍按未删除查，已删除即 404。
 */
export async function requireActivity(
  tx: Tx,
  admin: Pick<Admin, 'userId' | 'allActivities'>,
  id: string,
  lock = false,
  deleted = false,
): Promise<ActivityRow> {
  const [row] = rows<ActivityRow>(
    await tx.execute(sql`SELECT a.* FROM survey360_activities a
      WHERE a.id = ${id}::uuid ${deleted ? sql`` : sql`AND NOT a.deleted`} AND ${activityVisibleSql(admin)}
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

/** 评价对象须属于该活动且未移除（removed = 移除命令的命令前校验，含重放，同 requireActivity 的 deleted）。 */
export async function requireObject(tx: Tx, activityId: string, objectId: string, lock = false, removed = false) {
  const [row] = rows<{ id: string; person_id: string; revision: number; activity_id: string }>(
    await tx.execute(sql`SELECT o.id, o.person_id, o.revision, o.activity_id FROM survey360_objects o
      WHERE o.id = ${objectId}::uuid AND o.activity_id = ${activityId}::uuid ${removed ? sql`` : sql`AND NOT o.removed`}
      ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) fail('NOT_FOUND', '评价对象不存在');
  return row;
}

/** 评价对象另须其人员可见（精细化权限，DEC-289①）：看不到与不存在同一结果。 */
export async function requireVisibleObject(
  tx: Tx,
  admin: Admin,
  activityId: string,
  objectId: string,
  lock = false,
  removed = false,
) {
  const object = await requireObject(tx, activityId, objectId, lock, removed);
  if (admin.people && !(await personVisible(tx, admin, await loadPerson(tx, object.person_id))))
    fail('NOT_FOUND', '评价对象不存在');
  return object;
}

type AuditDeps = Pick<TenantRouteDeps, 'db' | 'authorize' | 'clock'>;
type Viewer = { tenantId: string; userId: string; timezone?: string };

/**
 * 审计查看（DEC-216，audit/visibility.ts 登记；第 3 轮 R2-P2-4 按真实对象）：对象查看权与字段裁剪由审计引擎按规则的
 * 对象（Activity / Relation / Answer / Person）判定，这里只给各对象的可见条件，与接口同一判定：
 * - activity：查看人可见的活动编号集合（子查询）；
 * - relation：活动内对象（评价对象、评价关系、确认单、答卷）——同上，且精细化生效时一律不可见（日志带人员信息）；
 * - person：人员——持“全部活动”或精细化权限关闭（开启时不经审计看到范围外人员）；
 * - sync：同步冲突——另须“从系统管理中同步人员信息”按钮与员工信息查看权，并且只给冲突员工在查看人**当前**员工
 *   信息数据范围内的日志（与冲突清单同一 .list 范围、同一谓词，第 4 轮 R3-P2-2）：返回范围内员工编号的子查询。
 * 没有 360 身份返回 null（看不到任何 360 日志），被评价人与评价者因此不能经审计反推评价者身份。
 */
export function survey360AuditScope(kind: 'activity' | 'relation' | 'person' | 'sync') {
  return async (deps: AuditDeps, ctx: Viewer): Promise<SQL | null> =>
    withTenant(deps.db, ctx.tenantId, async (tx) => {
      const tenant = { timezone: 'UTC', ...ctx };
      const allActivities = await allActivitiesOf(tx, deps, tenant);
      const restricted = !allActivities && (await finePermission(tx));
      if (kind === 'person') return restricted ? null : sql`true`;
      if (kind === 'sync') {
        if (restricted || !(await can(tx, deps, tenant, 'person', 'view', BUTTONS.sync))) return null;
        const scope = await employeeScope(tx, deps, tenant, `${PERSONNEL_OBJECT}.list`);
        return scope
          ? sql`SELECT e.id::text FROM employment_employees e WHERE e.tenant_id = ${ctx.tenantId}::uuid
            AND ${scopeSql(scope, { person: sql`e.id` })}`
          : null;
      }
      if (kind === 'relation' && restricted) return null;
      return sql`SELECT a.id::text FROM survey360_activities a WHERE a.tenant_id = ${ctx.tenantId}::uuid
        AND ${activityVisibleSql({ userId: ctx.userId, allActivities })}`;
    });
}

/**
 * 失败命令审计的 360 裁剪（第 1 轮审查 P2-5）：失败记录带请求来源（IP、终端、时间、命令 ID、TraceID），
 * 匿名作答 / 确认链接的失败只给持“全部活动”者（360 系统管理员），360 管理端命令的失败只给 360 身份持有人；
 * 其他查看人（含只持日志审计能力者）看不到，无法据此关联评价者身份。谓词作用于 audit_command_failures 的 path 列。
 */
export async function survey360FailureVisibility(deps: AuditDeps, ctx: Viewer, path: SQL) {
  const { link, manage } = await withTenant(deps.db, ctx.tenantId, async (tx) => ({
    link: await allActivitiesOf(tx, deps, { timezone: 'UTC', ...ctx }),
    manage: await isHolder(tx, ctx.userId),
  }));
  return sql`(CASE WHEN ${path} LIKE '/api/survey360/%' THEN ${link ? sql`true` : sql`false`}
    WHEN ${path} LIKE '/api/tenant/survey360/%' THEN ${manage ? sql`true` : sql`false`} ELSE true END)`;
}
