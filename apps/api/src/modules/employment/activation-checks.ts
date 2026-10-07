import { postponeLateTransfer } from './late-transfer.js';
import { resolveLateExecution, tenantLocalDate } from '@italent/domain';
import { employmentDepartmentDisable } from '../org/employment-validity.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness } from './record-store.js';
import { loadEmploymentRecord } from './read-model.js';
import { applyTransferLinkage } from './transfer-linkage.js';
/**
 * 定时生效的失败判定（DEC-052），全部集中在此：先按生效日校验调入部门 / 职位，再经编制单一判定入口（DEC-145：
 * 保存与到期使用真实任职占编投影），然后在保存点内经 activate 端口落地；
 * 业务规则拒绝记为生效失败（申请单仍为审批通过，失败时联动一律不执行），存储或依赖不可用则原样抛出、不记失败，
 * 由下一次运行重新尝试（AGENTS.md §10：业务失败与存储不可写 / 结果未知分开处理）。
 * TODO(需取证 Q-M0-48)：原站到期当天是否再校验（目标组织 / 职位停用、编制不足）、失败如何表现，待 10-10 回查；
 * 原站很可能没有失败分支（`08` §17），本判定为复刻自定，取证后只需调整本文件。
 */
import { employmentEstablishmentExceeded } from '../establishment/employment-check.js';
import type { Tx } from '@italent/db';
import type { OrgId } from '@italent/domain';
import { AppError, type ErrorCode } from '../../errors.js';
import { createTxOrgHierarchyReader } from '../establishment/org-reader.js';
import { loadJobObject } from '../job/read-model.js';
import type { PendingActivation } from './activation-store.js';
import { EmploymentError } from './errors.js';
import { transitionEmployment } from './transitions.js';
import type { BusinessKind, EmploymentContext, PresetFields } from './types.js';

export interface ActivationFailure {
  readonly reason:
    | 'TARGET_ORG_DISABLED'
    | 'TARGET_POSITION_DISABLED'
    | 'ESTABLISHMENT_EXCEEDED'
    | 'RULE_REJECTED'
    /** DEC-278③：迟到执行区间内另有记录，需重建、待 HR 处理（late-transfer.ts）。 */
    | 'REBUILD_REQUIRED';
  readonly detail: Record<string, unknown>;
}

export interface ActivationTarget {
  /** 回退调编时只验证剩余占用，不把被删除业务再次投影为调入。 */
  readonly occupancyOnly?: boolean;
  /**
   * 这次写入是否真的会向后更新其后的记录（设计 §4，S1-P2-04）：false 时容量判定不模拟其后组织调整随之传播——
   * 历史任职的编辑（单条 / 批量 / 导入编辑）与新增导入选“不向后更新”都不传播，占编只到下一条记录。缺省视为会传播。
   */
  readonly propagates?: boolean;
  readonly reconcileCarried?: boolean;
  readonly fields?: Partial<PresetFields>;
  readonly businessId: string;
  readonly employeeId: string;
  readonly kind: BusinessKind;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  readonly effectiveDate: string;
  /** 占编只到这一天之前（不含）；不给则到编制周期末。删除任职恢复前一条区间时按实际区间判断（R1-T11）。 */
  readonly until?: string | null;
}

/** 编制单一判定入口：定时生效与调动保存（R1-T09）共用同一口径，按严格控制判定调入是否超编。 */
export interface EmploymentActivationChecks {
  establishmentExceeded(tx: Tx, ctx: EmploymentContext, target: ActivationTarget): Promise<boolean>;
}

/** 默认生产实现；测试可注入同一判定入口。 */
export const DEFAULT_ESTABLISHMENT_CHECKS: EmploymentActivationChecks = {
  establishmentExceeded: employmentEstablishmentExceeded,
};
let checks: EmploymentActivationChecks = DEFAULT_ESTABLISHMENT_CHECKS;
export function registerEmploymentActivationChecks(implementation: EmploymentActivationChecks): void {
  checks = implementation;
}
export function establishmentExceeded(tx: Tx, ctx: EmploymentContext, target: ActivationTarget): Promise<boolean> {
  return checks.establishmentExceeded(tx, ctx, target);
}
export interface EstablishmentWarning {
  readonly businessId: string;
  readonly reason: 'ESTABLISHMENT_EXCEEDED';
}
export async function assertEstablishmentCapacity(
  tx: Tx,
  ctx: EmploymentContext,
  target: ActivationTarget,
  warnings?: EstablishmentWarning[],
) {
  if (!(await establishmentExceeded(tx, ctx, target))) return;
  // DEC-015 仅内部导入端口提供警告收集器；HTTP 单笔保存与定时生效不能关闭严格校验。
  if (warnings) {
    if (!warnings.some((item) => item.businessId === target.businessId))
      warnings.push({ businessId: target.businessId, reason: 'ESTABLISHMENT_EXCEEDED' });
    return;
  }
  throw new AppError('CONFLICT', '已超出设定编制，不可继续操作', { reason: 'ESTABLISHMENT_EXCEEDED' });
}

/** 业务规则拒绝：按租户数据确定的结果，重跑也不会变，记为失败交 HR 修正。 */
const RULE_REJECTIONS = new Set<ErrorCode>([
  'VALIDATION_FAILED',
  'CONFLICT',
  'NOT_FOUND',
  'LINKED_RECORD_OUT_OF_SCOPE',
  'PAYLOAD_TOO_LARGE',
  'ORG_FUTURE_VERSION_EXISTS',
]);

export function ruleRejection(error: unknown): ActivationFailure | null {
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
  const { id: businessId, employeeId, kind } = item;
  // DEC-186 / DEC-272：调动按实际执行日对齐（共用判定函数）；其他业务按原生效日。
  const effectiveDate =
    kind === 'transfer'
      ? resolveLateExecution({
          plannedEffectiveDate: item.effectiveDate,
          executionDate: tenantLocalDate(ctx.now, ctx.timezone),
        }).effectiveDate
      : item.effectiveDate;
  const record = item.materialized ? await loadEmploymentRecord(tx, ctx.tenantId, businessId, effectiveDate) : null;
  const departmentId = record ? record.fields.departmentId : item.departmentId;
  const positionId = record ? record.fields.positionId : item.positionId;
  const orgEnabled = (orgId: string) =>
    createTxOrgHierarchyReader(tx).isEnabled({ tenantId: ctx.tenantId, orgId: orgId as OrgId, asOf: effectiveDate });
  if (departmentId && !(await orgEnabled(departmentId)))
    return { reason: 'TARGET_ORG_DISABLED', detail: { departmentId } };
  if (item.materialized && departmentId) {
    const disabled = await employmentDepartmentDisable(tx, ctx.tenantId, departmentId, effectiveDate);
    if (disabled) return { reason: 'TARGET_ORG_DISABLED', detail: { departmentId, disabledOn: disabled.disabledOn } };
  }
  if (positionId && !(await loadJobObject(tx, ctx.tenantId, 'positions', positionId, effectiveDate)))
    return { reason: 'TARGET_POSITION_DISABLED', detail: { positionId } };
  const target = { businessId, employeeId, kind, departmentId, positionId, effectiveDate, fields: record?.fields };
  if (departmentId && (await establishmentExceeded(tx, ctx, target)))
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
  // 定时生效与重试都属于迟到执行：联动按实际执行日对齐（DEC-186，transfer/linkage/execute.ts）。
  ctx = { ...ctx, deferredExecution: true };
  try {
    return await tx.transaction(async (savepoint) => {
      // org/locks.ts：预检可能取组织 / 编制锁，先锁已有业务；员工闭包已由调度 / 重试入口锁定。
      const business = await lockEmploymentBusiness(savepoint, { ...ctx, expectedRevision: item.revision }, item.id);
      if (item.materialized && item.kind === 'transfer') {
        await postponeLateTransfer(savepoint, ctx, business);
        if (item.reminderOnly && item.effectiveDate < tenantLocalDate(ctx.now, ctx.timezone))
          await bumpEmploymentBusiness(savepoint, ctx, business);
      }
      const failure = await precheck(savepoint, ctx, item);
      if (failure) throw new AppError('CONFLICT', '生效条件不满足', { activationFailure: failure });
      if (!item.reminderOnly)
        await (item.materialized
          ? activateMaterializedLinkage(savepoint, ctx, item)
          : transitionEmployment(
              savepoint,
              { ...ctx, expectedRevision: item.revision },
              { id: item.id, action: 'activate' },
            ));
      return null;
    });
  } catch (error) {
    const failure = activationFailureOf(error) ?? ruleRejection(error);
    if (!failure) throw error;
    return failure;
  }
}

/** 预检与迟到判定以 activationFailure 细节抛出的业务失败（late-transfer.ts、precheck）；其他错误返回 null。 */
export function activationFailureOf(error: unknown): ActivationFailure | null {
  if (
    error instanceof AppError &&
    error.details &&
    typeof error.details === 'object' &&
    'activationFailure' in error.details
  )
    return error.details.activationFailure as ActivationFailure;
  return null;
}

/** 直接未来调动已有任职记录：联动完成同样推进业务/员工 revision，旧页面不能沿用生效前版本提交。 */
async function activateMaterializedLinkage(tx: Tx, ctx: EmploymentContext, item: PendingActivation) {
  const business = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: item.revision }, item.id);
  await applyTransferLinkage(tx, ctx, item.id);
  await bumpEmploymentBusiness(tx, ctx, business);
}
