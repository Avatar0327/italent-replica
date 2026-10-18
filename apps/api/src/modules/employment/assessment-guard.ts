/**
 * 试用期考核的 PB-R9 互斥检查点（docs/02_业务建模/29 PB-R9，AC-PB-03 / AC-PB-10）：试用中考核、转正考核任何一个在审批中，
 * 转正申请、直接转正、调整试用期和另一个考核都不能发起，除非“考核并行规则”放行：
 * - 并行规则有两个开关（试用中考核流程并行规则、转正考核流程并行规则），出厂都关；
 * - 开关打开后，勾选的“可发起流程”在对应考核审批中时仍可发起；调整试用期不是流程发起，不适用例外。
 * 登记在 probation-guard.ts 的检查点登记口（registerProbationProcessCheck），让直接转正、转正申请、调整试用期、
 * 自动转正（BE-15a）与新增的考核发起统一生效，不另开互斥判断。拦截在提交 / 保存时，不在打开表单时。
 */
import { sql, type Tx } from '@italent/db';
import {
  ASSESSMENT_TYPES,
  isParallelRuleValue,
  PARALLEL_RULE_DEFAULT,
  PARALLEL_RULE_KEYS,
  parallelAllows,
  processOfAction,
  type AssessmentType,
  type ParallelRule,
  type ParallelRuleBlocker,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import type { ProbationProcessCheck } from './probation-guard.js';
import { rowsOf } from './record-store.js';

/** 审批中的考核对应的并行规则开关。 */
const BLOCKER_OF: Readonly<Record<AssessmentType, ParallelRuleBlocker>> = {
  probation: 'probation_assessment',
  regularization: 'regularization_assessment',
};

/** 有效并行规则（两层配置，系统值出厂关闭）；取值不合法时按出厂关闭处理（fail-closed）。 */
export async function readParallelRule(tx: Tx, tenantId: string, blocker: ParallelRuleBlocker): Promise<ParallelRule> {
  const { value } = await readEffectiveSetting(tx, tenantId, PARALLEL_RULE_KEYS[blocker]);
  return isParallelRuleValue(blocker, value) ? value : PARALLEL_RULE_DEFAULT;
}

export const assessmentInReview: ProbationProcessCheck = async (tx, ctx, target) => {
  const rows = rowsOf<{ id: string; assessmentType: AssessmentType; assessmentName: string; assessmentDate: string }>(
    await tx.execute(sql`SELECT id::text AS id, assessment_type AS "assessmentType",
        assessment_name AS "assessmentName", assessment_date::text AS "assessmentDate"
      FROM employment_probation_assessments
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${target.employeeId}::uuid AND status='in_review'
      ORDER BY assessment_date, id`),
  );
  const process = processOfAction(target.action);
  for (const row of rows) {
    const rule = await readParallelRule(tx, ctx.tenantId, BLOCKER_OF[row.assessmentType]);
    if (parallelAllows(rule, process)) continue;
    // 原站提示“存在未完成的考核（日期、考核名称）”（§8 AC-PB-03），提交时拦截
    throw new AppError(
      'CONFLICT',
      `该员工存在未完成的${ASSESSMENT_TYPES[row.assessmentType]}（${row.assessmentDate}、${row.assessmentName}），` +
        '不能再发起转正、考核或调整试用期',
      { reason: 'PROBATION_PROCESS_IN_REVIEW', process: BLOCKER_OF[row.assessmentType], assessmentId: row.id },
    );
  }
};
