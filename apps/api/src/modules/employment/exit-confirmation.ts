/**
 * 离职 / 退休 confirmed 阶段（R2-T03 设计 §3.1，退休 R2-T04 §3.3 同一函数）：申请最后节点同意、直接离职保存时调用，与该动作同事务。
 * 写编制预减时点 R（exit_requests.pre_release_date，DEC-266①）与预减台账（establishment/exit-release.ts），
 * 再通知 confirmed 端口的订阅方（交接自动发起属 BE-8b，DM-R14：只对申请）。本函数不落地（调用方随后 activateIfDue）。
 * approval_passed 时机的职责转交也在这里执行（§5.7）；计划须在调用本函数之前已写入联动版本。
 */
import { and, eq, exitRequests, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { registerEstablishmentPreRelease } from '../establishment/exit-release.js';
import { auditEmployment } from './context.js';
import { runExitDutyTransfer } from './exit-duty-transfer.js';
import { loadExitRequest } from './exit-gate.js';
import { loadEmploymentBusiness } from './read-model.js';
import { loadRetirementRequest } from './retirement-application.js';
import type { EmploymentContext } from './types.js';
import { queueExitAccount } from './exit-account-store.js';
import { runExitConfirmedHooks } from './exit-post-effect-hooks.js';

export {
  exitPostEffectHooks,
  runExitCancelledHooks,
  runExitEffectiveHooks,
  runExitReplannedHooks,
} from './exit-post-effect-hooks.js';
export type {
  ExitActivationSource,
  ExitCancelCase,
  ExitCancelledEvent,
  ExitConfirmedEvent,
  ExitEffectiveEvent,
  ExitReplannedEvent,
} from './exit-post-effect-hooks.js';

/** 进入 confirmed 阶段的离职单：业务 ID、员工、计划生效日 E、办理方式。 */
export interface ConfirmedExit {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly mode: 'application' | 'direct';
  /** 缺省离职（既有调用方不变）。 */
  readonly kind?: 'leave' | 'retirement';
}

export async function confirmExit(tx: Tx, ctx: EmploymentContext, business: ConfirmedExit) {
  const exit = await loadExitRequest(tx, ctx.tenantId, business.id);
  if (!exit) return;
  await queueExitAccount(tx, ctx, business.id);
  // R 一经写入不再改变（迟到顺延、重试都不改），已有 R 说明预减与端口订阅已执行过
  if (!exit.preReleaseDate) await registerPreRelease(tx, ctx, business);
  // approval_passed 时机的职责转交（§5.7）：生效日 = 批准 / 保存当天；联动执行行保证至多执行一次
  await runExitDutyTransfer(tx, ctx, exit, 'confirmed', tenantLocalDate(ctx.now, ctx.timezone));
}

async function registerPreRelease(tx: Tx, ctx: EmploymentContext, business: ConfirmedExit) {
  const releasedFrom = tenantLocalDate(ctx.now, ctx.timezone);
  const where = and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, business.id));
  await tx.update(exitRequests).set({ preReleaseDate: releasedFrom }).where(where);
  // 部门 / 职位取按继承解析后的值（与审批快照同一读模型），载荷里未填的字段从前一条任职带出
  const resolved = await loadEmploymentBusiness(tx, ctx.tenantId, business.id, releasedFrom);
  const effects = await registerEstablishmentPreRelease(tx, ctx, {
    businessId: business.id,
    employeeId: business.employeeId,
    departmentId: resolved?.fields.departmentId ?? null,
    positionId: resolved?.fields.positionId ?? null,
    releasedFrom,
    plannedEffectiveDate: business.effectiveDate,
  });
  await auditEmployment(
    tx,
    ctx,
    'exit.establishment.pre_released',
    'exit-request',
    business.id,
    { preReleaseDate: null },
    { preReleaseDate: releasedFrom, effects },
    undefined,
    undefined,
    { employeeId: business.employeeId },
  );
  // DM-R14：交接自动发起只对离职申请审批通过调用，直接离职的 confirmed 阶段不调用，交接只能手工发起
  if (business.mode !== 'application') return;
  const kind = business.kind ?? 'leave';
  const reEmployed = kind === 'retirement' ? await retirementReEmployed(tx, ctx, business.id) : false;
  const event = {
    businessId: business.id,
    employeeId: business.employeeId,
    mode: business.mode,
    kind,
    reEmployed,
  };
  await runExitConfirmedHooks(tx, ctx, event);
}

const retirementReEmployed = async (tx: Tx, ctx: EmploymentContext, businessId: string) =>
  (await loadRetirementRequest(tx, ctx.tenantId, businessId))?.reEmployed === true;
