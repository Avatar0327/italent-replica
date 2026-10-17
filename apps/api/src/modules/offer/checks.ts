/**
 * 新建 / 复制的字段编辑权判定（审查 #394 P2-01）：事务外按请求预判；事务内（CommandGuard.before，带 tx）按展开继承 /
 * 复制之后实际写入的字段再判，首次执行与同键重放都走这里。无权的字段整单拒绝，不静默丢弃。
 */
import { OFFER_OBJECT } from '@italent/domain';
import { writeFields } from '../permission/module-route-access.js';
import type { OfferCheck } from './context.js';
import type { OfferCreateInput } from './input.js';
import { loadOffer, offerCopyWrites, offerCreateWrites } from './service.js';

export const offerCreateCheck =
  (input: OfferCreateInput): OfferCheck =>
  async (authorize, ctx, tx) =>
    writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? await offerCreateWrites(tx, ctx, input) : input);

export const offerCopyCheck =
  (id: string): OfferCheck =>
  async (authorize, ctx, tx) =>
    writeFields({ authorize }, ctx, OFFER_OBJECT, 'create', tx ? offerCopyWrites(await loadOffer(tx, ctx, id)) : {});
