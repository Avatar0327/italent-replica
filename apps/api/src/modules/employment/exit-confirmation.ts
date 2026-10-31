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

export interface ExitConfirmedEvent {
  readonly businessId: string;
  readonly employeeId: string;
  readonly mode: 'application' | 'direct';
  /** 业务类型（R2-T04 §7.1）：交接单标题 / 审批类型按它取。 */
  readonly kind: 'leave' | 'retirement';
  /** 是否同时返聘（离职恒 false；5b 起退休可为 true，订阅方据此决定是否停用账号等）。 */
  readonly reEmployed: boolean;
}

type ConfirmedHook = (tx: Tx, ctx: EmploymentContext, event: ExitConfirmedEvent) => Promise<void>;
const confirmedHooks: ConfirmedHook[] = [];

/** 离职生效来源：审批通过 / 直接离职保存 / 免审批直接生效（DEC-593，BE-6b 结束实习）。 */
export type ExitActivationSource = 'approval' | 'direct' | 'free_direct';

export interface ExitEffectiveEvent {
  readonly businessId: string;
  readonly employeeId: string;
  readonly source: ExitActivationSource;
  readonly lastWorkDate: string;
  readonly effectiveDate: string;
  readonly kind: 'leave' | 'retirement';
  readonly reEmployed: boolean;
}

type EffectiveHook = (tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent) => Promise<void>;
const effectiveHooks: EffectiveHook[] = [];

/** 撤销的四种情况（设计 §7.1，exit_cancellations.cancel_case）。 */
export type ExitCancelCase = 'process_voided' | 'approved_voided' | 'record_deleted' | 'record_deleted_reinstated';

export interface ExitCancelledEvent {
  readonly businessId: string;
  readonly employeeId: string;
  readonly stateBefore: string;
  readonly case: ExitCancelCase;
  /** 业务类型（R2-T04 §6）：退休撤销的人事回写订阅方据此只处理退休。 */
  readonly kind: 'leave' | 'retirement';
}

type CancelledHook = (tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent) => Promise<void>;
const cancelledHooks: CancelledHook[] = [];

/** F-140：人工计划变更的唯一事务出口；F-261 在此登记账号处理任务。 */
export interface ExitReplannedEvent {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly businessId: string;
  readonly fromPlanned: string;
  readonly toPlanned: string;
  readonly versionNo: number;
  readonly supersedesBusinessId?: string;
}
type ReplannedHook = (tx: Tx, ctx: EmploymentContext, event: ExitReplannedEvent) => Promise<void>;
const replannedHooks: ReplannedHook[] = [];
export async function runExitReplannedHooks(tx: Tx, ctx: EmploymentContext, event: ExitReplannedEvent) {
  for (const hook of replannedHooks) await hook(tx, ctx, event);
}

/**
 * 离职后续任务端口（设计 §0 / §5.1 步骤 8）：confirmed 在审批通过 / 直接离职保存时调用（DM-R14 交接自动发起，BE-8）；
 * effective 在离职落地后调用。F-261 订阅方在同一事务内登记持久任务，提交后独立执行全局账号命令；
 * 账号停用失败不回滚离退休生效（DEC-684），事务内的登记失败仍随业务回滚。
 */
export const exitPostEffectHooks = {
  onReplanned(hook: ReplannedHook): void {
    replannedHooks.push(hook);
  },
  onConfirmed(hook: ConfirmedHook): void {
    confirmedHooks.push(hook);
  },
  onEffective(hook: EffectiveHook): void {
    effectiveHooks.push(hook);
  },
  /** 离职被撤销（B4，设计 §7.1）：BE-8 把已自动发起的交接置终止、回收自动加黑；与撤销同事务，默认没有订阅方。 */
  onCancelled(hook: CancelledHook): void {
    cancelledHooks.push(hook);
  },
};

export async function runExitCancelledHooks(tx: Tx, ctx: EmploymentContext, event: ExitCancelledEvent) {
  for (const hook of cancelledHooks) await hook(tx, ctx, event);
}

export async function runExitEffectiveHooks(tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent) {
  for (const hook of effectiveHooks) await hook(tx, ctx, event);
}

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
  for (const hook of confirmedHooks) await hook(tx, ctx, event);
}

const retirementReEmployed = async (tx: Tx, ctx: EmploymentContext, businessId: string) =>
  (await loadRetirementRequest(tx, ctx.tenantId, businessId))?.reEmployed === true;
