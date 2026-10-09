/**
 * 继任读侧共用的数据取法（设计 §4.1、§5.8、§8.4）：列表 / 详情 / 读端口 / 审计都用这里的同一口径，不各写一套。
 * 业务日期一律由调用方传入（请求日 / asOf），本文件不取系统时钟。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/** 在职且算现任：不是待入职 1 / 调出 4 / 退休 6 / 离职 8（§4.1）。 */
export const INCUMBENT_EXCLUDED_STATUSES = sql`1, 4, 6, 8`;

/** 嵌套人员展示（DEC-311③，照原站“姓名(邮箱)”；展示字段取证待补，Q02 🟡）。 */
export interface PersonView {
  readonly employeeId: string;
  readonly name: string;
  readonly email: string | null;
  readonly label: string;
}

export const personLabel = (name: string, email: string | null) => (email ? `${name}(${email})` : name);

/**
 * 批量取人员展示：姓名取员工信息最新版本、缺省员工主档；邮箱 工作邮箱 → 个人邮箱 → 登录邮箱
 * （与 survey360/sync.ts 的人员邮箱兜底同口径）。不按查看人范围裁剪（DEC-311③）。
 */
export async function loadPeople(
  tx: Tx,
  tenantId: string,
  employeeIds: readonly string[],
): Promise<ReadonlyMap<string, PersonView>> {
  const ids = [...new Set(employeeIds)];
  if (!ids.length) return new Map();
  const rows = rowsOf<{ id: string; name: string; email: string | null }>(
    await tx.execute(sql`
      SELECT e.id, COALESCE(v.name, e.name) AS name, COALESCE(v.work_email, v.email, acc.email) AS email
      FROM employment_employees e
      LEFT JOIN LATERAL (SELECT pv.name, pv.email, pv.work_email FROM personnel_employee_versions pv
        WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
      LEFT JOIN permission_user_person_links l ON l.tenant_id = e.tenant_id AND l.employee_id = e.id
      LEFT JOIN LATERAL tenant_member_accounts(ARRAY[l.user_id]) acc ON l.user_id IS NOT NULL
      WHERE e.tenant_id = ${tenantId}::uuid AND e.id = ANY(${uuidArray(ids)})`),
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { employeeId: row.id, name: row.name, email: row.email, label: personLabel(row.name, row.email) },
    ]),
  );
}

/**
 * 职位现任（asOf 当日时间轴上的主职任职，人员状态按 §4.1）；兼职来源待 R2-T05，当前为空集（设计 P2）。
 * 同职位按入职先后稳定排序。返回 职位 ID → 员工 ID 列表。
 */
export async function loadIncumbentIds(
  tx: Tx,
  tenantId: string,
  positionIds: readonly string[],
  asOf: string,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const ids = [...new Set(positionIds)];
  const result = new Map<string, string[]>();
  if (!ids.length) return result;
  const rows = rowsOf<{ position_id: string; employee_id: string }>(
    await tx.execute(sql`
      SELECT r.position_id, t.employee_id
      FROM employment_timeline t
      JOIN employment_records r ON r.tenant_id = t.tenant_id AND r.id = t.record_id
      JOIN LATERAL employment_record_status(t.tenant_id, r.id) s ON true
      WHERE t.tenant_id = ${tenantId}::uuid AND t.valid_during @> ${asOf}::date
        AND r.position_id = ANY(${uuidArray(ids)}) AND r.service_type = 'primary'
        AND s.employee_status NOT IN (${INCUMBENT_EXCLUDED_STATUSES})
      ORDER BY r.position_id, t.start_date, t.employee_id`),
  );
  for (const row of rows) result.set(row.position_id, [...(result.get(row.position_id) ?? []), row.employee_id]);
  return result;
}

/** 组织负责人（asOf 当日组织版本的 person_in_charge_id）；当日没有生效版本或未设置 → null。 */
export async function loadPersonInChargeIds(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
  asOf: string,
): Promise<ReadonlyMap<string, string | null>> {
  const ids = [...new Set(orgIds)];
  if (!ids.length) return new Map();
  const rows = rowsOf<{ org_id: string; person_in_charge_id: string | null }>(
    await tx.execute(sql`
      SELECT v.org_id, v.person_in_charge_id FROM (
        SELECT DISTINCT ON (org_id) org_id, person_in_charge_id, stop_date FROM org_versions
        WHERE tenant_id = ${tenantId}::uuid AND org_id = ANY(${uuidArray(ids)}) AND start_date <= ${asOf}::date
        ORDER BY org_id, start_date DESC, version_no DESC) v
      WHERE v.stop_date >= ${asOf}::date`),
  );
  return new Map(rows.map((row) => [row.org_id, row.person_in_charge_id]));
}

/** 记录行里可用的列（别名由调用方给）：SELF 谓词用它们判断“是不是本人的”。 */
export interface RecordTargetColumns {
  readonly type: SQL;
  readonly org: SQL;
  readonly position: SQL;
}

/**
 * SELF 谓词（设计 §8.4 的 `succession_self_target_sql(viewer)`；定义在 0078 迁移的同名 SQL 函数里）：
 * 记录“是本人的” ⇔ 查看人绑定员工在 today（请求当日）是该组织的负责人，或是该职位的现任。
 */
export const selfTargetSql = (
  viewer: { readonly tenantId: string; readonly userId: string },
  columns: RecordTargetColumns,
  today: SQL | string,
): SQL =>
  sql`succession_self_target_sql(${viewer.tenantId}::uuid, ${viewer.userId}::uuid, ${columns.type},
    ${columns.org}::uuid, ${columns.position}::uuid, ${today}::date)`;

const SELF_VISIBLE_KEY = 'succession.self_successors_visible';

/**
 * 租户开关 succession.self_successors_visible 为 false 的 SQL 判断（两层配置：激活的租户覆盖 ?? 系统值，缺省视为可见）。
 * 与 tenant-settings 的 readEffectiveSetting 同一规则，写成子查询以便审计等纯 SQL 出口共用。
 */
export const selfSuccessorsHiddenSql = (tenantId: string): SQL =>
  sql`(COALESCE(
    (SELECT (o.value)::boolean FROM tenant_setting_overrides o
      WHERE o.tenant_id = ${tenantId}::uuid AND o.key = ${SELF_VISIBLE_KEY} AND o.active),
    (SELECT (s.value)::boolean FROM system_settings s WHERE s.key = ${SELF_VISIBLE_KEY}),
    true) = false)`;

/** 该记录对查看人隐藏（开关为 false 且目标是本人的）：列表 / 详情 / 审计共用。 */
export const selfRecordHiddenSql = (
  viewer: { readonly tenantId: string; readonly userId: string },
  columns: RecordTargetColumns,
  today: SQL | string,
): SQL => sql`(${selfSuccessorsHiddenSql(viewer.tenantId)} AND ${selfTargetSql(viewer, columns, today)})`;
