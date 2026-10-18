/**
 * 试用期考核记录的读取与状态落库（R2 BE-15b1；docs/02_业务建模/29 PB-R3～R6）。
 * 表 employment_probation_assessments 一行 = 一条考核（业务单）：审批回调与路由共用这里的加载、行锁、状态回写与审计。
 * 审计按字段级变更日志写（DEC-019），归属考核对象与其主职部门（audit/visibility 按员工 / 组织裁剪）。
 */
import { sql, type Tx } from '@italent/db';
import type {
  AssessmentOpinion,
  AssessmentRating,
  AssessmentStatus,
  AssessmentType,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { assertRevision, auditEmployment } from './context.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const ASSESSMENT_AUDIT_TYPE = 'probation-assessment';

export interface AssessmentRow {
  readonly id: string;
  readonly employeeId: string;
  readonly anchorId: string;
  readonly departmentId: string | null;
  readonly assessmentType: AssessmentType;
  readonly assessmentName: string;
  readonly assessmentDate: string;
  readonly selfEvaluation: string | null;
  readonly managerRating: AssessmentRating | null;
  readonly regularizationOpinion: AssessmentOpinion | null;
  readonly regularizationDate: string | null;
  readonly status: AssessmentStatus;
  readonly initiation: 'manual' | 'auto';
  readonly initiatorUserId: string;
  readonly regularizationBusinessId: string | null;
  readonly revision: number;
}

const COLUMNS = sql`id::text AS id, employee_id::text AS "employeeId", anchor_id::text AS "anchorId",
  department_id::text AS "departmentId", assessment_type AS "assessmentType", assessment_name AS "assessmentName",
  assessment_date::text AS "assessmentDate", self_evaluation AS "selfEvaluation", manager_rating AS "managerRating",
  regularization_opinion AS "regularizationOpinion", regularization_date::text AS "regularizationDate", status,
  initiation, initiator_user_id::text AS "initiatorUserId",
  regularization_business_id::text AS "regularizationBusinessId", revision::integer AS revision`;

/** 接口形状（对象 TenantBase.ProbationAssessment 的字段目录 + id / revision / 创建所属员工）。 */
export type AssessmentView = Omit<AssessmentRow, 'anchorId' | 'departmentId'>;

export function assessmentView(row: AssessmentRow): AssessmentView {
  const { anchorId: _anchor, departmentId: _department, ...view } = row;
  return view;
}

export async function loadAssessment(tx: Tx, tenantId: string, id: string, lock = false): Promise<AssessmentRow> {
  const [row] = rowsOf<AssessmentRow>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM employment_probation_assessments
      WHERE tenant_id=${tenantId} AND id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) throw new AppError('NOT_FOUND', '考核记录不存在');
  return row;
}

export interface AssessmentFilter {
  readonly employeeId?: string;
  readonly status?: AssessmentStatus;
  readonly assessmentType?: AssessmentType;
}

/** 列表：按创建先后倒序；范围裁剪由调用方给出（员工维度谓词），上限由 limit / offset 控制。 */
export async function listAssessments(
  tx: Tx,
  tenantId: string,
  filter: AssessmentFilter,
  visible: ReturnType<typeof sql>,
  page: { readonly limit: number; readonly offset: number },
): Promise<AssessmentRow[]> {
  return rowsOf<AssessmentRow>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM employment_probation_assessments a
      WHERE a.tenant_id=${tenantId} AND ${visible}
        AND (${filter.employeeId ?? null}::uuid IS NULL OR a.employee_id=${filter.employeeId ?? null}::uuid)
        AND (${filter.status ?? null}::text IS NULL OR a.status=${filter.status ?? null})
        AND (${filter.assessmentType ?? null}::text IS NULL OR a.assessment_type=${filter.assessmentType ?? null})
      ORDER BY a.created_at DESC, a.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
}

type Patch = Partial<
  Pick<
    AssessmentRow,
    | 'assessmentName'
    | 'assessmentDate'
    | 'selfEvaluation'
    | 'managerRating'
    | 'regularizationOpinion'
    | 'regularizationDate'
    | 'status'
    | 'regularizationBusinessId'
  >
>;

const COLUMN_OF: Readonly<Record<keyof Patch, string>> = {
  assessmentName: 'assessment_name',
  assessmentDate: 'assessment_date',
  selfEvaluation: 'self_evaluation',
  managerRating: 'manager_rating',
  regularizationOpinion: 'regularization_opinion',
  regularizationDate: 'regularization_date',
  status: 'status',
  regularizationBusinessId: 'regularization_business_id',
};
const CAST: Readonly<Partial<Record<keyof Patch, string>>> = {
  assessmentDate: '::date',
  regularizationDate: '::date',
  regularizationBusinessId: '::uuid',
};

/**
 * 保存一次修改（行已锁）：revision + 1，写字段级审计；If-Match 由调用方先比对（路由编辑）或不比对（审批回写是可信
 * 回调，按行锁串行）。返回保存后的行。
 */
export async function saveAssessment(
  tx: Tx,
  ctx: EmploymentContext,
  before: AssessmentRow,
  patch: Patch,
  action: string,
): Promise<AssessmentRow> {
  const entries = Object.entries(patch) as [keyof Patch, Patch[keyof Patch]][];
  const sets = entries.map(
    ([key, value]) => sql`${sql.raw(COLUMN_OF[key])} = ${value ?? null}${sql.raw(CAST[key] ?? '')}`,
  );
  await tx.execute(sql`UPDATE employment_probation_assessments SET ${sql.join(sets, sql`, `)},
      revision = revision + 1, command_id = ${ctx.commandId}, updated_at = ${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND id=${before.id}::uuid`);
  const after = await loadAssessment(tx, ctx.tenantId, before.id);
  await auditAssessment(tx, ctx, action, before.id, assessmentView(before), assessmentView(after), before);
  return after;
}

export function auditAssessment(
  tx: Tx,
  ctx: EmploymentContext,
  action: string,
  id: string,
  before: unknown,
  after: unknown,
  owner: Pick<AssessmentRow, 'employeeId' | 'departmentId'>,
) {
  return auditEmployment(
    tx,
    ctx,
    `employment.assessment.${action}`,
    ASSESSMENT_AUDIT_TYPE,
    id,
    before,
    after,
    undefined,
    undefined,
    { employeeId: owner.employeeId, orgId: owner.departmentId },
  );
}

/** If-Match 比对（路由编辑用）。 */
export function assertAssessmentRevision(ctx: EmploymentContext, row: AssessmentRow) {
  assertRevision(ctx.expectedRevision, row.revision);
}
