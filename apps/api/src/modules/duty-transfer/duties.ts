/**
 * 职责转交菜单的取数（R2-T09a）：某人当前承担的职责、未完成的菜单记录，以及近 3 个月离职 / 退休仍承担职责的人。
 * 职责口径与执行校验一致（transfer/linkage/validation.ts）：组织角色 = 组织当日有效版本（版本号最大）的负责人 / 店长 /
 * HRBP；下属 = 当日任职（快照优先，同 deletion-guards.ts）的直线 / 虚线经理是本人、且下属本人当日未离职 / 退休。
 */
import { dutyTransferRecords, sql, type Tx } from '@italent/db';
import {
  DEPARTED_LOOKBACK_MONTHS,
  dutyDescription,
  DUTY_TRANSFER_SOURCE,
  DUTY_TRANSFER_STATUS,
  DUTY_TYPE,
} from '@italent/domain';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { personnelHooks } from '../employment/personnel-hooks.js';
import { rowsOf } from '../employment/read-model.js';

export interface Duty {
  readonly key: string;
  readonly holderId: string;
  readonly dutyType: 1 | 2;
  readonly orgId: string | null;
  readonly orgRole: string | null;
  readonly subordinateId: string | null;
  readonly relation: string | null;
  readonly description: string;
}

export type DutyTarget = Pick<Duty, 'dutyType' | 'orgId' | 'orgRole' | 'subordinateId' | 'relation'>;

export const dutyKey = (duty: DutyTarget) =>
  duty.dutyType === DUTY_TYPE.orgRole
    ? `org:${duty.orgId}:${duty.orgRole}`
    : `sub:${duty.subordinateId}:${duty.relation}`;

/** holder 为承担人的过滤条件（列名 holder）；停用组织不列（转交只针对仍在用的组织）。 */
function dutiesSql(tenantId: string, asOf: string, holder: (column: SQL) => SQL): SQL {
  const manager = (column: string) => sql.raw(`CASE WHEN s.present THEN s.${column} ELSE r.${column} END`);
  return sql`
    SELECT role.holder::text AS "holderId", 1 AS "dutyType", v.org_id::text AS "orgId", role.code AS "orgRole",
      NULL::text AS "subordinateId", NULL::text AS relation, v.name AS name, v.code AS sort
    FROM (SELECT DISTINCT ON (org_id) org_id, code, name, enabled, person_in_charge_id, shop_owner_id, hrbp_id
      FROM org_versions WHERE tenant_id=${tenantId} AND start_date<=${asOf}::date AND stop_date>=${asOf}::date
      ORDER BY org_id, version_no DESC) v
    CROSS JOIN LATERAL (VALUES ('person_in_charge', v.person_in_charge_id), ('shop_owner', v.shop_owner_id),
      ('hrbp', v.hrbp_id)) role(code, holder)
    WHERE v.enabled AND ${holder(sql`role.holder`)}
    UNION ALL
    SELECT rel.holder::text, 2, NULL, NULL, t.employee_id::text, rel.code,
      ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)}, e.code
    FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN employment_employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id
    LEFT JOIN LATERAL (
      SELECT p.direct_manager_id, p.dotted_manager_id, true AS present FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1
    ) s ON true
    CROSS JOIN LATERAL (VALUES ('direct', ${manager('direct_manager_id')}),
      ('dotted', ${manager('dotted_manager_id')})) rel(code, holder)
    WHERE t.tenant_id=${tenantId} AND t.valid_during @> ${asOf}::date
      AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary' AND ${holder(sql`rel.holder`)}
  `;
}

type DutyRow = Omit<Duty, 'key' | 'description'> & { readonly name: string; readonly sort: string | null };

/** 某人在 asOf 当日承担的职责：组织角色在前、下属在后，各按编码排序。 */
export async function currentDuties(tx: Tx, tenantId: string, employeeId: string, asOf: string): Promise<Duty[]> {
  const rows = rowsOf<DutyRow>(
    await tx.execute(sql`SELECT * FROM (${dutiesSql(tenantId, asOf, (c) => sql`${c}=${employeeId}::uuid`)}) d
      ORDER BY "dutyType", sort, "orgRole", relation`),
  );
  // sort 只用于排序，不进响应（第 2 轮 P2-6 顺带）。
  return rows.map(({ name, sort: _sort, ...row }) => {
    const duty = { ...row, dutyType: Number(row.dutyType) as 1 | 2 };
    return { ...duty, key: dutyKey(duty), description: dutyDescription(duty, name) };
  });
}

export type DutyRecordRow = typeof dutyTransferRecords.$inferSelect;

/** 未完成（待生效）的菜单记录；lock 时按 id 序锁行，供覆盖 / 撤回。 */
export async function pendingRecords(tx: Tx, tenantId: string, employeeId: string, lock = false) {
  const query = tx
    .select()
    .from(dutyTransferRecords)
    .where(
      and(
        eq(dutyTransferRecords.tenantId, tenantId),
        eq(dutyTransferRecords.employeeId, employeeId),
        eq(dutyTransferRecords.source, DUTY_TRANSFER_SOURCE.menu),
        eq(dutyTransferRecords.status, DUTY_TRANSFER_STATUS.unfinished),
      ),
    )
    .orderBy(dutyTransferRecords.id);
  const rows = lock ? await query.for('update') : await query;
  return new Map(rows.map((row) => [dutyKey(row as DutyTarget & DutyRecordRow), row]));
}

/**
 * 清空记录对应的职责当日仍空缺（第 2 轮 P2-2）：与补转交提交时的 requireRoleVacant / requireVacantSubordinate 同口径——
 * 组织角色 = 组织当日有效版本（版本号最大）该角色为空；下属 = 当日任职（快照优先，同 findCurrentRecord）该上级字段为空。
 * 已由别人（或原离职人）接手的不再是待补项。列名按表名限定，供 drizzle 查询与原生 SQL 共用。
 */
function stillVacant(asOf: string): SQL {
  const manager = (column: string) => sql.raw(`CASE WHEN s.present THEN s.${column} ELSE r.${column} END`);
  return sql`CASE WHEN duty_transfer_records.duty_type=${DUTY_TYPE.orgRole} THEN EXISTS (
      SELECT 1 FROM (SELECT person_in_charge_id, shop_owner_id, hrbp_id FROM org_versions v
        WHERE v.tenant_id=duty_transfer_records.tenant_id AND v.org_id=duty_transfer_records.org_id
          AND v.start_date<=${asOf}::date AND v.stop_date>=${asOf}::date ORDER BY v.version_no DESC LIMIT 1) v
      WHERE CASE duty_transfer_records.org_role WHEN 'person_in_charge' THEN v.person_in_charge_id
        WHEN 'shop_owner' THEN v.shop_owner_id WHEN 'hrbp' THEN v.hrbp_id END IS NULL)
    ELSE EXISTS (
      SELECT 1 FROM (SELECT r.* FROM employment_timeline t
        JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
        WHERE t.tenant_id=duty_transfer_records.tenant_id AND t.employee_id=duty_transfer_records.subordinate_id
          AND t.valid_during @> ${asOf}::date ORDER BY t.start_date, t.sort_order, r.id LIMIT 1) r
      LEFT JOIN LATERAL (
        SELECT p.direct_manager_id, p.dotted_manager_id, true AS present FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1
      ) s ON true
      WHERE CASE duty_transfer_records.relation WHEN 'direct' THEN ${manager('direct_manager_id')}
        WHEN 'dotted' THEN ${manager('dotted_manager_id')} END IS NULL) END`;
}

/** 待补转交的清空记录条件（DT-R5：来源 2 / 4、接收人为空、未完成）；给 vacantOn 时只留当日仍空缺的（菜单与检查列表）。 */
function clearedWhere(tenantId: string, vacantOn?: string): SQL {
  return and(
    eq(dutyTransferRecords.tenantId, tenantId),
    inArray(dutyTransferRecords.source, [DUTY_TRANSFER_SOURCE.leave, DUTY_TRANSFER_SOURCE.retirement]),
    eq(dutyTransferRecords.status, DUTY_TRANSFER_STATUS.unfinished),
    isNull(dutyTransferRecords.receiverId),
    vacantOn ? stillVacant(vacantOn) : undefined,
  )!;
}

/**
 * 被离职 / 退休落地清空、待补转交的职责记录。菜单与检查离职退休人员传 vacantOn（同一条件 clearedWhere）；
 * 补转交提交按 lock 取全部未完成的清空记录、不按空缺过滤：已被接手的由执行器明确拒绝 DUTY_SUPPLEMENT_NOT_VACANT。
 */
export async function clearedRecords(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  options: { readonly lock?: boolean; readonly vacantOn?: string } = {},
) {
  const query = tx
    .select()
    .from(dutyTransferRecords)
    .where(and(clearedWhere(tenantId, options.vacantOn), eq(dutyTransferRecords.employeeId, employeeId)))
    .orderBy(dutyTransferRecords.dutyType, dutyTransferRecords.dutyDetails, dutyTransferRecords.id);
  const rows = options.lock ? await query.for('update') : await query;
  return new Map(rows.map((row) => [dutyKey(row as DutyTarget & DutyRecordRow), row]));
}

/** 清空记录还原成职责（菜单列出 / 补转交执行用；描述沿用清空当时写下的）。 */
export function clearedDuty(row: DutyRecordRow): Duty {
  const target = row as DutyTarget & DutyRecordRow;
  return {
    key: dutyKey(target),
    holderId: row.employeeId,
    dutyType: row.dutyType as 1 | 2,
    orgId: row.orgId,
    orgRole: row.orgRole,
    subordinateId: row.subordinateId,
    relation: row.relation,
    description: row.dutyDetails,
  };
}

export interface DepartedPerson {
  readonly employeeId: string;
  readonly name: string;
  readonly kind: 'leave' | 'retirement';
  readonly date: string;
  readonly dutyCount: number;
}

/**
 * 检查离职退休人员（DEC-726）：当日任职为离职 / 退休、生效日在最近 3 个月内，且仍承担职责（离职生效不清空职责）
 * 或有落地时被清空、尚未补办且仍空缺的职责记录（来源 2 / 4，DT-R5；与菜单同一条件 clearedWhere）。退休同时返聘的不列（账号不关闭、职责保留，RT-R3，DEC-863①）。
 * visible 为调用方的数据范围谓词（列 t.employee_id）。“仍承担职责”在分页前过滤，total 按完整过滤集计（第 2 轮 P2-6）；
 * 排序稳定：生效日倒序、员工 ID 升序。
 */
export interface DepartedPage {
  readonly total: number;
  readonly items: DepartedPerson[];
}

export async function departedWithDuties(
  tx: Tx,
  tenantId: string,
  today: string,
  visible: SQL,
  page: { readonly limit: number; readonly offset: number },
): Promise<DepartedPage> {
  const live = dutiesSql(tenantId, today, (c) => sql`${c} IN (SELECT employee_id FROM departed)`);
  const rows = rowsOf<DepartedPerson & { total: number }>(
    await tx.execute(sql`
      WITH departed AS (
        SELECT t.employee_id, r.kind, lower(t.valid_during) AS since
        FROM employment_timeline t
        JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
        WHERE t.tenant_id=${tenantId} AND t.valid_during @> ${today}::date AND r.kind IN ('leave','retirement')
          AND r.service_type='primary'
          AND NOT EXISTS (SELECT 1 FROM retirement_requests rr
            WHERE rr.tenant_id=r.tenant_id AND rr.business_id=r.id AND rr.re_employed)
          AND lower(t.valid_during) >= ${today}::date - ${`${DEPARTED_LOOKBACK_MONTHS} months`}::interval
          AND ${visible}
      ),
      holding AS (
        SELECT d.employee_id, d.kind, d.since, count(*)::int AS duty_count, count(*) OVER ()::int AS total
        FROM departed d
        JOIN (
          SELECT "holderId" FROM (${live}) live
          UNION ALL
          SELECT employee_id::text FROM duty_transfer_records
          WHERE ${clearedWhere(tenantId, today)} AND employee_id IN (SELECT employee_id FROM departed)
        ) duty ON duty."holderId"=d.employee_id::text
        GROUP BY d.employee_id, d.kind, d.since
        ORDER BY d.since DESC, d.employee_id
        LIMIT ${page.limit} OFFSET ${page.offset}
      )
      SELECT h.employee_id::text AS "employeeId",
        ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name,
        h.kind, h.since::text AS date, h.duty_count AS "dutyCount", h.total
      FROM holding h JOIN employment_employees e ON e.tenant_id=${tenantId} AND e.id=h.employee_id
      ORDER BY h.since DESC, h.employee_id`),
  );
  // 越过末页时没有行可带 total：再数一次（只在翻过头时发生）。
  const total = rows[0]?.total ?? (page.offset > 0 ? await departedTotal(tx, tenantId, today, visible) : 0);
  return { total, items: rows.map(({ total: _total, ...row }) => row) };
}

async function departedTotal(tx: Tx, tenantId: string, today: string, visible: SQL): Promise<number> {
  return (await departedWithDuties(tx, tenantId, today, visible, { limit: 1, offset: 0 })).total;
}
