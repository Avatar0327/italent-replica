/**
 * 离职后续任务端口的叶模块（F-512）：事件类型、订阅登记表与 run*Hooks 触发函数，原在 exit-confirmation.ts。
 * 订阅方（交接自动发起、自动加黑、作废在途评估、其他在途流程终止等）在各自模块顶层调用 exitPostEffectHooks.onXxx(...)，
 * 而 exit-confirmation 位于“审批引擎 ↔ 任职上下文”的导入环上：订阅方若以它为首个入口之外的路径先被求值，顶层读到的
 * exitPostEffectHooks 尚未初始化（TypeError）。本文件只依赖类型，不在环上，顶层订阅一律从这里取。
 * exit-confirmation 对原名再导出，既有调用方不变。
 */
import type { Tx } from '@italent/db';
import type { EmploymentContext } from './types.js';

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

export async function runExitConfirmedHooks(tx: Tx, ctx: EmploymentContext, event: ExitConfirmedEvent) {
  for (const hook of confirmedHooks) await hook(tx, ctx, event);
}
