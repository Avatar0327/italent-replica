/**
 * 职责转交菜单的取数（R2-T09a）：某人当前承担的职责、未完成的菜单记录，以及近 3 个月离职 / 退休仍承担职责的人。
 * 职责口径与执行校验一致（transfer/linkage/validation.ts）：组织角色 = 组织当日有效版本（版本号最大）的负责人 / 店长 /
 * HRBP；下属 = 当日任职（快照优先，同 deletion-guards.ts）的直线 / 虚线经理是本人、且下属本人当日未离职 / 退休。
 */
import { dutyTransferRecords, sql, type Tx } from '@italent/db';
import { DEPARTED_LOOKBACK_MONTHS, dutyDescription, DUTY_TRANSFER_STATUS, DUTY_TYPE } from '@italent/domain';
import { and, eq, type SQL } from 'drizzle-orm';
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

type DutyRow = Omit<Duty, 'key' | 'description'> & { readonly name: string };

/** 某人在 asOf 当日承担的职责：组织角色在前、下属在后，各按编码排序。 */
export async function currentDuties(tx: Tx, tenantId: string, employeeId: string, asOf: string): Promise<Duty[]> {
  const rows = rowsOf<DutyRow>(
    await tx.execute(sql`SELECT * FROM (${dutiesSql(tenantId, asOf, (c) => sql`${c}=${employeeId}::uuid`)}) d
      ORDER BY "dutyType", sort, "orgRole", relation`),
  );
  return rows.map(({ name, ...row }) => {
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
        eq(dutyTransferRecords.status, DUTY_TRANSFER_STATUS.unfinished),
      ),
    )
    .orderBy(dutyTransferRecords.id);
  const rows = lock ? await query.for('update') : await query;
  return new Map(rows.map((row) => [dutyKey(row as DutyTarget & DutyRecordRow), row]));
}

export interface DepartedPerson {
  readonly employeeId: string;
  readonly name: string;
  readonly kind: 'leave' | 'retirement';
  readonly date: string;
  readonly dutyCount: number;
}

/**
 * 检查离职退休人员（DEC-726）：当日任职为离职 / 退休、生效日在最近 3 个月内，且仍承担职责（离职生效不清空职责）。
 * visible 为调用方的数据范围谓词（列 t.employee_id）。
 */
export async function departedWithDuties(tx: Tx, tenantId: string, today: string, visible: SQL) {
  return rowsOf<DepartedPerson>(
    await tx.execute(sql`
      WITH departed AS (
        SELECT t.employee_id, r.kind, lower(t.valid_during) AS since,
          ${personnelHooks.currentName(tenantId, sql`e.id`, sql`e.name`)} AS name, e.code
        FROM employment_timeline t
        JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
        JOIN employment_employees e ON e.tenant_id=t.tenant_id AND e.id=t.employee_id
        WHERE t.tenant_id=${tenantId} AND t.valid_during @> ${today}::date AND r.kind IN ('leave','retirement')
          AND r.service_type='primary'
          AND lower(t.valid_during) >= ${today}::date - ${`${DEPARTED_LOOKBACK_MONTHS} months`}::interval
          AND ${visible}
        LIMIT 1000
      )
      SELECT d.employee_id::text AS "employeeId", d.name, d.kind, d.since::text AS date, count(*)::int AS "dutyCount"
      FROM departed d
      JOIN (${dutiesSql(tenantId, today, (c) => sql`${c} IN (SELECT employee_id FROM departed)`)}) duty
        ON duty."holderId"=d.employee_id::text
      GROUP BY d.employee_id, d.name, d.kind, d.since, d.code
      ORDER BY d.since DESC, d.code`),
  );
}
