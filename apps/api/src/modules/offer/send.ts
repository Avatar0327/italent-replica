/**
 * Offer 发送 / 重发（R2 BE-14b1，DEC-600；34 OF-R3 / R5 / R10）。待发按 OF-R3 判定后发送，已发直接重发；发送写发送人 /
 * 发送时间、进已发，并在同一事务写一行发送记录（邮件 outbox，状态 pending，首版不显示投递状态）。没有撤回。
 * 超编弱控先要二次确认（establishment.ts）。答复链接令牌、通知模板与附件归候选人答复页（F-183），本单不生成。
 *
 * 供 BE-14b2 / b3 接线的点：offer_send_records（发送记录，查看邮件用）；sendOffer 的 sent_at 可作为“发送时同步待入职”
 * （OF-R8）的触发点——同步在 sendOffer 的事务里追加调用即可。
 */
import { offerSendRecords, type Tx } from '@italent/db';
import { planOfferDispatch } from '@italent/domain';
import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody } from '../employment/context.js';
import { uuidParam } from '../job/context.js';
import { offerOperationCheck, runOfferWrite, assertOfferRevision, type OfferContext } from './context.js';
import { requireQuotaConfirmed } from './establishment.js';
import type { OfferSendInput } from './input.js';
import { parseOfferSend } from './input.js';
import { facts, failPlan, lockOffer, offerStillVisible, readOfferApprovalSettings, save } from './service.js';

export async function sendOffer(tx: Tx, ctx: OfferContext, id: string, input: OfferSendInput) {
  const before = await lockOffer(tx, ctx, id);
  assertOfferRevision(ctx.expectedRevision, before.revision);
  const plan = planOfferDispatch(facts(before), (await readOfferApprovalSettings(tx, ctx.tenantId)).send);
  if (!plan.ok) failPlan(plan);
  if (!before.personalEmail)
    throw new AppError('VALIDATION_FAILED', '缺少收件邮箱', {
      reason: 'OFFER_FORM_INCOMPLETE',
      fields: ['personalEmail'],
    });
  await requireQuotaConfirmed(tx, ctx, before, input.confirmed === true);
  const kind = plan.patch.kind;
  const [record] = await tx
    .insert(offerSendRecords)
    .values({
      tenantId: ctx.tenantId,
      offerId: id,
      kind,
      recipient: before.personalEmail,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      sentBy: ctx.userId,
      commandId: ctx.commandId,
    })
    .returning();
  const offer = await save(tx, ctx, before, kind, { status: 'sent', sentBy: ctx.userId, sentAt: ctx.now });
  return { ...offer, sendRecord: { id: record!.id, kind, status: record!.status } };
}

export function registerOfferSend(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/:id/send', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferSend(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input },
      'update',
      offerOperationCheck('update'),
      async (tx, ctx) => ({ status: 200, body: await sendOffer(tx, ctx, id, input) }),
      { replayed: offerStillVisible },
    );
  });
}
