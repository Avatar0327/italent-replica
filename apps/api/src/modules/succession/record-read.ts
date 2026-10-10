/**
 * 继任记录读取（设计 §2.2 #2、§5.1、§5.8、§8.2）：列表与详情共用同一个可见性谓词——未删除、asOf 当日已开始、
 * 数据范围（锚点 = 目标组织，职位继任 = 职位所属组织）、SELF 过滤——所以范围外与不存在同一个 404，分页前就已裁剪。
 * 记录在 d 生效 ⇔ start_date ≤ d < end_date；生效状态由 end_date 派生（end_date = 9999-12-31 为长期有效）。
 */
import { sql, SUCCESSION_OPEN_END, type SuccessionType, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { ModuleScope } from '../permission/module-access.js';
import { scopeSql } from '../permission/module-access.js';
import { rowsOf, selfRecordHiddenSql } from './read-sql.js';

export type RecordStatusFilter = 'active' | 'ended' | 'all';
export const RECORD_STATUS_FILTERS: readonly RecordStatusFilter[] = ['active', 'ended', 'all'];

export interface RecordVisibility {
  readonly tenantId: string;
  readonly userId: string;
  /** 请求当日（租户时区）：SELF 谓词一律用请求当日解析，历史 asOf 不改变权限口径（§5.8）。 */
  readonly today: string;
  readonly asOf: string;
  readonly scope: ModuleScope;
}

export interface RecordFilter {
  readonly status: RecordStatusFilter;
  readonly successionType?: SuccessionType;
  readonly targetOrgId?: string;
  readonly targetPositionId?: string;
  readonly successorEmployeeId?: string;
  readonly id?: string;
  /** 写命令返回前复核用：按一组 ID 取（批量结束的回执）。 */
  readonly ids?: readonly string[];
  /** 删除回执的复核：已软删除的行也要按它的目标判范围（读入口永远不设）。 */
  readonly includeDeleted?: boolean;
}

export interface RecordRow {
  readonly id: string;
  readonly revision: number;
  readonly successionType: SuccessionType;
  readonly targetOrgId: string | null;
  readonly targetPositionId: string | null;
  readonly successorEmployeeId: string;
  readonly readinessId: string | null;
  readonly backupType: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly endReason: string | null;
  readonly endSource: string | null;
  readonly sourceKind: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: 'active' | 'ended';
  readonly targetOrgName: string | null;
  readonly targetPositionName: string | null;
  readonly positionOrgId: string | null;
  readonly readinessCode: string | null;
  readonly readinessName: string | null;
  readonly readinessColor: string | null;
}

function statusPredicate(status: RecordStatusFilter, asOf: string): SQL {
  if (status === 'active') return sql`r.end_date > ${asOf}::date`;
  if (status === 'ended') return sql`r.end_date <= ${asOf}::date`;
  return sql`true`;
}

function conditions(visibility: RecordVisibility, filter: RecordFilter): SQL {
  const { tenantId, userId, today, asOf, scope } = visibility;
  const parts: SQL[] = [
    sql`r.tenant_id = ${tenantId}::uuid`,
    filter.includeDeleted ? sql`true` : sql`r.deleted_at IS NULL`,
    sql`r.start_date <= ${asOf}::date`,
    statusPredicate(filter.status, asOf),
    // 范围锚点 = 目标组织；职位继任 = 职位**今天**所属的组织（DEC-368①：资源归属只按今天的管理范围判断，
    // asOf 查历史也一样，不用 asOf 当日的历史组织）；“使用用户”规则按记录创建人
    scopeSql(scope, { org: sql`COALESCE(r.target_org_id, pa.org_id)`, creator: sql`r.created_by` }),
    sql`NOT ${selfRecordHiddenSql(
      { tenantId, userId },
      { type: sql`r.succession_type`, org: sql`r.target_org_id`, position: sql`r.target_position_id` },
      today,
    )}`,
  ];
  if (filter.id) parts.push(sql`r.id = ${filter.id}::uuid`);
  if (filter.ids) parts.push(sql`r.id = ANY(${`{${filter.ids.join(',')}}`}::uuid[])`);
  if (filter.successionType) parts.push(sql`r.succession_type = ${filter.successionType}`);
  if (filter.targetOrgId) parts.push(sql`r.target_org_id = ${filter.targetOrgId}::uuid`);
  if (filter.targetPositionId) parts.push(sql`r.target_position_id = ${filter.targetPositionId}::uuid`);
  if (filter.successorEmployeeId) parts.push(sql`r.successor_employee_id = ${filter.successorEmployeeId}::uuid`);
  return sql.join(parts, sql` AND `);
}

/**
 * 时点版本：asOf 当日已开始的最新版本，且 stop_date ≥ asOf（同 org / job 读模型），用于展示；pa 是请求当日的职位版本，
 * 只用于范围锚点（DEC-368①）。
 */
const from = (asOf: string, today: string) => sql`FROM succession_records r
  LEFT JOIN LATERAL (
    SELECT v.name, v.stop_date FROM org_versions v
    WHERE v.tenant_id = r.tenant_id AND v.org_id = r.target_org_id AND v.start_date <= ${asOf}::date
    ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
  ) ov ON ov.stop_date >= ${asOf}::date
  LEFT JOIN LATERAL (
    SELECT v.name, v.org_id, v.stop_date FROM job_position_versions v
    WHERE v.tenant_id = r.tenant_id AND v.object_id = r.target_position_id AND v.start_date <= ${asOf}::date
    ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
  ) pv ON pv.stop_date >= ${asOf}::date
  LEFT JOIN LATERAL (
    SELECT v.org_id, v.stop_date FROM job_position_versions v
    WHERE v.tenant_id = r.tenant_id AND v.object_id = r.target_position_id AND v.start_date <= ${today}::date
    ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
  ) pa ON pa.stop_date >= ${today}::date
  LEFT JOIN talent_readiness_levels rl ON rl.tenant_id = r.tenant_id AND rl.id = r.readiness_id`;

export async function listRecordRows(
  tx: Tx,
  visibility: RecordVisibility,
  filter: RecordFilter,
  page: { readonly limit: number; readonly offset: number },
): Promise<{ readonly rows: readonly RecordRow[]; readonly total: number }> {
  const where = conditions(visibility, filter);
  const source = from(visibility.asOf, visibility.today);
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*)::int AS total ${source} WHERE ${where}`),
  );
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT ${selectColumns(visibility.asOf)} ${source} WHERE ${where}
      ORDER BY r.start_date DESC, r.created_at DESC, r.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

export async function loadRecordRow(
  tx: Tx,
  visibility: RecordVisibility,
  filter: RecordFilter,
): Promise<RecordRow | undefined> {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT ${selectColumns(visibility.asOf)} ${from(visibility.asOf, visibility.today)}
      WHERE ${conditions(visibility, filter)} LIMIT 1`),
  );
  return rows[0] ? toRow(rows[0]) : undefined;
}

function selectColumns(asOf: string): SQL {
  return sql`r.id, r.revision, r.succession_type, r.target_org_id, r.target_position_id, r.successor_employee_id,
    r.readiness_id, r.backup_type, r.start_date::text AS start_date, r.end_date::text AS end_date, r.end_reason,
    r.end_source, r.source_kind, r.created_by, r.created_at, r.updated_at,
    (CASE WHEN r.end_date <= ${asOf}::date THEN 'ended' ELSE 'active' END) AS status,
    ov.name AS target_org_name, pv.name AS target_position_name, pv.org_id AS position_org_id,
    rl.code AS readiness_code, rl.name AS readiness_name, rl.color AS readiness_color`;
}

function toRow(row: Record<string, unknown>): RecordRow {
  const text = (key: string) => (row[key] as string | null) ?? null;
  return {
    id: row.id as string,
    revision: Number(row.revision),
    successionType: row.succession_type as SuccessionType,
    targetOrgId: text('target_org_id'),
    targetPositionId: text('target_position_id'),
    successorEmployeeId: row.successor_employee_id as string,
    readinessId: text('readiness_id'),
    backupType: row.backup_type as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    endReason: text('end_reason'),
    endSource: text('end_source'),
    sourceKind: row.source_kind as string,
    createdBy: row.created_by as string,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    status: row.status as 'active' | 'ended',
    targetOrgName: text('target_org_name'),
    targetPositionName: text('target_position_name'),
    positionOrgId: text('position_org_id'),
    readinessCode: text('readiness_code'),
    readinessName: text('readiness_name'),
    readinessColor: text('readiness_color'),
  };
}

const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

export const isOpenEnded = (endDate: string) => endDate === SUCCESSION_OPEN_END;
