/**
 * 试用期考核记录的读取与状态落库（R2 BE-15b1；docs/02_业务建模/29 PB-R3～R6）。
 * 表 employment_probation_assessments 一行 = 一条考核（业务单）：审批回调与路由共用这里的加载、行锁、状态回写与审计。
 * 审计按字段级变更日志写（DEC-019），归属考核对象与其主职部门（audit/visibility 按员工 / 组织裁剪）。
 */
import { sql, type Tx } from '@italent/db';
import {
  PROBATION_ASSESSMENT_OBJECT,
  type AssessmentOpinion,
  type AssessmentRating,
  type AssessmentStatus,
  type AssessmentType,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { assertRevision, auditEmployment, employmentCreator, employmentScopePredicate } from './context.js';
import type { SQL } from 'drizzle-orm';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const ASSESSMENT_AUDIT_TYPE = 'probation-assessment';

// 考核按考核对象员工归属：组织类维度（管理单元 / 组织）的范围要带出“按人员”的关联谓词，否则人员集合为空、
// 正常的部门授权也办不了（BE-15b1 第 1 轮 P2-1）。在业务公共入口登记，路由、审批适配器与重提复核都经过本文件。
registerPersonScopedObject(PROBATION_ASSESSMENT_OBJECT);

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

/**
 * 考核的人员范围谓词（对别名 a）：以考核对象“当前”任职为准（人员 + 创建人维度，同 requireEmployeeInScope），不看创建时保存的
 * 部门快照。列表、详情、修改、重提共用这一个谓词（DEC-431①，BE-15b1 第 2 轮 P2-1：员工调动后列表与详情不能各判各的）。
 */
export function assessmentScopeSql(scope: EmploymentContext['scope'], tenantId: string): SQL {
  return employmentScopePredicate(
    scope,
    sql`a.employee_id`,
    undefined,
    employmentCreator(tenantId, sql`a.employee_id`),
  );
}

/** 列表：按创建先后倒序；先按范围谓词裁剪再分页（limit / offset）。 */
export async function listAssessments(
  tx: Tx,
  tenantId: string,
  filter: AssessmentFilter,
  scope: EmploymentContext['scope'],
  page: { readonly limit: number; readonly offset: number },
): Promise<AssessmentRow[]> {
  return rowsOf<AssessmentRow>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM employment_probation_assessments a
      WHERE a.tenant_id=${tenantId} AND ${assessmentScopeSql(scope, tenantId)}
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

/**
 * 考核在 ctx 的数据范围内（与列表同一个谓词 assessmentScopeSql）；范围外与考核不存在同一个 404「考核记录不存在」
 * （不泄露存在性，不能让“任职数据不存在”与“考核记录不存在”两种文案区分出考核存在）。
 */
export async function requireAssessmentInScope(
  tx: Tx,
  ctx: EmploymentContext,
  row: Pick<AssessmentRow, 'id'>,
): Promise<void> {
  if (!ctx.scope) return;
  const [hit] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT a.id FROM employment_probation_assessments a
      WHERE a.tenant_id=${ctx.tenantId} AND a.id=${row.id}::uuid AND ${assessmentScopeSql(ctx.scope, ctx.tenantId)}`),
  );
  if (!hit) throw new AppError('NOT_FOUND', '考核记录不存在');
}
