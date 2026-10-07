import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import type { EmployeeStatusCode, EntryStatusCode } from '@italent/domain';
import { AppError } from '../../errors.js';
import { activationSummary } from './activation-store.js';
import { employmentScopePredicate, employmentCreator } from './context.js';
import { employmentVisibilitySql } from './visibility.js';
import {
  PRESET_FIELD_NAMES,
  type PresetFields,
  type CustomFields,
  type EmploymentRecord,
  type EmploymentBusiness,
  type PageQuery,
  type EmploymentState,
  type BusinessKind,
  type ChangeType,
  type FormId,
  type EmploymentScope,
} from './types.js';

export function rowsOf<T>(value: unknown): T[] {
  return (Array.isArray(value) ? value : (value as { rows: T[] }).rows) as T[];
}

export function columnName(field: string): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function snapshotFields(row: Record<string, unknown>): PresetFields {
  return Object.fromEntries(
    PRESET_FIELD_NAMES.map((field) => [field, row[columnName(field)] ?? null]),
  ) as unknown as PresetFields;
}

function statusCode(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function record(row: Record<string, unknown>): EmploymentRecord {
  const previous = row.previous as Record<string, unknown> | null;
  // 旧 payload 尚未解析延迟继承；只有完整生效快照才能替代原 records 中的最终字段。
  const current = (row.current_payload as Record<string, unknown> | null) ?? row;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    employeeId: String(row.employee_id),
    revision: Number(row.revision),
    staffId: String(row.staff_id),
    entryDate: String(row.entry_date),
    kind: row.kind as BusinessKind,
    changeType: (row.change_type as ChangeType | null) ?? null,
    serviceType: row.service_type as EmploymentRecord['serviceType'],
    effectiveDate: String(row.start_date),
    stopDate: String(row.stop_date),
    previousRecordId: (row.previous_record_id as string | null) ?? null,
    fields: snapshotFields(current),
    customFields: current.custom_fields as CustomFields,
    employeeStatus: Number(current.employee_status) as EmployeeStatusCode,
    entryStatus: statusCode(current.entry_status) as EntryStatusCode | null,
    isCurrent: Boolean(row.is_current),
    isLatest: Boolean(row.is_latest),
    status: 'effective',
    isInserted: Boolean(row.is_inserted),
    before: previous
      ? { fields: snapshotFields(previous), customFields: previous.custom_fields as CustomFields }
      : null,
  };
}

function recordsQuery(tenantId: string, asOf: string, predicates: SQL, page: PageQuery, scope?: EmploymentScope): SQL {
  const department = sql`(CASE WHEN current_payload.body IS NULL THEN r.department_id::text
    ELSE current_payload.body->>'department_id' END)::uuid`;
  const scopeFilter = employmentVisibilitySql(scope, {
    employee: sql`r.employee_id`,
    department,
    creator: employmentCreator(tenantId, sql`r.id`, true),
  });
  return sql`
    SELECT r.*,t.start_date::text AS start_date,b.revision,current_payload.body AS current_payload,
      CASE WHEN isempty(t.valid_during) THEN (t.start_date-1)::text
        WHEN upper_inf(t.valid_during) THEN '9999-12-31' ELSE (upper(t.valid_during)-1)::text END AS stop_date,
      t.valid_during @> ${asOf}::date AS is_current,
      NOT EXISTS (SELECT 1 FROM employment_timeline n WHERE n.tenant_id=${tenantId}
        AND n.employee_id=r.employee_id AND (n.start_date,n.sort_order)>(t.start_date,t.sort_order)) AS is_latest,
      previous.id AS previous_record_id,previous.body AS previous
    FROM employment_records r
    JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
    JOIN employment_business_objects b ON b.tenant_id=r.tenant_id AND b.id=r.id
    LEFT JOIN LATERAL (
      SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id
        AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1
    ) current_payload ON true
    LEFT JOIN LATERAL (
      SELECT p.id,CASE WHEN previous_payload.body IS NULL THEN to_jsonb(p)
        ELSE previous_payload.body END AS body FROM employment_records p
      JOIN employment_timeline pt ON pt.tenant_id=p.tenant_id AND pt.record_id=p.id
      LEFT JOIN LATERAL (
        SELECT to_jsonb(v) AS body FROM employment_payload_versions v
        WHERE v.tenant_id=p.tenant_id AND v.employee_id=p.employee_id AND v.business_id=p.id
          AND v.is_record_snapshot
        ORDER BY v.version_no DESC LIMIT 1
      ) previous_payload ON true
      WHERE p.tenant_id=${tenantId} AND p.employee_id=r.employee_id
        AND (pt.start_date,pt.sort_order)<(t.start_date,t.sort_order)
      ORDER BY pt.start_date DESC,pt.sort_order DESC LIMIT 1
    ) previous ON true
    WHERE r.tenant_id=${tenantId} AND ${predicates}
      AND ${scopeFilter}
    ORDER BY t.start_date ASC,t.sort_order ASC,r.id LIMIT ${page.limit} OFFSET ${page.offset}
  `;
}

export function checkPage(page: PageQuery): void {
  if (
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 200 ||
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0
  )
    throw new AppError('VALIDATION_FAILED', '分页超出允许范围');
}

export async function listEmploymentRecords(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  asOf: string,
  page: PageQuery,
  scope?: EmploymentScope,
) {
  checkPage(page);
  return rowsOf<Record<string, unknown>>(
    await tx.execute(recordsQuery(tenantId, asOf, sql`r.employee_id=${employeeId}`, page, scope)),
  ).map(record);
}

export async function loadEmploymentRecord(
  tx: Tx,
  tenantId: string,
  id: string,
  asOf: string,
  scope?: EmploymentScope,
) {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(recordsQuery(tenantId, asOf, sql`r.id=${id}`, { limit: 1, offset: 0 }, scope)),
  );
  return row ? record(row) : null;
}

/** 新业务的插入点前一条：生效日当天及以前最后一条，同日已有多条时取最后一次操作（DEC-108）。 */
/**
 * 生效日当天及以前的最后一条；beforeOrder 给出时只取同日顺序号小于它的（落地插到当日中间时，前驱是插入点之前那条，
 * DEC-108 / PR #53 第二轮 P2-2）。
 */
export async function findPredecessor(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  effectiveDate: string,
  beforeOrder?: number,
): Promise<EmploymentRecord | null> {
  const bound =
    beforeOrder === undefined
      ? sql`t.start_date<=${effectiveDate}::date`
      : sql`(t.start_date,t.sort_order)<(${effectiveDate}::date,${beforeOrder})`;
  const [previous] = rowsOf<{ record_id: string }>(
    await tx.execute(sql`
    SELECT t.record_id FROM employment_timeline t
    WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId} AND ${bound}
    ORDER BY t.start_date DESC,t.sort_order DESC LIMIT 1
  `),
  );
  return previous ? loadEmploymentRecord(tx, tenantId, previous.record_id, effectiveDate) : null;
}

export async function findCurrentRecord(tx: Tx, tenantId: string, employeeId: string, asOf: string) {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(
      recordsQuery(tenantId, asOf, sql`r.employee_id=${employeeId} AND t.valid_during @> ${asOf}::date`, {
        limit: 1,
        offset: 0,
      }),
    ),
  );
  return row ? record(row) : null;
}

/**
 * access='read' 按 DEC-177 可见口径（详情、预览）；access='write' 是写入前的取数，仍要求记录部门与员工当前任职
 * 同时在范围内（DEC-177 只放宽“看”；可见但部门在范围外的记录能否直接改，TODO(需取证 #72)）。
 */
export async function loadEmploymentBusiness(
  tx: Tx,
  tenantId: string,
  id: string,
  asOf: string,
  scope?: EmploymentScope,
  access: 'read' | 'write' = 'read',
): Promise<EmploymentBusiness | null> {
  const department = sql`CASE WHEN p.is_record_snapshot OR r.id IS NULL THEN p.department_id ELSE r.department_id END`;
  const creator = employmentCreator(tenantId, sql`b.id`, true);
  const scopeFilter =
    access === 'read'
      ? employmentVisibilitySql(scope, { employee: sql`b.employee_id`, department, creator })
      : employmentScopePredicate(scope, sql`b.employee_id`, department, creator);
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT b.id,b.employee_id,b.revision,e.revision AS employee_revision,p.*,s.state
    FROM employment_business_objects b
    JOIN employment_employees e ON e.tenant_id=b.tenant_id AND e.id=b.employee_id
    JOIN LATERAL (SELECT p.* FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
    JOIN LATERAL (SELECT s.state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    WHERE b.tenant_id=${tenantId} AND b.id=${id}
      AND ${scopeFilter} LIMIT 1
  `),
  );
  if (!row) return null;
  const effectiveRecord = await loadEmploymentRecord(tx, tenantId, id, asOf, scope);
  const activation = await activationSummary(tx, tenantId, id, String(row.state));
  return {
    id,
    employeeId: String(row.employee_id),
    revision: Number(row.revision),
    employeeRevision: Number(row.employee_revision),
    status: row.state as EmploymentState,
    kind: row.kind as BusinessKind,
    changeType: (row.change_type as ChangeType | null) ?? null,
    mode: row.mode as 'direct' | 'application',
    formId: row.form_id as FormId,
    effectiveDate: String(row.effective_date),
    fields: effectiveRecord?.fields ?? snapshotFields(row),
    customFields: effectiveRecord?.customFields ?? (row.custom_fields as CustomFields),
    employeeStatus: effectiveRecord?.employeeStatus ?? (Number(row.employee_status) as EmployeeStatusCode),
    entryStatus: effectiveRecord
      ? effectiveRecord.entryStatus
      : (statusCode(row.entry_status) as EntryStatusCode | null),
    record: effectiveRecord,
    activation,
  };
}
