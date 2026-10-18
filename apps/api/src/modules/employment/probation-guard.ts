/**
 * 试用期流程互斥（docs/02_业务建模/29 PB-R9，§8 AC-PB-03）：同一员工有转正流程在审批中时，不能再提交转正申请、
 * 直接转正或调整试用期。拦截在提交 / 保存时，不在打开表单时（草稿照常保存）。
 * 单一入口 + 可登记检查点：转正申请审批中是内置检查；BE-15b1 把“试用中考核 / 转正考核在审批中”与“试用期考核
 * 并行规则”（出厂都关，assessment-guard.ts）按名称登记成检查点，对同一批入口统一生效。
 */
import { sql, type Tx } from '@italent/db';
import type { ProbationProcessAction } from '@italent/domain';
import { AppError } from '../../errors.js';
import { assessmentInReview } from './assessment-guard.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

/** regularize = 直接转正；apply = 提交转正申请；adjust = 调整试用信息；assess_* = 发起试用中考核 / 转正考核。 */
export type { ProbationProcessAction };

export interface ProbationProcessTarget {
  readonly employeeId: string;
  readonly action: ProbationProcessAction;
  /** 正在提交的那张申请：自己不拦自己。 */
  readonly businessId?: string;
}

/** 检查点：有冲突时抛 AppError（建议 409 + reason），无冲突直接返回。调用方已持该员工锁。 */
export type ProbationProcessCheck = (tx: Tx, ctx: EmploymentContext, target: ProbationProcessTarget) => Promise<void>;

const checks = new Map<string, ProbationProcessCheck>();

/** 按名称登记；同名登记另一实现视为装配错误。 */
export function registerProbationProcessCheck(name: string, check: ProbationProcessCheck): void {
  const existing = checks.get(name);
  if (existing && existing !== check) throw new Error(`试用期流程检查点 ${name} 已登记了另一个实现`);
  checks.set(name, check);
}

export const PROBATION_PROCESS_IN_REVIEW = 'PROBATION_PROCESS_IN_REVIEW';

async function regularizationInReview(tx: Tx, ctx: EmploymentContext, target: ProbationProcessTarget) {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT b.id FROM employment_business_objects b
      JOIN LATERAL (SELECT p.kind FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
        AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
      JOIN LATERAL (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
        AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${target.employeeId}::uuid
        AND p.kind='regularization' AND s.state='in_review'
        AND b.id IS DISTINCT FROM ${target.businessId ?? null}::uuid
      LIMIT 1`),
  );
  if (row)
    throw new AppError('CONFLICT', '该员工有审批中的转正申请，不能再发起转正或调整试用期', {
      reason: PROBATION_PROCESS_IN_REVIEW,
      process: 'regularization',
    });
}

/** 唯一入口：先内置的转正申请检查，再按名称顺序跑登记的检查点。 */
export async function assertProbationProcessesIdle(
  tx: Tx,
  ctx: EmploymentContext,
  target: ProbationProcessTarget,
): Promise<void> {
  await regularizationInReview(tx, ctx, target);
  for (const [, check] of [...checks.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) await check(tx, ctx, target);
}

// 检查点在本模块加载时登记：任何经 assertProbationProcessesIdle 的入口（含不挂路由的定时任务进程）都带上考核判定
registerProbationProcessCheck('assessment', assessmentInReview);
