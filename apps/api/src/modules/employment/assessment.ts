/**
 * 试用期考核：发起、审批后编辑与审批中编辑（R2 BE-15b1；docs/02_业务建模/29 PB-R3～R6、PB-R9，差距表 B2）。
 * - 发起（手动，选人批量）：每人一条独立考核 + 一条独立审批流程（员工自评 → 经理评价），各在自己的保存点里办理，
 *   单人失败（范围外、不在试用中、PB-R9 互斥、没有匹配的流程等）只记在他的回执里，不影响其他人；
 * - 审批通过后 HR 可改考核内容与转正意见（PB-R6）：只改考核记录，不补生成、不修改已生成的转正任职记录；
 * - 审批中编辑（同意按钮关联编辑）由审批中心经适配器调用 applyApprovalEdit，同一套字段解析与跨字段校验。
 */
import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import {
  assessmentOpinionViolation,
  ASSESSMENT_NAME_MAX,
  ASSESSMENT_OPINION_CODES,
  ASSESSMENT_RATING_CODES,
  ASSESSMENT_TEXT_MAX,
  ASSESSMENT_TYPE_CODES,
  EMPLOYEE_STATUS,
  MAX_BATCH_ASSESSMENT,
  tenantLocalDate,
  type AssessmentType,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import {
  assertAssessmentRevision,
  auditAssessment,
  loadAssessment,
  requireAssessmentInScope,
  saveAssessment,
  type AssessmentRow,
} from './assessment-store.js';
import { requireEmployeeInScope } from './context.js';
import { loadProbationCycle } from './probation.js';
import { assertProbationProcessesIdle } from './probation-guard.js';
import { findCurrentRecord } from './read-model.js';
import { bumpEmploymentEmployee, lockEmploymentEmployee } from './record-store.js';
import type { EmploymentContext } from './types.js';

const date = z.iso.date();
const text = z.string().max(ASSESSMENT_TEXT_MAX);

const batchSchema = z.strictObject({
  assessmentType: z.enum(ASSESSMENT_TYPE_CODES),
  assessmentName: z.string().trim().min(1).max(ASSESSMENT_NAME_MAX),
  assessmentDate: date,
  items: z
    .array(z.strictObject({ employeeId: z.string().refine(isUuid), revision: z.int().min(0) }))
    .min(1)
    .max(MAX_BATCH_ASSESSMENT),
});
export type AssessmentBatchInput = z.infer<typeof batchSchema>;

/** 考核字段的修改（HR 审批后修改与审批中编辑共用）：严格对象，至少一项；可清空的字段允许 null。 */
const patchSchema = z.strictObject({
  assessmentName: z.string().trim().min(1).max(ASSESSMENT_NAME_MAX).optional(),
  assessmentDate: date.optional(),
  selfEvaluation: text.nullable().optional(),
  managerRating: z.enum(ASSESSMENT_RATING_CODES).nullable().optional(),
  regularizationOpinion: z.enum(ASSESSMENT_OPINION_CODES).nullable().optional(),
  regularizationDate: date.nullable().optional(),
});
export type AssessmentPatch = z.infer<typeof patchSchema>;

export function parseAssessmentBatch(raw: unknown): AssessmentBatchInput {
  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      'VALIDATION_FAILED',
      `发起考核须填写类型、考核名称、考核日期与 1～${MAX_BATCH_ASSESSMENT} 名员工`,
      parsed.error.issues,
    );
  const ids = parsed.data.items.map((item) => item.employeeId.toLowerCase());
  if (new Set(ids).size !== ids.length)
    throw new AppError('VALIDATION_FAILED', '同一员工不能在一次发起中重复出现', { reason: 'DUPLICATE_EMPLOYEE' });
  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => ({ ...item, employeeId: item.employeeId.toLowerCase() })),
  };
}

export function parseAssessmentPatch(raw: unknown): AssessmentPatch {
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success || !Object.keys(parsed.data).length)
    throw new AppError('VALIDATION_FAILED', '考核字段不合法', parsed.success ? undefined : parsed.error.issues);
  return parsed.data;
}

export interface AssessmentReceiptItem {
  readonly employeeId: string;
  readonly status: 'succeeded' | 'failed';
  readonly assessmentId: string | null;
  readonly assessmentStatus: string | null;
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } | null;
}

/** 试用中的员工才可考核（PB-R19 同口径：当前生效主职为试用状态），返回开启本周期试用的记录与主职部门。 */
async function assessmentSubject(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const cycle = await loadProbationCycle(tx, ctx.tenantId, employeeId, today);
  const current = await findCurrentRecord(tx, ctx.tenantId, employeeId, today);
  if (!cycle || !current || current.employeeStatus !== EMPLOYEE_STATUS.probation)
    throw new AppError('CONFLICT', '只有试用中的员工可以发起考核', { reason: 'ASSESSMENT_NOT_PROBATION' });
  return { anchorId: cycle.anchor.id, departmentId: current.fields.departmentId ?? null };
}

export interface AssessmentLaunch {
  readonly employeeId: string;
  readonly assessmentType: AssessmentType;
  readonly assessmentName: string;
  readonly assessmentDate: string;
  /** manual = 选人手动发起（带员工 revision 做 If-Match）；auto = BE-15b2 自动发起（系统代发，ctx.userId 是规则发起人）。 */
  readonly initiation: 'manual' | 'auto';
  readonly revision?: number;
}

/**
 * 发起一条考核（手动批量与 BE-15b2 自动发起共用的单一入口）：调用方在保存点内调用，已按需判过范围。
 * 锁员工 → 试用中判定 → PB-R9 互斥 → 建考核 → 与审批中心同事务提交审批；任一步失败整条回滚由调用方保存点承担。
 */
export async function launchAssessment(tx: Tx, ctx: EmploymentContext, launch: AssessmentLaunch) {
  const employee = await lockEmploymentEmployee(tx, ctx, launch.employeeId, launch.revision);
  const subject = await assessmentSubject(tx, ctx, employee.id);
  // PB-R9：发起也受互斥与并行规则约束（和直接转正、转正申请同一检查点）
  await assertProbationProcessesIdle(tx, ctx, {
    employeeId: employee.id,
    action: launch.assessmentType === 'probation' ? 'assess_probation' : 'assess_regularization',
  });
  const id = randomUUID();
  const auto = launch.initiation === 'auto';
  await tx.execute(sql`INSERT INTO employment_probation_assessments(id, tenant_id, employee_id, anchor_id,
      department_id, assessment_type, assessment_name, assessment_date, status, initiation, initiator_user_id,
      system_proxy, revision, command_id, created_at, updated_at)
    VALUES (${id}::uuid, ${ctx.tenantId}, ${employee.id}::uuid, ${subject.anchorId}::uuid,
      ${subject.departmentId}::uuid, ${launch.assessmentType}, ${launch.assessmentName},
      ${launch.assessmentDate}::date, 'in_review', ${launch.initiation}, ${ctx.userId}::uuid, ${auto}, 1,
      ${ctx.commandId}, ${ctx.now.toISOString()}::timestamptz, ${ctx.now.toISOString()}::timestamptz)`);
  const created = await loadAssessment(tx, ctx.tenantId, id);
  await auditAssessment(tx, ctx, 'create', id, null, created, created);
  await bumpEmploymentEmployee(tx, ctx, employee);
  // 与审批中心同事务：没有匹配的流程、首节点审批人为空时整人回滚，考核不创建（DEC-017 / DEC-054）；
  // 自动发起的审批发起日志带“系统代发”标记（R2e7）
  await employmentApprovalHooks.assessmentSubmitted(tx, auto ? { ...ctx, systemProxy: true } : ctx, id);
  return created;
}

async function createOne(
  tx: Tx,
  ctx: EmploymentContext,
  input: AssessmentBatchInput,
  item: AssessmentBatchInput['items'][number],
) {
  // 范围外与不存在同一个 404（DEC-177 写入口径），在本人保存点内判定
  await requireEmployeeInScope(tx, ctx, item.employeeId);
  return launchAssessment(tx, ctx, {
    employeeId: item.employeeId,
    assessmentType: input.assessmentType,
    assessmentName: input.assessmentName,
    assessmentDate: input.assessmentDate,
    initiation: 'manual',
    revision: item.revision,
  });
}

/** 选人批量发起（PB-R3）：每人一条独立考核与审批流程，回执逐人。 */
export async function createAssessments(tx: Tx, ctx: EmploymentContext, input: AssessmentBatchInput) {
  const receipts = new Map<string, AssessmentReceiptItem>();
  // 按员工 ID 顺序逐人取锁（同批量转正的锁序），并发的两单不会交叉等待；回执仍按请求顺序
  for (const item of [...input.items].sort((a, b) => a.employeeId.localeCompare(b.employeeId))) {
    try {
      const created = await tx.transaction((savepoint) => createOne(savepoint, ctx, input, item));
      receipts.set(item.employeeId, {
        employeeId: item.employeeId,
        status: 'succeeded',
        assessmentId: created.id,
        assessmentStatus: created.status,
        error: null,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      receipts.set(item.employeeId, {
        employeeId: item.employeeId,
        status: 'failed',
        assessmentId: null,
        assessmentStatus: null,
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
  }
  const items = input.items.map((item) => receipts.get(item.employeeId)!);
  const succeeded = items.filter((item) => item.status === 'succeeded').length;
  return { total: items.length, succeeded, failed: items.length - succeeded, items };
}

/** 合并后的跨字段校验：提前 / 延期转正须有转正日期（PB-R4 / R5）。 */
export function mergedPatch(row: AssessmentRow, patch: AssessmentPatch) {
  const merged = {
    type: row.assessmentType as AssessmentType,
    opinion: patch.regularizationOpinion === undefined ? row.regularizationOpinion : patch.regularizationOpinion,
    regularizationDate: patch.regularizationDate === undefined ? row.regularizationDate : patch.regularizationDate,
  };
  const violation = assessmentOpinionViolation(merged);
  if (violation) throw new AppError('VALIDATION_FAILED', violation.message, { reason: violation.reason });
  return patch;
}

function assertEditable(row: AssessmentRow, status: AssessmentRow['status']) {
  if (row.status === status) return;
  const inReview = row.status === 'in_review';
  throw new AppError('CONFLICT', inReview ? '考核审批中，请在审批节点编辑' : '只有审批通过的考核可以修改', {
    reason: inReview ? 'ASSESSMENT_IN_APPROVAL' : 'ASSESSMENT_NOT_EDITABLE',
    status: row.status,
  });
}

/**
 * PB-R6：审批通过后 HR 改考核内容与转正意见——只改考核记录，不补生成、不修改已生成的转正任职记录；
 * 状态不变，If-Match = 考核 revision。
 */
export async function updateAssessment(tx: Tx, ctx: EmploymentContext, id: string, raw: unknown) {
  const patch = parseAssessmentPatch(raw);
  const row = await loadAssessment(tx, ctx.tenantId, id, true);
  await requireAssessmentInScope(tx, ctx, row);
  assertAssessmentRevision(ctx, row);
  assertEditable(row, 'approved');
  return saveAssessment(tx, ctx, row, mergedPatch(row, patch), 'update');
}

/** 审批中编辑（适配器 edit）：节点可编辑字段已由审批中心限定，这里解析取值并做同样的跨字段校验。 */
export async function applyApprovalEdit(tx: Tx, ctx: EmploymentContext, id: string, raw: unknown) {
  const patch = parseAssessmentPatch(raw);
  const row = await loadAssessment(tx, ctx.tenantId, id, true);
  assertEditable(row, 'in_review');
  return saveAssessment(tx, ctx, row, mergedPatch(row, patch), 'approval_edit');
}
