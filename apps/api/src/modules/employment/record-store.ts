import { isUuid, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { assertRevision } from './context.js';
import type { PreparedInheritance } from './inheritance.js';
import { PRESET_FIELD_NAMES, type EmploymentBusiness, type EmploymentContext, type PresetFields } from './types.js';

export interface EmploymentEmployeeRow {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  revision: number;
}

export interface EmploymentPayloadRow extends PreparedInheritance {
  id: string;
  tenantId: string;
  employeeId: string;
  businessId: string;
  versionNo: number;
  previousVersionId: string | null;
  kind: EmploymentBusiness['kind'];
  mode: 'direct' | 'application';
  effectiveDate: string;
  lastWorkDate: string | null;
  formId: string;
  selectedStaffId: string | null;
}

export interface LockedEmploymentBusiness {
  id: string;
  employeeId: string;
  revision: number;
  employee: EmploymentEmployeeRow;
  payload: EmploymentPayloadRow;
  state: EmploymentBusiness['status'];
  eventNo: number;
}

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function camelCase(field: string): string {
  return field.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

export function camelRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [camelCase(key), value]));
}

export function snapshotFields(row: Record<string, unknown>): PresetFields {
  return Object.fromEntries(PRESET_FIELD_NAMES.map((key) => [key, row[key] ?? null])) as unknown as PresetFields;
}

export async function lockEmploymentEmployee(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  expectedRevision?: number,
): Promise<EmploymentEmployeeRow> {
  if (!isUuid(employeeId)) throw new AppError('VALIDATION_FAILED', '员工标识必须是 UUID');
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT id, tenant_id, code, name, revision FROM employment_employees
      WHERE tenant_id = ${ctx.tenantId} AND id = ${employeeId}::uuid FOR UPDATE
    `),
  );
  if (!row) throw new AppError('NOT_FOUND', '员工不存在');
  const employee = camelRow(row) as unknown as EmploymentEmployeeRow;
  if (expectedRevision !== undefined) assertRevision(expectedRevision, employee.revision);
  return employee;
}

/** 所有业务先锁员工再锁业务头，统一锁顺序，也串行同员工的时间线改动。 */
export async function lockEmploymentBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
): Promise<LockedEmploymentBusiness> {
  if (!isUuid(id)) throw new AppError('VALIDATION_FAILED', '业务标识必须是 UUID');
  const [owner] = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`
      SELECT employee_id AS "employeeId" FROM employment_business_objects
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid LIMIT 1
    `),
  );
  if (!owner) throw new AppError('NOT_FOUND', '任职业务不存在');
  const employee = await lockEmploymentEmployee(tx, ctx, owner.employeeId);
  const [head] = rowsOf<{ id: string; revision: number }>(
    await tx.execute(sql`
      SELECT id, revision FROM employment_business_objects
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employee.id}::uuid AND id = ${id}::uuid FOR UPDATE
    `),
  );
  if (!head) throw new AppError('NOT_FOUND', '任职业务不存在');
  assertRevision(ctx.expectedRevision, head.revision);
  const [rawPayload] = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      SELECT * FROM employment_payload_versions
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employee.id}::uuid AND business_id = ${id}::uuid
      ORDER BY version_no DESC LIMIT 1
    `),
  );
  const [event] = rowsOf<{ state: EmploymentBusiness['status']; eventNo: number }>(
    await tx.execute(sql`
      SELECT state, event_no AS "eventNo" FROM employment_state_events
      WHERE tenant_id = ${ctx.tenantId} AND employee_id = ${employee.id}::uuid AND business_id = ${id}::uuid
      ORDER BY event_no DESC LIMIT 1
    `),
  );
  if (!rawPayload || !event) throw new AppError('SERVICE_UNAVAILABLE', '任职业务版本链不完整');
  const payload = camelRow(rawPayload);
  return {
    ...head,
    employeeId: employee.id,
    employee,
    payload: { ...payload, fields: snapshotFields(payload) } as unknown as EmploymentPayloadRow,
    ...event,
  };
}

export async function bumpEmploymentEmployee(tx: Tx, ctx: EmploymentContext, employee: EmploymentEmployeeRow) {
  await tx.execute(sql`
    UPDATE employment_employees SET revision = ${employee.revision + 1}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${employee.id}::uuid
  `);
  employee.revision += 1;
}

export async function bumpEmploymentBusiness(tx: Tx, ctx: EmploymentContext, business: LockedEmploymentBusiness) {
  await tx.execute(sql`
    UPDATE employment_business_objects SET revision = ${business.revision + 1}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${business.id}::uuid
  `);
  business.revision += 1;
  await bumpEmploymentEmployee(tx, ctx, business.employee);
}

const TABLES = new Set([
  'employment_business_objects',
  'employment_payload_versions',
  'employment_state_events',
  'employment_cycles',
  'employment_records',
  'employment_record_tombstones',
]);
const JSON_COLUMNS = new Set(['customFields', 'formSnapshot']);
const ARRAY_COLUMNS = new Set(['deferredFieldCodes', 'explicitFieldCodes']);

/** 表名固定于本模块；字段名由服务构造，业务值全部绑定为参数。 */
export async function insertEmploymentRow(tx: Tx, table: string, values: Record<string, unknown>): Promise<void> {
  if (!TABLES.has(table)) throw new TypeError('非任职模块写入表');
  const keys = Object.keys(values).filter((key) => values[key] !== undefined);
  const columns = sql.join(
    keys.map((key) => sql.identifier(key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`))),
    sql`, `,
  );
  const parameters = sql.join(
    keys.map((key) => {
      if (JSON_COLUMNS.has(key)) return sql`${JSON.stringify(values[key])}::jsonb`;
      if (ARRAY_COLUMNS.has(key)) {
        const entries = values[key] as readonly string[];
        return sql`ARRAY[${sql.join(
          entries.map((entry) => sql`${entry}`),
          sql`, `,
        )}]::text[]`;
      }
      return sql`${values[key]}`;
    }),
    sql`, `,
  );
  await tx.execute(sql`INSERT INTO ${sql.identifier(table)} (${columns}) VALUES (${parameters})`);
}
