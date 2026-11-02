/**
 * 职责转交记录查询（R2-T09a；规格 `30` §补充“职责转交记录结构”“菜单界面”）：全部 / 待生效 / 已完成三页签，
 * 筛选被转交人、转交状态、数据来源。全部 = 菜单记录 + 离职 / 调动 / 退休内的转交子项（transfer_linkage_items）只读联合，
 * 不迁移旧数据；子项状态折算：pending / failed → 未完成（失败带原因）、succeeded → 已完成，superseded（被新计划替换）不列。
 * DT-R9：只列操作人数据范围内被转交人的记录（visible 谓词作用于被转交人列）。
 */
import { sql, type Tx } from '@italent/db';
import { dutyDescription, DUTY_TRANSFER_STATUS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { rowsOf } from '../employment/read-model.js';
import type { DutyRecordRow } from './duties.js';

export interface DutyRecordView {
  readonly id: string;
  readonly employeeId: string;
  readonly receiverId: string | null;
  readonly dutyType: number;
  readonly dutyDetails: string;
  readonly status: number;
  readonly transferDate: string | null;
  readonly transferTime: string | null;
  readonly batchId: string | null;
  readonly source: number;
  readonly operatorId: string | null;
  readonly failure: { readonly code: string; readonly message: string; readonly rule: string | null } | null;
}

const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);

export function recordView(row: DutyRecordRow): DutyRecordView {
  return {
    id: row.id,
    employeeId: row.employeeId,
    receiverId: row.receiverId,
    dutyType: row.dutyType,
    dutyDetails: row.dutyDetails,
    status: row.status,
    transferDate: row.transferDate,
    transferTime: iso(row.transferAt),
    batchId: row.batchId,
    source: row.source,
    operatorId: row.operatorId,
    failure: row.failureCode
      ? { code: row.failureCode, message: row.failureMessage ?? '', rule: row.failureRule }
      : null,
  };
}

export type RecordTab = 'all' | 'pending' | 'completed';

export interface RecordFilter {
  readonly tab: RecordTab;
  readonly employeeId?: string;
  readonly status?: number;
  readonly source?: number;
  readonly limit: number;
  readonly offset: number;
}

interface UnionRow {
  readonly id: string;
  readonly employeeId: string;
  readonly receiverId: string | null;
  readonly dutyType: number;
  readonly dutyDetails: string | null;
  readonly status: number;
  readonly transferDate: string | null;
  readonly transferTime: string | null;
  readonly batchId: string | null;
  readonly source: number;
  readonly operatorId: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly failureRule: string | null;
  readonly orgRole: string | null;
  readonly relation: string | null;
  readonly targetName: string | null;
}

/** 联动子项的职责描述在读时按同一口径拼（组织名取当前有效版本，下属名取当前姓名）。 */
function linkageSql(tenantId: string, today: string): SQL {
  return sql`
    SELECT i.id::text AS id, i.employee_id::text AS "employeeId", i.receiver_id::text AS "receiverId",
      CASE i.item_type WHEN 'duty_org_role' THEN 1 ELSE 2 END AS "dutyType", NULL::text AS "dutyDetails",
      (CASE i.status WHEN 'succeeded' THEN ${DUTY_TRANSFER_STATUS.completed}::int
        ELSE ${DUTY_TRANSFER_STATUS.unfinished}::int END) AS status,
      i.effective_date::text AS "transferDate",
      CASE WHEN i.status='succeeded' THEN i.last_attempt_at END AS "transferTime", i.business_id::text AS "batchId",
      CASE kind.kind WHEN 'leave' THEN 2 WHEN 'retirement' THEN 4 ELSE 3 END AS source, NULL::text AS "operatorId",
      i.failure_code AS "failureCode", i.failure_message AS "failureMessage", i.failure_rule AS "failureRule",
      i.org_role AS "orgRole", i.relation,
      COALESCE(org.name, ${personnelHooks.currentName(tenantId, sql`sub.id`, sql`sub.name`)}) AS "targetName"
    FROM transfer_linkage_items i
    LEFT JOIN LATERAL (SELECT p.kind FROM employment_payload_versions p
      WHERE p.tenant_id=i.tenant_id AND p.business_id=i.business_id ORDER BY p.version_no DESC LIMIT 1) kind ON true
    LEFT JOIN LATERAL (SELECT v.name FROM org_versions v WHERE v.tenant_id=i.tenant_id AND v.org_id=i.org_id
      ORDER BY (v.start_date<=${today}::date AND v.stop_date>=${today}::date) DESC, v.version_no DESC LIMIT 1) org
      ON true
    LEFT JOIN employment_employees sub ON sub.tenant_id=i.tenant_id AND sub.id=i.subordinate_id
    WHERE i.tenant_id=${tenantId} AND i.item_type IN ('duty_subordinate','duty_org_role') AND i.status<>'superseded'`;
}

function menuSql(tenantId: string): SQL {
  return sql`
    SELECT id::text, employee_id::text, receiver_id::text, duty_type::int, duty_details, status::int,
      transfer_date::text, transfer_at, batch_id::text, source::int, operator_id::text,
      failure_code, failure_message, failure_rule, org_role, relation, NULL::text
    FROM duty_transfer_records WHERE tenant_id=${tenantId}`;
}

const TAB_STATUS: Record<RecordTab, number | null> = {
  all: null,
  pending: DUTY_TRANSFER_STATUS.unfinished,
  completed: DUTY_TRANSFER_STATUS.completed,
};

export async function listDutyRecords(tx: Tx, tenantId: string, today: string, filter: RecordFilter, visible: SQL) {
  const conditions = [visible];
  const tabStatus = TAB_STATUS[filter.tab];
  // 待生效页签默认来源 = 菜单（原站待生效页签只列菜单指定日期的记录）。
  const source = filter.source ?? (filter.tab === 'pending' ? 1 : undefined);
  if (tabStatus !== null) conditions.push(sql`u.status=${tabStatus}`);
  if (filter.status !== undefined) conditions.push(sql`u.status=${filter.status}`);
  if (source !== undefined) conditions.push(sql`u.source=${source}`);
  if (filter.employeeId) conditions.push(sql`u."employeeId"=${filter.employeeId}`);
  const where = sql.join(conditions, sql` AND `);
  const union = sql`(${linkageSql(tenantId, today)} UNION ALL ${menuSql(tenantId)}) u`;
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*)::int AS total FROM ${union} WHERE ${where}`),
  );
  const rows = rowsOf<UnionRow>(
    await tx.execute(sql`SELECT u.* FROM ${union} WHERE ${where}
      ORDER BY u."transferDate" DESC, u."transferTime" DESC NULLS FIRST, u.id
      LIMIT ${filter.limit} OFFSET ${filter.offset}`),
  );
  return { total: count?.total ?? 0, items: rows.map(unionView) };
}

function unionView(row: UnionRow): DutyRecordView {
  return {
    id: row.id,
    employeeId: row.employeeId,
    receiverId: row.receiverId,
    dutyType: Number(row.dutyType),
    dutyDetails: row.dutyDetails ?? dutyDescription(row, row.targetName ?? ''),
    status: Number(row.status),
    transferDate: row.transferDate,
    transferTime: iso(row.transferTime),
    batchId: row.batchId,
    source: Number(row.source),
    operatorId: row.operatorId,
    failure: row.failureCode
      ? { code: row.failureCode, message: row.failureMessage ?? '', rule: row.failureRule }
      : null,
  };
}
