/**
 * 人员流动分析（B50）与流动情况报表（B54）的取数（docs/02_业务建模/35“流动情况各报表的算法”、“补充：BE-13…”B50）。
 * 四类行集各只有一份 SQL，复用人事看板（BE-12b）的同一谓词，并先叠加 DEC-177 可见谓词再交给 TS 计算：
 * - 时点人数：inServiceFrom（与“正式员工 / 实习生”同一谓词），一条语句取多个日期，部门取当天值；
 * - 离职：exitCandidates（离职 + 退休，与“本年离职”同源），按离职生效日 = 最后工作日 + 1 取，部门为离职前部门；
 * - 入职：entriesFrom（与“本年入职”同源），按入职任职记录开始日期取；
 * - 调动：业务类型“调动”已生效的单据，按生效日期取，部门为调动后部门，类型取调动申请的异动类型。
 * 口径都是内部员工 + 实习生（WORKING_TYPES）。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { exitCandidates } from '../employment/exit-queries.js';
import { rowsOf } from '../employment/read-model.js';
import { readTransferCatalog } from '../transfer/configuration.js';
import {
  current,
  employmentVisible,
  employType,
  entriesFrom,
  exitSource,
  inServiceFrom,
  WORKING_TYPES,
  type DashboardAsOf,
} from './hr-dashboard.js';

/** 一条流动记录的人员属性（分段统计用）；departmentId 是该记录归属的部门。 */
export interface MovementPerson {
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly sequenceId: string | null;
  readonly gender: string | null;
  readonly birthday: string | null;
  readonly educationLevel: string | null;
}
export interface MovementExit extends MovementPerson {
  readonly kind: 'leave' | 'retirement';
  readonly lastWorkDate: string;
  /** 离职生效日 = 最后工作日 + 1（最后工作日当天仍在职）。 */
  readonly effectiveDate: string;
  readonly entryDate: string | null;
  readonly keyPerson: boolean;
  readonly typeCode: string | null;
  readonly typeName: string | null;
  readonly reasonCode: string | null;
  readonly reasonName: string | null;
  readonly whereaboutsCode: string | null;
  readonly whereaboutsName: string | null;
}
export interface MovementHire extends MovementPerson {
  readonly startDate: string;
}
export interface MovementTransfer {
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly effectiveDate: string;
  readonly typeCode: string | null;
}
export interface MovementData {
  /** 日期 → 当天在职的人（每人一行）。 */
  readonly snapshots: ReadonlyMap<string, readonly { employeeId: string; departmentId: string | null }[]>;
  readonly exits: readonly MovementExit[];
  readonly hires: readonly MovementHire[];
  readonly transfers: readonly MovementTransfer[];
  /** 调动异动类型编码 → 名称（asOf 当天的调动字典）。 */
  readonly transferTypes: ReadonlyMap<string, string>;
}

type MovementContext = Pick<DashboardAsOf, 'tenantId' | 'asOf' | 'scope'>;
const WORKING = sql.join(
  WORKING_TYPES.map((type) => sql`${type}`),
  sql`, `,
);
const dateArray = (days: readonly string[]) => sql`${`{${days.join(',')}}`}::date[]`;

/** 人事档案的性别 / 出生日期 / 学历（最新版本，与 BE-13a structurePeople 同口径）；m.employee_id 是员工。 */
const PROFILE = sql`LEFT JOIN LATERAL (SELECT v.gender, v.birthday::text AS birthday,
    v.education_level AS "educationLevel" FROM personnel_employee_versions v
  WHERE v.tenant_id=m.tenant_id AND v.employee_id=m.employee_id ORDER BY v.revision DESC LIMIT 1) pv ON true`;

async function snapshots(tx: Tx, a: MovementContext, days: readonly string[]) {
  const rows = rowsOf<{ day: string; employeeId: string; departmentId: string | null }>(
    await tx.execute(sql`SELECT d.day::text AS day, m.employee_id AS "employeeId", m.org_id AS "departmentId"
      FROM unnest(${dateArray(days)}) d(day)
      JOIN LATERAL (SELECT DISTINCT ON (r.employee_id) r.employee_id, ${current('department_id')} AS org_id,
          NULL::uuid AS creator_id
        ${inServiceFrom({ tenantId: a.tenantId, asOf: sql`d.day` }, employType(WORKING_TYPES))}
        ORDER BY r.employee_id, t.start_date DESC, t.sort_order DESC) m ON true
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY day, m.employee_id`),
  );
  const byDay = new Map<string, { employeeId: string; departmentId: string | null }[]>(days.map((d) => [d, []]));
  for (const { day, ...person } of rows) byDay.get(day)?.push(person);
  return byDay;
}

/** 离职前最后一段主职任职（最后工作日当天或之前）的序列与关键人员标记，同 exitCandidates 的前驱记录取法。 */
const PREVIOUS_RECORD = sql`LEFT JOIN LATERAL (SELECT COALESCE(snap.sequence_id, r.sequence_id) AS sequence_id,
    COALESCE(snap.is_key_person, r.is_key_person, false) AS is_key_person
  FROM employment_timeline t
  JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
  LEFT JOIN LATERAL (SELECT v.sequence_id, v.is_key_person FROM employment_payload_versions v
    WHERE v.tenant_id=r.tenant_id AND v.business_id=r.id AND v.is_record_snapshot
    ORDER BY v.version_no DESC LIMIT 1) snap ON true
  WHERE t.tenant_id=b.tenant_id AND t.employee_id=b.employee_id AND t.start_date<=p.last_work_date
  ORDER BY t.start_date DESC, t.sort_order DESC LIMIT 1) mv ON true`;

function exitRows(a: MovementContext, kind: 'leave' | 'retirement', from: string, to: string): SQL {
  const source = exitSource(kind);
  const extended = {
    ...source,
    columns: sql`${source.columns} dc.entry_date::text AS "entryDate", mv.sequence_id AS "sequenceId",
      mv.is_key_person AS "keyPerson",`,
    joins: sql`${source.joins} ${PREVIOUS_RECORD}`,
  };
  const where = sql`s.state='effective' AND p.last_work_date + 1 BETWEEN ${from}::date AND ${to}::date
    AND dc.employ_type IN (${WORKING})`;
  return sql`SELECT ${kind}::text AS kind, x."employeeId" AS employee_id, x."departmentId" AS org_id,
      NULL::uuid AS creator_id, ${a.tenantId}::uuid AS tenant_id, x."employeeId", x."departmentId", x."sequenceId",
      x."lastWorkDate", x."entryDate", x."keyPerson", x."exitTypeCode", x."exitTypeName", x."reasonCode",
      x."reasonName", x."whereaboutsCode", x."whereaboutsName"
    FROM (${exitCandidates(a.tenantId, undefined, [where], sql`b.id`, extended)}) x`;
}

async function exits(tx: Tx, a: MovementContext, from: string, to: string) {
  return rowsOf<MovementExit>(
    await tx.execute(sql`SELECT m.kind, m."employeeId", m."departmentId", m."sequenceId", m."lastWorkDate",
        (m."lastWorkDate"::date + 1)::text AS "effectiveDate", m."entryDate", m."keyPerson",
        m."exitTypeCode" AS "typeCode", m."exitTypeName" AS "typeName", m."reasonCode", m."reasonName",
        m."whereaboutsCode", m."whereaboutsName", pv.*
      FROM (${exitRows(a, 'leave', from, to)} UNION ALL ${exitRows(a, 'retirement', from, to)}) m
      ${PROFILE}
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY "effectiveDate", m."employeeId"`),
  );
}

async function hires(tx: Tx, a: MovementContext, from: string, to: string) {
  return rowsOf<MovementHire>(
    await tx.execute(sql`SELECT m.employee_id AS "employeeId", m.org_id AS "departmentId", m."sequenceId",
        m."startDate", pv.*
      FROM (SELECT r.tenant_id, r.employee_id, ${current('department_id')} AS org_id, NULL::uuid AS creator_id,
          ${current('sequence_id')} AS "sequenceId", t.start_date::text AS "startDate"
        ${entriesFrom({ tenantId: a.tenantId, asOf: to }, 'hired', from)}) m
      ${PROFILE}
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY m."startDate", m.employee_id`),
  );
}

/** 只算业务类型“调动”（docs/02_业务建模/35 B50 6.27）：转正带调动、组织调整引起的调动是别的业务类型，不计。 */
async function transfers(tx: Tx, a: MovementContext, from: string, to: string) {
  return rowsOf<MovementTransfer>(
    await tx.execute(sql`SELECT m.employee_id AS "employeeId", m.org_id AS "departmentId", m."effectiveDate",
        m."typeCode"
      FROM (SELECT b.employee_id, p.department_id AS org_id, NULL::uuid AS creator_id,
          p.effective_date::text AS "effectiveDate", tr.transfer_type_code AS "typeCode"
        FROM employment_business_objects b
        JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
          WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
        JOIN LATERAL (SELECT s.state FROM employment_state_events s
          WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
        LEFT JOIN transfer_requests tr ON tr.tenant_id=b.tenant_id AND tr.business_id=b.id
        WHERE b.tenant_id=${a.tenantId} AND p.kind='transfer' AND s.state='effective'
          AND p.effective_date BETWEEN ${from}::date AND ${to}::date) m
      WHERE ${employmentVisible(a, sql`m`)}
      ORDER BY m."effectiveDate", m.employee_id`),
  );
}

/** 一次取齐：days 是要取时点人数的日期，[from, to] 是入职 / 离职 / 调动的统计区间（to ≤ asOf）。 */
export async function loadMovement(
  tx: Tx,
  a: MovementContext,
  window: { readonly days: readonly string[]; readonly from: string; readonly to: string },
): Promise<MovementData> {
  const { from, to } = window;
  const catalog = await readTransferCatalog(tx, a.tenantId, a.asOf);
  return {
    snapshots: await snapshots(tx, a, [...new Set(window.days)]),
    exits: await exits(tx, a, from, to),
    hires: await hires(tx, a, from, to),
    transfers: await transfers(tx, a, from, to),
    transferTypes: new Map(catalog.types.map((type) => [type.code, type.name])),
  };
}
