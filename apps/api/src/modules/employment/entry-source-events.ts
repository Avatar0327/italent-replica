/**
 * 待入职记录来源事件端口（F-505 设计 §5、§6.2）：employment 模块拥有本端口、不 import 订阅方；订阅方在装配时按名称登记。
 * - 在写入同一事务内同步调用；调用时员工与任职业务已被锁，订阅方的锁一律排在其后（员工 → 任职业务 → 组织 → 签署任务）；
 * - 多个订阅方按名称顺序调用，与登记先后无关；订阅方抛错使整笔写入回滚（只应在存储不可用等无法继续时抛出）；
 * - 本片只发事件，没有业务订阅方（S3 的撤销服务才登记）。事件不带个人信息，只带来源 ID、变化种类与 revision。
 */
import type { Tx } from '@italent/db';
import type { ESignSourceEvent, ESignSourceEventContext } from '@italent/domain';

export type EntrySourceEventHandler = (tx: Tx, ctx: ESignSourceEventContext, event: ESignSourceEvent) => Promise<void>;

const registry = new Map<string, EntrySourceEventHandler>();

/** 同名同实现重复登记幂等；同名换实现视为装配错误（避免两套撤销逻辑并存）。 */
export function registerEntrySourceEvents(name: string, handler: EntrySourceEventHandler): void {
  const existing = registry.get(name);
  if (existing && existing !== handler) throw new Error(`待入职记录来源事件订阅方 ${name} 已登记了另一个实现`);
  registry.set(name, handler);
}

/** 仅供测试复位登记状态。 */
export function resetEntrySourceEventsForTest(): void {
  registry.clear();
}

const subscribers = () => [...registry.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, handler]) => handler);

/** 只给订阅方租户、操作人与时间，不把调用方内部上下文传出去。 */
const publicContext = (ctx: ESignSourceEventContext): ESignSourceEventContext => ({
  tenantId: ctx.tenantId,
  userId: ctx.userId,
  timezone: ctx.timezone,
  now: ctx.now,
  commandId: ctx.commandId,
});

export const entrySourceEvents = {
  async emit(tx: Tx, ctx: ESignSourceEventContext, event: ESignSourceEvent): Promise<void> {
    for (const handler of subscribers()) await handler(tx, publicContext(ctx), event);
  },
};
