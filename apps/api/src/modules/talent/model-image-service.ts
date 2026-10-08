/** F-038：附件写入与父标准 revision、审计同事务；字节不进入审计或命令响应。 */
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql, talentCriteria, talentModelImageAttachments, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { requireVisible, type ModuleScope, type TalentContext } from './access.js';
import { decodeImage, validateImageContent, validateImageMetadata, type ImageMetadata } from './model-image-format.js';
import { bumped, lockOwned, rowsOf, type WriteContext } from './write-support.js';

const A = talentModelImageAttachments;
const C = talentCriteria;
export const MODEL_IMAGE_AUDIT_TYPE = 'TalentCenter.TalentCriterionModelImage';

export interface ModelImage extends ImageMetadata {
  readonly id: string;
}
export interface ImageOwner {
  readonly id: string;
  readonly revision: number;
  readonly ownerOrgId: string;
  readonly ownerId: string;
}

const metadataColumns = {
  id: A.id,
  filename: A.filename,
  contentType: A.contentType,
  byteSize: A.byteSize,
  sha256: A.sha256,
};

/** 父对象共享锁使读图、替换及删除串行；没有父对象的附件永不对外可读。 */
export async function imageOwner(tx: Tx, tenantId: string, id: string, scope: ModuleScope): Promise<ImageOwner> {
  const row = rowsOf<{ revision: number; owner_org_id: string; owner_id: string }>(
    await tx.execute(sql`SELECT revision, owner_org_id, owner_id FROM talent_criteria
      WHERE tenant_id=${tenantId} AND id=${id}::uuid FOR SHARE`),
  )[0];
  if (!row) throw new AppError('NOT_FOUND', '人才标准不存在');
  requireVisible(scope, 'criterion', { orgId: row.owner_org_id, ownerId: row.owner_id });
  return { id, revision: row.revision, ownerOrgId: row.owner_org_id, ownerId: row.owner_id };
}

const whereImage = (tenantId: string, criterionId: string) =>
  and(eq(A.tenantId, tenantId), eq(A.criterionId, criterionId));

export async function currentImage(tx: Tx, tenantId: string, criterionId: string): Promise<ModelImage | null> {
  const [image] = await tx
    .select(metadataColumns)
    .from(A)
    .where(and(whereImage(tenantId, criterionId), eq(A.status, 'uploaded')));
  return image ?? null;
}

export async function registeredImage(tx: Tx, tenantId: string, criterionId: string, attachmentId: string) {
  const [image] = await tx
    .select({ ...metadataColumns, status: A.status })
    .from(A)
    .where(and(whereImage(tenantId, criterionId), eq(A.id, attachmentId)));
  if (!image) throw new AppError('NOT_FOUND', '模型图附件不存在');
  return image;
}

export async function imageContent(tx: Tx, tenantId: string, criterionId: string, attachmentId: string) {
  const [image] = await tx
    .select({ contentType: A.contentType, contentBase64: A.contentBase64 })
    .from(A)
    .where(and(whereImage(tenantId, criterionId), eq(A.id, attachmentId), eq(A.status, 'uploaded')));
  if (!image?.contentBase64) throw new AppError('NOT_FOUND', '模型图附件不存在');
  return { contentType: image.contentType, bytes: Buffer.from(image.contentBase64, 'base64') };
}

export async function registerModelImage(tx: Tx, ctx: WriteContext, id: string, input: ImageMetadata) {
  await lockOwned(tx, ctx, 'criterion', id);
  validateImageMetadata(input);
  const owner = await imageOwner(tx, ctx.tenantId, id, ctx.scope);
  const attachment = { id: randomUUID(), ...input, status: 'registered' as const };
  await tx.insert(A).values({
    ...attachment,
    tenantId: ctx.tenantId,
    criterionId: id,
    createdBy: ctx.userId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  await bump(tx, ctx, id);
  await imageAudit(tx, ctx, owner, 'register', null, attachment);
  return { revision: ctx.expectedRevision + 1, attachment };
}

export async function uploadModelImage(tx: Tx, ctx: WriteContext, id: string, attachmentId: string, base64: string) {
  await lockOwned(tx, ctx, 'criterion', id);
  const owner = await imageOwner(tx, ctx.tenantId, id, ctx.scope);
  const attachment = await registeredImage(tx, ctx.tenantId, id, attachmentId);
  if (attachment.status !== 'registered') throw new AppError('NOT_FOUND', '模型图附件不存在');
  const bytes = decodeImage(base64);
  if (bytes.length !== attachment.byteSize || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) {
    throw new AppError('VALIDATION_FAILED', '图片内容与登记的大小或哈希不一致');
  }
  validateImageContent(bytes, attachment.contentType);
  const before = await currentImage(tx, ctx.tenantId, id);
  await tx
    .update(A)
    .set({ status: 'pending_cleanup', updatedAt: ctx.now })
    .where(and(whereImage(ctx.tenantId, id), eq(A.status, 'uploaded')));
  await tx
    .update(A)
    .set({ status: 'uploaded', contentBase64: base64, updatedAt: ctx.now })
    .where(and(whereImage(ctx.tenantId, id), eq(A.id, attachmentId)));
  await bump(tx, ctx, id);
  const after = await currentImage(tx, ctx.tenantId, id);
  await imageAudit(tx, ctx, owner, 'upload', before, after);
  return { revision: ctx.expectedRevision + 1, modelImage: after };
}

export async function deleteModelImage(tx: Tx, ctx: WriteContext, id: string) {
  await lockOwned(tx, ctx, 'criterion', id);
  const owner = await imageOwner(tx, ctx.tenantId, id, ctx.scope);
  const before = await currentImage(tx, ctx.tenantId, id);
  await tx.update(A).set({ status: 'pending_cleanup', updatedAt: ctx.now }).where(whereImage(ctx.tenantId, id));
  await bump(tx, ctx, id);
  await imageAudit(tx, ctx, owner, 'delete', before, null);
  return { revision: ctx.expectedRevision + 1, modelImage: null };
}

/** 标准整体删除也保留附件元数据，并将全部附件作为待清理队列，不能成为可读孤儿。 */
export async function cleanupCriterionImages(tx: Tx, ctx: TalentContext, owner: ImageOwner) {
  const images = await tx
    .select({ ...metadataColumns, status: A.status })
    .from(A)
    .where(whereImage(ctx.tenantId, owner.id));
  if (!images.length) return;
  await tx.update(A).set({ status: 'pending_cleanup', updatedAt: ctx.now }).where(whereImage(ctx.tenantId, owner.id));
  await imageAudit(tx, ctx, owner, 'delete', images, null);
}

async function bump(tx: Tx, ctx: TalentContext, id: string) {
  await tx
    .update(C)
    .set(bumped(ctx))
    .where(and(eq(C.tenantId, ctx.tenantId), eq(C.id, id)));
}

async function imageAudit(
  tx: Tx,
  ctx: TalentContext,
  owner: ImageOwner,
  operation: 'register' | 'upload' | 'delete',
  before: unknown,
  after: unknown,
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `talent.criterion.model-image.${operation}`,
    objectType: MODEL_IMAGE_AUDIT_TYPE,
    objectId: owner.id,
    before: { revision: owner.revision, modelImage: before },
    after: { revision: ctx.expectedRevision + 1, modelImage: after },
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    scope: { orgId: owner.ownerOrgId },
  });
}
