/**
 * 待入职 ↔ Offer 联动端口（F-192a；DEC-546 / DEC-548，docs/02_业务建模/34 EN-R9）。
 * employment 拥有本端口、不 import Offer 模块；Offer（BE-14）在装配时登记实现，未登记时是空实现（Offer 模块还没有）。
 *
 * 出站（employment → Offer，与取消 / 恢复同一事务，实现抛错则整笔回滚）：
 * - onEntryCancelled：待入职取消之后，BE-14 把该人员已接受的 Offer 改为已拒绝；
 * - onEntryRestored：已取消的待入职经“改期入职”恢复之后，BE-14 把 Offer 回到已接受。**不传新日期**：
 *   Offer 的拟入职日期保持原值，不跟着改期变（R2e9 / DEC-546）。
 * 普通改期（未取消 → 延期）、编辑、手动删除待入职都不调用这两个端口；失效 Offer 删除待入职走
 * entry-actions.ts 的 deletePendingEntry（F-171 / DEC-529），不进“已取消入职”，也不回调本端口。
 *
 * 入站（Offer → employment）：Offer 侧“拒绝已接受的 Offer”调用 entry-actions.ts 的 cancelPendingEntryForOfferRefusal，
 * 复用取消内核并**不再回调 onEntryCancelled**（Offer 已是已拒绝，避免循环）。
 *
 * 事件里的 businessId 是**调用后**该待入职记录的 ID：取消不换 ID；恢复走“删除并重建”内核，ID 会变，
 * 旧 ID 在 previousBusinessId。
 */
import type { Tx } from '@italent/db';
import type { EmployeeStatusHookContext } from './status-hooks.js';

export interface EntryCancelledEvent {
  readonly employeeId: string;
  /** 被取消的待入职记录（任职业务 ID，取消前后不变）。 */
  readonly businessId: string;
}

export interface EntryRestoredEvent {
  readonly employeeId: string;
  /** 恢复后的待入职记录（改期重建，新 ID）。 */
  readonly businessId: string;
  /** 恢复前处于“取消”的原记录。 */
  readonly previousBusinessId: string;
}

export interface EntryActionStartEvent {
  /** 即将被取消 / 改期的待入职记录。 */
  readonly businessId: string;
}

export interface EntryOfferHooks {
  /**
   * 取消 / 改期动作开始时、取任何员工 / 业务 / 组织锁之前调用（可选）：Offer 侧在这里先锁住关联的 Offer 行，使全系统的锁序
   * 统一为“Offer → 员工 → 业务 → 组织”（Offer 重发等先持 Offer 锁的路径不会与恢复路径成环，F-201 / BE-14b2 第 2 轮审查）。
   * 没有关联 Offer 时什么也不做。
   */
  beforeEntryAction?(tx: Tx, ctx: EmployeeStatusHookContext, event: EntryActionStartEvent): Promise<void>;
  onEntryCancelled(tx: Tx, ctx: EmployeeStatusHookContext, event: EntryCancelledEvent): Promise<void>;
  onEntryRestored(tx: Tx, ctx: EmployeeStatusHookContext, event: EntryRestoredEvent): Promise<void>;
}

const noop: EntryOfferHooks = {
  onEntryCancelled: async () => undefined,
  onEntryRestored: async () => undefined,
};

let hooks: EntryOfferHooks = noop;

/** Offer 模块（BE-14）在应用装配时登记；再次登记即替换。 */
export function registerEntryOfferHooks(implementation: EntryOfferHooks): void {
  hooks = implementation;
}

/** 仅供测试复位为空实现。 */
export function resetEntryOfferHooksForTest(): void {
  hooks = noop;
}

const narrow = (ctx: EmployeeStatusHookContext): EmployeeStatusHookContext => ({
  tenantId: ctx.tenantId,
  userId: ctx.userId,
  timezone: ctx.timezone,
  now: ctx.now,
  commandId: ctx.commandId,
});

/** employment 内部的调用入口：只给订阅方租户 / 操作人 / 时间，不传范围放行等内部开关。 */
export const entryOfferHooks = {
  beforeAction: (tx: Tx, ctx: EmployeeStatusHookContext, event: EntryActionStartEvent) =>
    hooks.beforeEntryAction?.(tx, narrow(ctx), event) ?? Promise.resolve(),
  entryCancelled: (tx: Tx, ctx: EmployeeStatusHookContext, event: EntryCancelledEvent) =>
    hooks.onEntryCancelled(tx, narrow(ctx), event),
  entryRestored: (tx: Tx, ctx: EmployeeStatusHookContext, event: EntryRestoredEvent) =>
    hooks.onEntryRestored(tx, narrow(ctx), event),
};
