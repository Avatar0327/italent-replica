/**
 * 员工名下的在途考核（F-229，DEC-617）：离职预览 / 保存确认 / 生效作废三处共用这一个查询与这一份提示文案（DEC-431①）。
 * 在途 = 审批中（in_review）与已驳回待重提（rejected，实例仍是 returned、发起人手上有重提待办）；已通过、不通过、已作废
 * 都是终态，不在其内。排序固定按考核 ID 升序，生效时据此加锁，与审批回调“员工 → 考核记录 → 审批实例”的锁序一致。
 */
import { sql, type Tx } from '@italent/db';
import { ASSESSMENT_TYPES, type AssessmentStatus, type AssessmentType } from '@italent/domain';
import { rowsOf } from './record-store.js';

export const IN_FLIGHT_ASSESSMENT_STATUSES = ['in_review', 'rejected'] as const;

export interface InFlightAssessment {
  readonly id: string;
  readonly assessmentType: AssessmentType;
  readonly assessmentName: string;
  readonly assessmentDate: string;
  readonly status: AssessmentStatus;
  readonly departmentId: string | null;
}

/** lock = true：按考核 ID 升序逐行 FOR UPDATE（调用方须已持员工行锁）。 */
export async function inFlightAssessments(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  lock = false,
): Promise<InFlightAssessment[]> {
  return rowsOf<InFlightAssessment>(
    await tx.execute(sql`SELECT id::text AS id, assessment_type AS "assessmentType",
        assessment_name AS "assessmentName", assessment_date::text AS "assessmentDate", status,
        department_id::text AS "departmentId"
      FROM employment_probation_assessments
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
        AND status = ANY(${`{${IN_FLIGHT_ASSESSMENT_STATUSES.join(',')}}`}::text[])
      ORDER BY id ${lock ? sql`FOR UPDATE` : sql``}`),
  );
}

/**
 * 提示文案（DEC-617 原文）：“存在审批中的××考核流程，离职生效后会终止作废该流程”；已驳回待重提的写“已驳回的”。
 * typeVisible = false（看不到考核类型字段）时不带类型名，避免经提示披露。
 */
export function assessmentVoidNotice(row: Pick<InFlightAssessment, 'status' | 'assessmentType'>, typeVisible = true) {
  const state = row.status === 'in_review' ? '审批中的' : '已驳回的';
  const type = typeVisible ? ASSESSMENT_TYPES[row.assessmentType] : '考核';
  return `存在${state}${type}流程，离职生效后会终止作废该流程`;
}
