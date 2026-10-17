/**
 * 新建 / 复制的字段编辑权判定（审查 #394 P2-01）：事务外按请求预判；事务内（CommandGuard.before，带 tx）按展开继承 /
 * 复制之后实际写入的字段再判，首次执行与同键重放都走这里。无权的字段整单拒绝，不静默丢弃。
 * 源 Offer 在一个事务里只锁读一次（审查 #394 P2-03）：判定与落库共用同一份展开结果，中途被他人改动也带不进未判定的字段。
 */
import type { Tx } from '@italent/db';
import { OFFER_OBJECT } from '@italent/domain';
import { writeFields } from '../permission/module-route-access.js';
import type { OfferCheck, OfferContext } from './context.js';
import type { OfferCreateInput } from './input.js';
import { offerCopyWrites, type OfferCreateWrites, type OfferRow } from './service.js';

/** 按事务缓存的源数据：同一事务首次调用时加载（锁读、展开），之后原样返回，不再读库。 */
export type Frozen<T> = (tx: Tx, ctx: OfferContext) => Promise<T>;

export function frozenPerTransaction<T>(load: Frozen<T>): Frozen<T> {
  const loaded = new WeakMap<Tx, Promise<T>>();
  return (tx, ctx) => {
    let value = loaded.get(tx);
    if (!value) loaded.set(tx, (value = load(tx, ctx)));
    return value;
  };
}

export const offerCreateCheck =
  (input: OfferCreateInput, writes: Frozen<OfferCreateWrites>): OfferCheck =>
  async (authorize, ctx, tx) =>
    writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? await writes(tx, ctx) : input);

export const offerCopyCheck =
  (source: Frozen<OfferRow>): OfferCheck =>
  async (authorize, ctx, tx) =>
    writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? offerCopyWrites(await source(tx, ctx)) : {});
