/**
 * 任职状态钩子端口（R3-T05 设计 §5.4；DEC-343）：任职记录落地或被删除时，在同一事务里通知登记的业务模块
 * （继任自动结束、R3-T06 人才池自动出池）。employment 拥有本端口、不 import 订阅方；订阅方在装配时按名称登记。
 * - 调用时 employment 已持该员工行（lockEmploymentEmployee，FOR NO KEY UPDATE），订阅方的锁一律排在其后
 *   （设计 §7：员工行 → 目标锁行 → 记录行）；多个订阅方按名称顺序调用，锁序与登记先后无关；
 * - 只在事件发生时通知，不补发：登记前已落地的记录、事件之后才建的业务数据由订阅方自己的规则决定（DEC-343④）；
 * - 订阅方抛错会让整个任职写入回滚：只应在存储不可用等无法继续时抛出，业务上“无事可做”直接返回。
 * 事件里的 effectiveDate 是记录生效日：离职 / 退休 = 离职生效日（最后工作日的次日，fields.ts），
 * 未来日期的直接业务保存即落地（到期不再通知，按时间轴切换状态），由订阅方的夜间任务按生效日处理。
 */
import type { Tx } from '@italent/db';
import type { EmployeeStatusCode } from '@italent/domain';
import type { BusinessKind } from './types.js';

/** 订阅方可用的上下文：只给租户、操作人与时间，不传 employment 的范围放行等内部开关。 */
export interface EmployeeStatusHookContext {
  readonly tenantId: string;
  /** 操作人；定时生效为系统操作人。 */
  readonly userId: string;
  readonly timezone: string;
  readonly now: Date;
  readonly commandId: string;
}

export interface EmploymentRecordEvent {
  readonly employeeId: string;
  /** 任职记录 ID（与任职业务同一 ID）。 */
  readonly recordId: string;
  readonly kind: BusinessKind;
  /** 记录生效日（离职 / 退休 = 离职生效日）。 */
  readonly effectiveDate: string;
  readonly lastWorkDate: string | null;
  /** 本版本的人员状态（F-022；离职 8、调出 4、退休 6）。 */
  readonly employeeStatus: EmployeeStatusCode;
}

export interface EmployeeStatusHooks {
  /** 记录写入时间轴之后（直接业务保存、审批即时生效、定时生效同一入口 materializeEmploymentRecord）。 */
  onRecordMaterialized?(tx: Tx, ctx: EmployeeStatusHookContext, event: EmploymentRecordEvent): Promise<void>;
  /** 已生效记录被删除（写墓碑、恢复前一条区间）之后；事件是被删除的那条记录。 */
  onRecordDeleted?(tx: Tx, ctx: EmployeeStatusHookContext, event: EmploymentRecordEvent): Promise<void>;
  /**
   * 预留：记录生效日改期。main 没有改期路径（任职编辑拒绝改日期 RECORD_DATE_IMMUTABLE，离职 R2-T03 搁置），
   * 接入改期时由 employment 在同一事务里调用。
   */
  onRecordRescheduled?(
    tx: Tx,
    ctx: EmployeeStatusHookContext,
    change: { readonly before: EmploymentRecordEvent; readonly after: EmploymentRecordEvent },
  ): Promise<void>;
}

const registry = new Map<string, EmployeeStatusHooks>();

/** 按订阅方名称登记；同名重复登记同一实现幂等，同名登记另一实现视为装配错误（避免两套离职处理并存）。 */
export function registerEmployeeStatusHooks(name: string, hooks: EmployeeStatusHooks): void {
  const existing = registry.get(name);
  if (existing && existing !== hooks) throw new Error(`任职状态钩子 ${name} 已登记了另一个实现`);
  registry.set(name, hooks);
}

/** 仅供测试复位登记状态。 */
export function resetEmployeeStatusHooksForTest(): void {
  registry.clear();
}

const subscribers = () => [...registry.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, h]) => h);

const hookContext = (ctx: EmployeeStatusHookContext): EmployeeStatusHookContext => ({
  tenantId: ctx.tenantId,
  userId: ctx.userId,
  timezone: ctx.timezone,
  now: ctx.now,
  commandId: ctx.commandId,
});

/** employment 内部的调用入口。 */
export const employeeStatusHooks = {
  async recordMaterialized(tx: Tx, ctx: EmployeeStatusHookContext, event: EmploymentRecordEvent): Promise<void> {
    for (const hooks of subscribers()) await hooks.onRecordMaterialized?.(tx, hookContext(ctx), event);
  },
  async recordDeleted(tx: Tx, ctx: EmployeeStatusHookContext, event: EmploymentRecordEvent): Promise<void> {
    for (const hooks of subscribers()) await hooks.onRecordDeleted?.(tx, hookContext(ctx), event);
  },
};
