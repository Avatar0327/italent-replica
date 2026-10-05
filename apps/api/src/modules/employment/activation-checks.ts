/**
 * 定时生效的失败判定（DEC-052），全部集中在此：先按生效日校验调入部门 / 职位，再经编制单一判定入口（DEC-145：
 * R1-T09 前不检查编制），然后在保存点内经 activate 端口落地；
 * 业务规则拒绝记为生效失败（申请单仍为审批通过，失败时联动一律不执行），存储或依赖不可用则原样抛出、不记失败，
 * 由下一次运行重新尝试（AGENTS.md §10：业务失败与存储不可写 / 结果未知分开处理）。
 * TODO(需取证 Q-M0-48)：原站到期当天是否再校验（目标组织 / 职位停用、编制不足）、失败如何表现，待 10-10 回查；
 * 原站很可能没有失败分支（`08` §17），本判定为复刻自定，取证后只需调整本文件。
 */
import type { Tx } from '@italent/db';
import type { OrgId } from '@italent/domain';
import { AppError, type ErrorCode } from '../../errors.js';
import { createTxOrgHierarchyReader } from '../establishment/org-reader.js';
import { loadJobObject } from '../job/read-model.js';
import type { PendingActivation } from './activation-store.js';
import { EmploymentError } from './errors.js';
import { transitionEmployment } from './transitions.js';
import type { BusinessKind, EmploymentContext } from './types.js';

export interface ActivationFailure {
  readonly reason: 'TARGET_ORG_DISABLED' | 'TARGET_POSITION_DISABLED' | 'ESTABLISHMENT_EXCEEDED' | 'RULE_REJECTED';
  readonly detail: Record<string, unknown>;
}

export interface ActivationTarget {
  readonly businessId: string;
  readonly employeeId: string;
  readonly kind: BusinessKind;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly effectiveDate: string;
}

/** 编制单一判定入口：定时生效与调动保存（R1-T09）共用同一口径，按严格控制判定调入是否超编。 */
export interface EmploymentActivationChecks {
  establishmentExceeded(tx: Tx, ctx: EmploymentContext, target: ActivationTarget): Promise<boolean>;
}

/**
 * DEC-145：定时生效的“编制不足”检查延到 R1-T09 随调动一并接入。生产装配下**暂不检查编制**（到期生效不查编制，
 * 与当前直接调动不查编制一致），这不是已实现的编制校验；失败框架（记录 / 待办 / 重试 / 挂起）已由停用校验与
 * 测试注入的判定覆盖（AC-TRF-31 的 R1-T08 段）。
 * TODO(R1-T09, DEC-145)：编制↔任职人员桥（Q-M0-15）接入后，在装配处注册编制模块的严格控制判定
 * （establishment/transfer-service 的到期再校验），并补 AC-TRF-31 的 R1-T09 段：真实满编 → 失败 → 调整编制 → 重试。
 */
export const ESTABLISHMENT_CHECK_DEFERRED: EmploymentActivationChecks = { establishmentExceeded: async () => false };

let checks: EmploymentActivationChecks = ESTABLISHMENT_CHECK_DEFERRED;

export function registerEmploymentActivationChecks(implementation: EmploymentActivationChecks): void {
  checks = implementation;
}

/** 业务规则拒绝：按租户数据确定的结果，重跑也不会变，记为失败交 HR 修正。 */
const RULE_REJECTIONS = new Set<ErrorCode>([
  'VALIDATION_FAILED',
  'CONFLICT',
  'NOT_FOUND',
  'LINKED_RECORD_OUT_OF_SCOPE',
  'PAYLOAD_TOO_LARGE',
]);

function ruleRejection(error: unknown): ActivationFailure | null {
  if (error instanceof EmploymentError) {
    return { reason: 'RULE_REJECTED', detail: { code: error.code, message: error.message } };
  }
  if (error instanceof AppError && RULE_REJECTIONS.has(error.code)) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason;
    return { reason: 'RULE_REJECTED', detail: { code: error.code, message: error.message, rule: reason ?? null } };
  }
  return null;
}

async function precheck(tx: Tx, ctx: EmploymentContext, item: PendingActivation): Promise<ActivationFailure | null> {
  const { id: businessId, employeeId, kind, departmentId, positionId, effectiveDate } = item;
  const orgEnabled = (orgId: string) =>
    createTxOrgHierarchyReader(tx).isEnabled({ tenantId: ctx.tenantId, orgId: orgId as OrgId, asOf: effectiveDate });
  if (departmentId && !(await orgEnabled(departmentId)))
    return { reason: 'TARGET_ORG_DISABLED', detail: { departmentId } };
  if (positionId && !(await loadJobObject(tx, ctx.tenantId, 'positions', positionId, effectiveDate)))
    return { reason: 'TARGET_POSITION_DISABLED', detail: { positionId } };
  const target = { businessId, employeeId, kind, departmentId, positionId, effectiveDate };
  if (departmentId && (await checks.establishmentExceeded(tx, ctx, target)))
    return { reason: 'ESTABLISHMENT_EXCEEDED', detail: { departmentId } };
  return null;
}

/**
 * 校验并经 activate 端口落地（同事务完成向后更新、审计、outbox）。返回失败原因；成功返回 null。
 * 落地放在保存点里：规则拒绝时只回滚这一条，调用方在同一事务内记失败与挂起。
 */
export async function activateWithJudgement(
  tx: Tx,
  ctx: EmploymentContext,
  item: PendingActivation,
): Promise<ActivationFailure | null> {
  const failure = await precheck(tx, ctx, item);
  if (failure) return failure;
  try {
    await tx.transaction((savepoint) =>
      transitionEmployment(savepoint, { ...ctx, expectedRevision: item.revision }, { id: item.id, action: 'activate' }),
    );
    return null;
  } catch (error) {
    const rejected = ruleRejection(error);
    if (!rejected) throw error;
    return rejected;
  }
}
