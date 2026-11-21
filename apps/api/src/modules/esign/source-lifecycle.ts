/** F-505 §6.2：在源业务事务中按确切来源撤销，终态、文件与其它来源保持历史事实。 */
import { and, eq, esignTasks, type Tx } from '@italent/db';
import { SOURCE_REVOKE_CAUSE, type ESignSourceEvent, type ESignSourceEventContext } from '@italent/domain';
import { auditActor } from '../../system-actor.js';
import { registerEntrySourceEvents } from '../employment/entry-source-events.js';
import { registerOfferSourceEvents } from '../offer/source-events.js';
import { markOfferSignSourceDeleted } from './offer-source.js';
import { applySignEvent } from './sign-events.js';

async function revokeForSource(tx: Tx, ctx: ESignSourceEventContext, event: ESignSourceEvent) {
  if (event.source === 'offer' && event.change === 'deleted') await markOfferSignSourceDeleted(tx, ctx, event.sourceId);
  const sourceColumn = event.source === 'offer' ? esignTasks.offerId : esignTasks.businessId;
  const tasks = await tx
    .select({ id: esignTasks.id, revision: esignTasks.revision })
    .from(esignTasks)
    .where(
      and(
        eq(esignTasks.tenantId, ctx.tenantId),
        eq(esignTasks.scene, event.source),
        eq(sourceColumn, event.sourceId),
        eq(esignTasks.status, 'signing'),
      ),
    )
    .orderBy(esignTasks.id)
    .for('update');
  for (const task of tasks) {
    await applySignEvent(tx, { ...ctx, expectedRevision: task.revision }, task, {
      type: 'revoked',
      cause: SOURCE_REVOKE_CAUSE[event.change],
      actorUserId: auditActor(ctx.userId),
      at: ctx.now,
    });
  }
}

export function registerESignSourceLifecycle() {
  registerOfferSourceEvents('esign', revokeForSource);
  registerEntrySourceEvents('esign', revokeForSource);
}
