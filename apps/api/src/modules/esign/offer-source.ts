/** F-505 §4.1、§9：锚点只保留来源身份，创建和删除标记随来源业务一起审计。 */
import { and, eq, esignOfferSources, offers, sql, type Tx } from '@italent/db';
import type { ESignSourceEventContext } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { rowsOf } from '../employment/record-store.js';

type SourceContext = Pick<ESignSourceEventContext, 'tenantId' | 'userId' | 'commandId' | 'now'>;
const offerKey = (tenantId: string, offerId: string) => and(eq(offers.tenantId, tenantId), eq(offers.id, offerId));
const anchorKey = (tenantId: string, offerId: string) =>
  and(eq(esignOfferSources.tenantId, tenantId), eq(esignOfferSources.offerId, offerId));

function auditAnchor(
  tx: Tx,
  ctx: SourceContext,
  offerId: string,
  orgId: string | null,
  action: 'created' | 'deleted',
  createdAt: string,
) {
  return recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `esign.offer_source.${action}`,
    objectType: 'offer',
    objectId: offerId,
    scope: { orgId },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    before: action === 'created' ? null : { offerId, createdAt, deletedAt: null },
    after: { offerId, createdAt, deletedAt: action === 'deleted' ? ctx.now.toISOString() : null },
  });
}

/** S4 在已验来源权限的发起事务内调用。重入同一 Offer 锁，锚点缺失时只从当前租户的当前行创建。 */
export async function ensureOfferSignSource(tx: Tx, ctx: SourceContext, offerId: string): Promise<void> {
  const [source] = await tx
    .select({ orgId: offers.departmentId })
    .from(offers)
    .where(offerKey(ctx.tenantId, offerId))
    .for('update');
  if (!source) throw new AppError('NOT_FOUND', 'Offer 不存在');
  const createdAt = ctx.now.toISOString();
  const [inserted] = rowsOf<{ offer_id: string }>(
    await tx.execute(sql`
    INSERT INTO esign_offer_sources (tenant_id, offer_id, created_at)
    SELECT tenant_id, id, ${createdAt}::timestamptz FROM offers
    WHERE tenant_id=${ctx.tenantId} AND id=${offerId}::uuid
    ON CONFLICT (tenant_id, offer_id) DO NOTHING
    RETURNING offer_id
  `),
  );
  if (inserted) return auditAnchor(tx, ctx, offerId, source.orgId, 'created', createdAt);
  const [anchor] = await tx
    .select({ deletedAt: esignOfferSources.deletedAt })
    .from(esignOfferSources)
    .where(anchorKey(ctx.tenantId, offerId));
  if (!anchor || anchor.deletedAt) throw new AppError('NOT_FOUND', 'Offer 签署来源已删除');
}

/** Offer 删除端口已持来源行锁；锚点标记必须先于物理删除，签署落库故障会一起回滚。 */
export async function markOfferSignSourceDeleted(tx: Tx, ctx: SourceContext, offerId: string): Promise<void> {
  const [anchor] = await tx
    .update(esignOfferSources)
    .set({ deletedAt: ctx.now })
    .where(and(anchorKey(ctx.tenantId, offerId), sql`${esignOfferSources.deletedAt} IS NULL`))
    .returning({ createdAt: esignOfferSources.createdAt });
  if (!anchor) return;
  const [source] = await tx.select({ orgId: offers.departmentId }).from(offers).where(offerKey(ctx.tenantId, offerId));
  await auditAnchor(tx, ctx, offerId, source?.orgId ?? null, 'deleted', anchor.createdAt.toISOString());
}
