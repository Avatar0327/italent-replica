/**
 * Offer 来源事件端口（F-505 设计 §5、§6.2）：offer 模块拥有本端口、不 import 订阅方；订阅方在装配时按名称登记。
 * - 在写入同一事务内同步调用；调用时 Offer 行已被锁，订阅方的锁一律排在其后（Offer → 员工 → 任职业务 → 组织 → 签署任务）；
 * - 多个订阅方按名称顺序调用，与登记先后无关；订阅方抛错使整笔写入回滚（只应在存储不可用等无法继续时抛出）；
 * - 本片只发事件，没有业务订阅方（S3 的撤销服务才登记）。事件不带个人信息，只带来源 ID、变化种类与 revision。
 */
import type { Tx } from '@italent/db';
import {
  OFFER_FIELDS,
  classifyOfferChange,
  type ESignSourceEvent,
  type ESignSourceEventContext,
} from '@italent/domain';

export type OfferSourceEventHandler = (tx: Tx, ctx: ESignSourceEventContext, event: ESignSourceEvent) => Promise<void>;

const registry = new Map<string, OfferSourceEventHandler>();

/** 同名同实现重复登记幂等；同名换实现视为装配错误（避免两套撤销逻辑并存）。 */
export function registerOfferSourceEvents(name: string, handler: OfferSourceEventHandler): void {
  const existing = registry.get(name);
  if (existing && existing !== handler) throw new Error(`Offer 来源事件订阅方 ${name} 已登记了另一个实现`);
  registry.set(name, handler);
}

/** 仅供测试复位登记状态。 */
export function resetOfferSourceEventsForTest(): void {
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

export const offerSourceEvents = {
  async emit(tx: Tx, ctx: ESignSourceEventContext, event: ESignSourceEvent): Promise<void> {
    for (const handler of subscribers()) await handler(tx, publicContext(ctx), event);
  },
};

interface OfferRowFacts {
  readonly id: string;
  readonly status: string;
  readonly revision: number;
}

/**
 * Offer 写入口的统一出口：由写前后的行判定来源变化（classifyOfferChange），没有变化不发事件。
 * after 为 null 表示物理删除；fieldsChanged 只看业务字段（OFFER_FIELDS），审批子状态、同步列等不算。
 */
export async function publishOfferChange(
  tx: Tx,
  ctx: ESignSourceEventContext,
  before: OfferRowFacts,
  after: OfferRowFacts | null,
  fieldsChanged: boolean,
): Promise<void> {
  const change = classifyOfferChange(before, after, fieldsChanged);
  if (change === null) return;
  await offerSourceEvents.emit(tx, ctx, {
    source: 'offer',
    sourceId: before.id,
    change,
    revision: after?.revision ?? null,
  });
}

/** 这次写入的补丁里有没有改动 Offer 业务字段（OFFER_FIELDS）；状态、审批子状态、同步列、关联列不算。 */
export function offerFieldsChanged(before: object, patch: object): boolean {
  const old = before as Record<string, unknown>;
  const next = patch as Record<string, unknown>;
  return OFFER_FIELDS.some((field) => field in next && next[field] !== old[field]);
}
