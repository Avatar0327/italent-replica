/**
 * 兼职记录的读取（docs/08_设计/R2-T05_兼职设计.md §6.3 PT-3b：员工页签列表、单条详情的当前字段）。
 * 兼职不进时间轴，通用读口径（read-model recordsQuery 经时间轴）看不到它，所以单独读：记录当前字段取最新快照载荷
 * （编辑追加的 is_record_snapshot 版本，没有则取记录自身），结束日取期限链当前期，任职状态 / 视图归属按租户今天派生
 * （§1.2，不入库）。可见范围 = DEC-177 两项并集（记录部门 ∪ 员工当前主职部门），在 SQL 里分页前过滤；
 * 响应形状沿用任职记录（fields / customFields / effectiveDate = 开始日期），经 trimEmploymentResponse 逐层裁剪。
 */
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_ERRORS,
  PART_TIME_KIND,
  partTimeServiceStatus,
  partTimeViews,
  tenantLocalDate,
  type PartTimeRecordView,
  type PartTimeServiceStatus,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../../errors.js';
import { employmentVisibilitySql } from '../visibility.js';
import { checkPage, rowsOf, snapshotFields } from '../read-model.js';
import type { CustomFields, EmploymentContext, PageQuery, PresetFields } from '../types.js';
import { partTimeRecordCreator } from './creator-sql.js';
import { partTimeCurrentEndSql } from './span-sql.js';

export interface PartTimeRecordDto {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly entryDate: string;
  readonly kind: typeof PART_TIME_KIND;
  readonly serviceType: string;
  /** 兼职开始日期（沿用任职记录的 effectiveDate 编码，字段权限同任职记录对象）。 */
  readonly effectiveDate: string;
  /** 期限链当前期的结束日期；没有结束日期为 null。 */
  readonly endDate: string | null;
  /** 底层业务头 revision（If-Match）。 */
  readonly revision: number;
  readonly fields: PresetFields;
  readonly customFields: CustomFields;
  readonly serviceStatus: PartTimeServiceStatus;
  readonly partTimeView: readonly PartTimeRecordView[];
}

function dto(row: Record<string, unknown>, today: string): PartTimeRecordDto {
  const current = (row.current_payload as Record<string, unknown> | null) ?? row;
  const span = { startDate: String(row.start_text), endDate: (row.end_text as string | null) ?? null };
  return {
    id: String(row.id),
    employeeId: String(row.employee_id),
    staffId: String(row.staff_id),
    entryDate: String(row.entry_text),
    kind: PART_TIME_KIND,
    serviceType: String(row.service_type),
    effectiveDate: span.startDate,
    endDate: span.endDate,
    revision: Number(row.revision),
    fields: snapshotFields(current),
    customFields: current.custom_fields as CustomFields,
    serviceStatus: partTimeServiceStatus(span, today),
    partTimeView: partTimeViews(span, today),
  };
}

function query(ctx: EmploymentContext, predicate: SQL, page: PageQuery): SQL {
  const department = sql`(CASE WHEN current_payload.body IS NULL THEN r.department_id::text
    ELSE current_payload.body->>'department_id' END)::uuid`;
  const visible = employmentVisibilitySql(ctx.scope, {
    employee: sql`r.employee_id`,
    department,
    creator: partTimeRecordCreator(ctx.tenantId, sql`r.id`),
  });
  return sql`
    SELECT r.*, r.start_date::text AS start_text, r.entry_date::text AS entry_text, b.revision,
      ${partTimeCurrentEndSql(ctx.tenantId, sql`r.id`)}::text AS end_text, current_payload.body AS current_payload
    FROM employment_records r
    JOIN employment_business_objects b ON b.tenant_id=r.tenant_id AND b.employee_id=r.employee_id AND b.id=r.id
    LEFT JOIN LATERAL (
      SELECT to_jsonb(p) AS body FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.employee_id=r.employee_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY p.version_no DESC LIMIT 1
    ) current_payload ON true
    WHERE r.tenant_id=${ctx.tenantId} AND r.service_type <> 'primary' AND r.kind=${PART_TIME_KIND}
      AND ${predicate} AND ${visible}
    ORDER BY r.start_date DESC, r.id LIMIT ${page.limit} OFFSET ${page.offset}
  `;
}

const today = (ctx: EmploymentContext) => tenantLocalDate(ctx.now, ctx.timezone);

/** 单条；不存在、不是兼职、对操作人不可见（DEC-177）都是 null。 */
export async function loadPartTime(tx: Tx, ctx: EmploymentContext, id: string): Promise<PartTimeRecordDto | null> {
  const [row] = rowsOf<Record<string, unknown>>(
    await tx.execute(query(ctx, sql`r.id=${id}::uuid`, { limit: 1, offset: 0 })),
  );
  return row ? dto(row, today(ctx)) : null;
}

/** 单条读取的统一拒绝：与不存在同码，不区分原因（不泄露范围外记录是否存在）。 */
export function partTimeNotFound(): AppError {
  return new AppError('NOT_FOUND', '兼职记录不存在', { reason: PART_TIME_ERRORS.recordNotFound });
}

/** 员工页签：该员工全部兼职，按开始日期倒序；逐条按 DEC-177 可见裁剪，分页前过滤。 */
export async function listEmployeePartTimes(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  page: PageQuery,
): Promise<PartTimeRecordDto[]> {
  checkPage(page);
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(query(ctx, sql`r.employee_id=${employeeId}::uuid`, page)),
  );
  return rows.map((row) => dto(row, today(ctx)));
}
