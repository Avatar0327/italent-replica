/**
 * 兼职记录的持久化（docs/08_设计/R2-T05_兼职设计.md §1.1 / §1.2 / §1.3 / §7.1）：记录 + 底层业务头 + 载荷 + 状态事件 + 期限链。
 * 兼职不进时间轴，不走 materializeEmploymentRecord（P-38）；底层业务头的 revision 是兼职记录的并发版本号，
 * 期限链每追加一期也 +1。只做写入与查询，不做业务校验、不写审计（校验见 validation / boundary，审计由调用方按场景写）。
 * 锁序（§7.1）：员工行（调用方已持有）→ 兼职底层业务头（按 ID 升序）→ 组织锁。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { PART_TIME_KIND, type PartTimeServiceType, type PartTimeTermSource } from '@italent/domain';
import { insertEmploymentRow, rowsOf } from '../record-store.js';
import type { EmploymentContext, PresetFields } from '../types.js';
import { partTimeCurrentEndSql, partTimeEmptySql } from './span-sql.js';

/** 兼职记录的当前状态（当前期的结束日、当前部门取最新快照）。 */
export interface PartTimeRecordRow {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly serviceType: string;
  readonly startDate: string;
  /** 当前期（最大期号）的结束日期；没有结束日期为 null。 */
  readonly endDate: string | null;
  readonly termNo: number;
  readonly departmentId: string | null;
  /** 底层业务头 revision（If-Match）。 */
  readonly revision: number;
}

/** 记录的当前部门：被编辑改过的以最新快照载荷为准（同 employment/org-people.ts 的口径）。 */
const latestSnapshot = sql`LEFT JOIN LATERAL (
    SELECT p.id, p.department_id FROM employment_payload_versions p
    WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
    ORDER BY p.version_no DESC LIMIT 1
  ) latest ON true`;
const currentDepartment = sql`CASE WHEN latest.id IS NULL THEN r.department_id ELSE latest.department_id END`;

/**
 * 锁住员工某任职周期（省略则全部）的兼职记录底层业务头（FOR UPDATE，按 ID 升序），并读出当前期。
 * 调用方已持有该员工行锁（lockEmploymentEmployee / 离职落地事务）。分两步查询：没有兼职时不触及期限链表。
 */
export async function lockPartTimeRecords(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  employeeId: string,
  staffId?: string,
): Promise<PartTimeRecordRow[]> {
  const locked = rowsOf<Omit<PartTimeRecordRow, 'endDate' | 'termNo'>>(
    await tx.execute(sql`
      SELECT r.id, r.employee_id AS "employeeId", r.staff_id AS "staffId", r.service_type AS "serviceType",
        r.start_date::text AS "startDate", ${currentDepartment} AS "departmentId", b.revision
      FROM employment_records r
      JOIN employment_business_objects b ON b.tenant_id=r.tenant_id AND b.employee_id=r.employee_id AND b.id=r.id
      ${latestSnapshot}
      WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${employeeId}::uuid AND r.service_type <> 'primary'
        ${staffId === undefined ? sql`` : sql`AND r.staff_id=${staffId}::uuid`}
      ORDER BY r.id FOR UPDATE OF b
    `),
  );
  if (!locked.length) return [];
  const terms = rowsOf<{ recordId: string; endDate: string | null; termNo: number }>(
    await tx.execute(sql`
      SELECT DISTINCT ON (t.record_id) t.record_id AS "recordId", t.end_date::text AS "endDate", t.term_no AS "termNo"
      FROM employment_part_time_terms t
      WHERE t.tenant_id=${ctx.tenantId} AND t.record_id = ANY(${uuidArray(locked.map((row) => row.id))})
      ORDER BY t.record_id, t.term_no DESC
    `),
  );
  const current = new Map(terms.map((term) => [term.recordId, term]));
  return locked.map((row) => ({
    ...row,
    endDate: current.get(row.id)?.endDate ?? null,
    termNo: current.get(row.id)?.termNo ?? 0,
  }));
}

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

export interface NewPartTimeRecord {
  readonly employeeId: string;
  readonly staffId: string;
  readonly entryDate: string;
  readonly serviceType: PartTimeServiceType;
  readonly startDate: string;
  readonly endDate: string | null;
  /** 预置字段整组（含系统派生的 jobNumber / employType）。 */
  readonly fields: PresetFields;
  readonly customFields: Readonly<Record<string, unknown>>;
  /** 本次明确给出的预置字段编码（preset:xxx），随载荷保存。 */
  readonly explicitFieldCodes: readonly string[];
}

/**
 * 写一条兼职记录及其全部底座（§1.3）：底层业务头（direct、revision 1）+ 载荷版本 1 + 一条 effective 状态事件 +
 * 记录（kind = part_time，人员状态 / 入职状态由 0062 触发器取同周期开始日的主职前一条，仅为快照）+ 期限链第 1 期。
 * 返回记录 ID（= 底层业务头 ID）与载荷版本 ID。
 */
export async function insertPartTimeRecord(
  tx: Tx,
  ctx: EmploymentContext,
  input: NewPartTimeRecord,
): Promise<{ readonly id: string; readonly payloadVersionId: string }> {
  const id = randomUUID();
  const payloadVersionId = randomUUID();
  const { tenantId } = ctx;
  const createdAt = ctx.now.toISOString();
  await insertEmploymentRow(tx, 'employment_business_objects', {
    id,
    tenantId,
    employeeId: input.employeeId,
    revision: 1,
    createdAt,
  });
  await insertEmploymentRow(tx, 'employment_payload_versions', {
    ...input.fields,
    id: payloadVersionId,
    tenantId,
    employeeId: input.employeeId,
    businessId: id,
    versionNo: 1,
    previousVersionId: null,
    kind: PART_TIME_KIND,
    mode: 'direct',
    effectiveDate: input.startDate,
    lastWorkDate: null,
    formId: PART_TIME_KIND,
    selectedStaffId: input.staffId,
    customFields: input.customFields,
    deferredFieldCodes: [],
    explicitFieldCodes: input.explicitFieldCodes,
    formSnapshot: {},
    createdAt,
  });
  await insertEmploymentRow(tx, 'employment_state_events', {
    tenantId,
    employeeId: input.employeeId,
    businessId: id,
    payloadVersionId,
    state: 'effective',
    eventNo: 1,
    commandId: ctx.commandId,
    createdAt,
  });
  await insertEmploymentRow(tx, 'employment_records', {
    ...input.fields,
    id,
    tenantId,
    employeeId: input.employeeId,
    payloadVersionId,
    staffId: input.staffId,
    entryDate: input.entryDate,
    kind: PART_TIME_KIND,
    changeType: null,
    startDate: input.startDate,
    lastWorkDate: null,
    serviceType: input.serviceType,
    isInserted: false,
    inheritanceSourceId: null,
    customFields: input.customFields,
    createdAt,
  });
  await insertTerm(tx, ctx, {
    recordId: id,
    employeeId: input.employeeId,
    termNo: 1,
    endDate: input.endDate,
    source: 'create',
  });
  return { id, payloadVersionId };
}

interface NewTerm {
  readonly recordId: string;
  readonly employeeId: string;
  readonly termNo: number;
  readonly endDate: string | null;
  readonly source: PartTimeTermSource;
  /** 申请 ID / 批次 ID / 调动联动子项 ID / 离职记录 ID。 */
  readonly sourceId?: string | null;
}

async function insertTerm(tx: Tx, ctx: EmploymentContext, term: NewTerm): Promise<void> {
  await tx.execute(sql`
    INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date, source, source_id,
      command_id, created_at)
    VALUES (${ctx.tenantId}, ${term.employeeId}, ${term.recordId}, ${term.termNo}, ${term.endDate}, ${term.source},
      ${term.sourceId ?? null}, ${ctx.commandId}, ${ctx.now.toISOString()}::timestamptz)
  `);
}

/**
 * 在兼职记录上追加一期（延长 / 结束 / 批量结束 / 调动 / 离职 / 编辑结束日），并把底层业务头 revision +1（§1.3）。
 * 调用方已持有该记录的业务头锁（lockPartTimeRecords）；“原结束日期”从上一期取，不建列（硬规则 3）。
 * 返回新的期号与 revision。
 */
export async function appendPartTimeTerm(
  tx: Tx,
  ctx: EmploymentContext,
  record: Pick<PartTimeRecordRow, 'id' | 'employeeId' | 'termNo' | 'revision'>,
  term: { readonly endDate: string | null; readonly source: PartTimeTermSource; readonly sourceId?: string | null },
): Promise<{ readonly termNo: number; readonly revision: number }> {
  const termNo = record.termNo + 1;
  await insertTerm(tx, ctx, { recordId: record.id, employeeId: record.employeeId, termNo, ...term });
  await tx.execute(sql`
    UPDATE employment_business_objects SET revision = revision + 1
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${record.employeeId}::uuid AND id=${record.id}::uuid
  `);
  return { termNo, revision: record.revision + 1 };
}

/**
 * 组织停用计数（§6.3 / §6.4，P-13）：这些部门里自 from 起（含 from 之后才开始的）仍有效的兼职记录条数，
 * 按记录计、不按员工去重（同 DEC-275②）。已在 from 之前结束、空区间的不计；部门取记录当前部门（被编辑改过以最新快照为准）。
 * 兼职永远不是“占编人数”（§1.6），所以这里与 countDepartmentStaff 分开，由 assertSubtreeVacant 合计。
 */
export async function countDepartmentPartTimes(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
  from: string,
): Promise<Map<string, number>> {
  if (!orgIds.length) return new Map();
  const rows = rowsOf<{ orgId: string; count: number }>(
    await tx.execute(sql`
      WITH candidates AS (
        SELECT id FROM employment_records
        WHERE tenant_id=${tenantId} AND service_type <> 'primary' AND department_id = ANY(${uuidArray(orgIds)})
        UNION
        SELECT p.business_id FROM employment_payload_versions p
        JOIN employment_records r ON r.tenant_id=p.tenant_id AND r.id=p.business_id AND r.service_type <> 'primary'
        WHERE p.tenant_id=${tenantId} AND p.department_id = ANY(${uuidArray(orgIds)}) AND p.is_record_snapshot
      ), parts AS (
        SELECT ${currentDepartment} AS department_id, r.start_date AS start_date,
          ${partTimeCurrentEndSql(tenantId, sql`r.id`)} AS end_date
        FROM candidates candidate
        JOIN employment_records r ON r.tenant_id=${tenantId} AND r.id=candidate.id
        ${latestSnapshot}
      )
      SELECT department_id AS "orgId", count(*)::int AS count FROM parts
      WHERE department_id = ANY(${uuidArray(orgIds)}) AND NOT ${partTimeEmptySql(sql`start_date`, sql`end_date`)}
        AND (end_date IS NULL OR end_date >= ${from}::date)
      GROUP BY department_id
    `),
  );
  return new Map(rows.map((row) => [row.orgId, Number(row.count)]));
}
