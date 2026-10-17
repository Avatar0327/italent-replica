/**
 * 试用期信息的读取与调整（R2 BE-3；docs/02_业务建模/29 §1、PB-R9～R13，§8 AC-PB-04，15 §5）。
 * - 本任职周期的“开启试用的记录”（anchor）= 当前主职所在周期里最近一条入职 / 实习转正记录，试用期版本链挂在它上面；
 * - 转正日期不另存：取本周期“生效的转正任职记录”的生效日——审批通过但未到生效日的也算（W-597）——
 *   投影到转正记录及之后的记录（PB-R13：转正记录换了日期，之后的记录随之显示新日期）；
 * - 调整试用信息只追加版本：校验 PB-R9 互斥、PB-R11 / R12；“是否有试用期”变化时人员状态在试用 / 正式间切换。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import {
  actualProbationEndDate,
  EMPLOYEE_STATUS,
  normalizeProbationInfo,
  probationAdjustmentViolation,
  tenantLocalDate,
  type EmployeeStatusCode,
  type ProbationAdjustment,
  type ProbationInfo,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { employmentCreator } from './context.js';
import { ENTRY_LIKE_KINDS, switchProbationStatus } from './employee-status.js';
import { appendProbationVersion, loadProbationVersion } from './entry-probation.js';
import { assertProbationProcessesIdle } from './probation-guard.js';
import { bumpEmploymentEmployee, lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { EmploymentContext, EmploymentScope } from './types.js';
import { employmentVisibilitySql } from './visibility.js';

const kinds = (list: readonly string[]) =>
  sql.join(
    list.map((kind) => sql`${kind}`),
    sql`, `,
  );

/**
 * 本周期里的转正业务（LATERAL 子查询）：effectiveOnly = 只看生效的（审批通过 / 已生效），按生效日取最近一条；
 * 否则审批中的优先，其次最近生效的——视图与详情里的“转正审批状态”取这一条。
 */
export function cycleRegularization(tenantId: string, employee: SQL, staff: SQL, effectiveOnly: boolean): SQL {
  const states = effectiveOnly ? sql`('approved', 'effective')` : sql`('in_review', 'approved', 'effective')`;
  return sql`SELECT b.id, s.state, p.mode, p.effective_date::text AS effective_date, rr.result_code
    FROM employment_business_objects b
    JOIN LATERAL (SELECT p.* FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
      AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
      AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_records rg ON rg.tenant_id=b.tenant_id AND rg.id=b.id
    LEFT JOIN employment_regularization_results rr ON rr.tenant_id=b.tenant_id AND rr.business_id=b.id
    WHERE b.tenant_id=${tenantId} AND b.employee_id=${employee} AND p.kind='regularization'
      AND s.state IN ${states} AND COALESCE(rg.staff_id, p.selected_staff_id)=${staff}
    ORDER BY (s.state='in_review') DESC, p.effective_date DESC, b.id LIMIT 1`;
}

interface Anchor {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly entryDate: string;
  readonly employeeStatus: EmployeeStatusCode;
}

/** asOf 当天的主职所在周期里、asOf 及以前最近一条入职 / 实习转正记录；不在职（无当前主职）返回 null。 */
async function loadAnchor(tx: Tx, tenantId: string, employeeId: string, asOf: string): Promise<Anchor | null> {
  const [row] = rowsOf<Anchor>(
    await tx.execute(sql`SELECT a.id, a.employee_id AS "employeeId", a.staff_id AS "staffId",
        a.entry_date::text AS "entryDate", st.employee_status::integer AS "employeeStatus"
      FROM employment_timeline cur
      JOIN employment_records cr ON cr.tenant_id=cur.tenant_id AND cr.id=cur.record_id
      JOIN employment_records a ON a.tenant_id=cr.tenant_id AND a.employee_id=cr.employee_id AND a.staff_id=cr.staff_id
      JOIN employment_timeline at ON at.tenant_id=a.tenant_id AND at.record_id=a.id
      LEFT JOIN LATERAL employment_record_status(a.tenant_id, a.id) st ON true
      WHERE cur.tenant_id=${tenantId} AND cur.employee_id=${employeeId}::uuid AND cur.valid_during @> ${asOf}::date
        AND a.kind IN (${kinds(ENTRY_LIKE_KINDS)}) AND at.start_date<=${asOf}::date
      ORDER BY at.start_date DESC, at.sort_order DESC LIMIT 1`),
  );
  return row ?? null;
}

interface CycleRegularization {
  readonly id: string;
  readonly state: string;
  readonly mode: string;
  readonly effectiveDate: string;
  readonly probationResult: string | null;
}

async function loadCycleRegularization(tx: Tx, anchor: Anchor, tenantId: string, effectiveOnly: boolean) {
  const [row] = rowsOf<Record<string, string | null>>(
    await tx.execute(
      cycleRegularization(tenantId, sql`${anchor.employeeId}::uuid`, sql`${anchor.staffId}::uuid`, effectiveOnly),
    ),
  );
  return row
    ? ({
        id: row.id!,
        state: row.state!,
        mode: row.mode!,
        effectiveDate: row.effective_date!,
        probationResult: row.result_code ?? null,
      } satisfies CycleRegularization)
    : null;
}

export interface ProbationCycle {
  readonly anchor: Anchor;
  readonly info: ProbationInfo;
  /** 生效的转正记录（含审批通过未到期）的日期；没有为 null。 */
  readonly regularizationDate: string | null;
  /** 审批中优先、其次最近生效的转正业务。 */
  readonly regularization: CycleRegularization | null;
}

/** 没有试用期版本（入职时没填）时按开启记录的人员状态推断是否有试用期，其余为空。 */
export async function loadProbationCycle(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  asOf: string,
): Promise<ProbationCycle | null> {
  const anchor = await loadAnchor(tx, tenantId, employeeId, asOf);
  if (!anchor) return null;
  const version = await loadProbationVersion(tx, tenantId, anchor.id);
  const info = version
    ? normalizeProbationInfo(version)
    : normalizeProbationInfo({
        hasProbation: anchor.employeeStatus === EMPLOYEE_STATUS.probation,
        startDate: null,
        months: null,
        expectedEndDate: null,
      });
  const effective = await loadCycleRegularization(tx, anchor, tenantId, true);
  const regularization = await loadCycleRegularization(tx, anchor, tenantId, false);
  return { anchor, info, regularizationDate: effective?.effectiveDate ?? null, regularization };
}

/** 试用人员详情（B6）：试用信息 + 本周期各条任职记录上的转正日期投影（PB-R13）。 */
export async function probationDetail(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'> & { readonly scope?: EmploymentScope },
  employeeId: string,
  asOf: string,
) {
  const cycle = await loadProbationCycle(tx, ctx.tenantId, employeeId, asOf);
  if (!cycle) throw new AppError('NOT_FOUND', '员工当前没有在职任职记录');
  const [employee] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_employees
      WHERE tenant_id=${ctx.tenantId} AND id=${employeeId}::uuid`),
  );
  const department = sql`COALESCE(snap.department_id, r.department_id)`;
  const visible = employmentVisibilitySql(ctx.scope, {
    employee: sql`r.employee_id`,
    department,
    creator: employmentCreator(ctx.tenantId, sql`r.id`, true),
  });
  const records = rowsOf<{ id: string; kind: string; effectiveDate: string; employeeStatus: number }>(
    await tx.execute(sql`SELECT r.id, r.kind, t.start_date::text AS "effectiveDate",
        st.employee_status::integer AS "employeeStatus"
      FROM employment_records r
      JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.record_id=r.id
      LEFT JOIN LATERAL employment_record_status(r.tenant_id, r.id) st ON true
      LEFT JOIN LATERAL (SELECT p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1) snap ON true
      WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${employeeId}::uuid
        AND r.staff_id=${cycle.anchor.staffId}::uuid AND ${visible}
      ORDER BY t.start_date, t.sort_order LIMIT 1001`),
  );
  if (records.length > 1000) throw new AppError('PAYLOAD_TOO_LARGE', '任职记录超过单次读取上限');
  const regularizationDate = cycle.regularizationDate;
  return {
    employeeId,
    revision: employee!.revision,
    recordId: cycle.anchor.id,
    entryDate: cycle.anchor.entryDate,
    ...cycle.info,
    regularizationDate,
    actualEndDate: regularizationDate ? actualProbationEndDate(regularizationDate) : null,
    regularizationBusinessId: cycle.regularization?.id ?? null,
    regularizationState: cycle.regularization?.state ?? null,
    regularizationMode: cycle.regularization?.mode ?? null,
    probationResult: cycle.regularization?.probationResult ?? null,
    records: records.map((record) => ({
      ...record,
      regularizationDate: regularizationDate && record.effectiveDate >= regularizationDate ? regularizationDate : null,
    })),
  };
}

/**
 * 调整试用信息（B6，29 §8 复刻建议：所有能改试用期的入口都走这里，拦截不照搬原站“编辑试用期”入口的缺口）。
 * If-Match = 员工 revision；成功后员工 revision + 1。
 */
export async function adjustProbation(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  input: ProbationAdjustment,
): Promise<void> {
  const employee = await lockEmploymentEmployee(tx, ctx, employeeId, ctx.expectedRevision);
  await assertProbationProcessesIdle(tx, ctx, { employeeId, action: 'adjust' });
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const cycle = await loadProbationCycle(tx, ctx.tenantId, employeeId, today);
  if (!cycle) throw new AppError('CONFLICT', '员工当前没有在职任职记录', { reason: 'NO_CURRENT_EMPLOYMENT' });
  const normalized = { ...normalizeProbationInfo(input), regularizationDate: input.regularizationDate };
  const violation = probationAdjustmentViolation(normalized, {
    entryDate: cycle.anchor.entryDate,
    regularizationDate: cycle.regularizationDate,
  });
  if (violation)
    throw new AppError(violation.kind === 'conflict' ? 'CONFLICT' : 'VALIDATION_FAILED', violation.message, {
      reason: violation.reason,
    });
  await appendProbationVersion(tx, ctx, { employeeId, businessId: cycle.anchor.id }, normalized, 'adjust');
  // PB-R12：没有生效的转正记录时，“是否有试用期”变化直接切换人员状态（有转正记录时 PB-R11 已禁止改为否）
  if (!cycle.regularizationDate && normalized.hasProbation !== cycle.info.hasProbation)
    await switchProbationStatus(tx, ctx, cycle.anchor.id, normalized.hasProbation);
  await bumpEmploymentEmployee(tx, ctx, employee);
}
