import { createHash, randomUUID } from 'node:crypto';
import {
  accountAvatarAttachments as A,
  accountAvatarSettings as S,
  accountAvatarOutbox as O,
  and,
  eq,
  sql,
  type Tx,
} from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import { rowsOf } from '../employment/record-store.js';
import {
  decodeImage,
  validateImageContent,
  validateImageMetadata,
  type ImageMetadata,
} from '../talent/model-image-format.js';
import { avatarReference } from './references.js';

export interface AvatarContext extends TenantContext {
  readonly now: Date;
  readonly expectedRevision: number;
  readonly commandId: string;
}
const whereOwner = (ctx: TenantContext) => and(eq(A.tenantId, ctx.tenantId), eq(A.userId, ctx.userId));
const metadata = {
  id: A.id,
  filename: A.filename,
  contentType: A.contentType,
  byteSize: A.byteSize,
  sha256: A.sha256,
  status: A.status,
};
const notFound = () => new AppError('NOT_FOUND', '头像不存在');

/** 成员行也是首次创建头像头的串行点，与停用成员竞争时重新检查，不存在管理员代改分支。 */
export async function ownMember(tx: Tx, ctx: TenantContext, write = false) {
  const [member] = rowsOf<{ status: string }>(
    await tx.execute(sql`SELECT status FROM tenant_memberships
    WHERE tenant_id=${ctx.tenantId} AND user_id=${ctx.userId}::uuid ${write ? sql`FOR UPDATE` : sql`FOR SHARE`}`),
  );
  if (member?.status !== 'active') throw new AppError('TENANT_NOT_MEMBER', '不是该租户的成员');
  const [account] = rowsOf<{ display_name: string; status: string }>(
    await tx.execute(sql`
    SELECT display_name,status FROM tenant_member_accounts(ARRAY[${ctx.userId}::uuid])`),
  );
  if (account?.status !== 'active') throw new AppError('UNAUTHENTICATED', '未登录或身份无效');
  return account.display_name;
}

async function currentImage(tx: Tx, ctx: TenantContext) {
  const [row] = await tx
    .select(metadata)
    .from(A)
    .where(and(whereOwner(ctx), eq(A.status, 'uploaded')));
  return row ?? null;
}

export async function presentAvatar(tx: Tx, ctx: TenantContext) {
  const name = await ownMember(tx, ctx);
  const [settings] = await tx
    .select({ revision: S.revision })
    .from(S)
    .where(and(eq(S.tenantId, ctx.tenantId), eq(S.userId, ctx.userId)));
  const image = await currentImage(tx, ctx);
  return { revision: settings?.revision ?? 1, name, avatar: image ? avatarReference(image.id) : null };
}

async function lockOwner(tx: Tx, ctx: AvatarContext) {
  await ownMember(tx, ctx, true);
  await tx.insert(S).values({ tenantId: ctx.tenantId, userId: ctx.userId }).onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(S)
    .where(and(eq(S.tenantId, ctx.tenantId), eq(S.userId, ctx.userId)))
    .for('update');
  if (row?.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '头像已变化，请刷新后重新提交');
}

async function changed(tx: Tx, ctx: AvatarContext, operation: string, before: unknown, after: unknown) {
  await tx
    .update(S)
    .set({ revision: ctx.expectedRevision + 1, updatedAt: ctx.now })
    .where(and(eq(S.tenantId, ctx.tenantId), eq(S.userId, ctx.userId)));
  const snapshot = { revision: ctx.expectedRevision + 1, avatar: after };
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: `account.avatar.${operation}`,
    objectType: 'Account.Avatar',
    objectId: ctx.userId,
    before: { revision: ctx.expectedRevision, avatar: before },
    after: snapshot,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.insert(O).values({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    commandId: ctx.commandId,
    eventType: `account.avatar.${operation}`,
    payload: snapshot,
    createdAt: ctx.now,
  });
}

export async function registeredAvatar(tx: Tx, ctx: TenantContext, id: string) {
  const [row] = await tx
    .select(metadata)
    .from(A)
    .where(and(whereOwner(ctx), eq(A.id, id)));
  if (!row) throw notFound();
  return row;
}

export async function registerAvatar(tx: Tx, ctx: AvatarContext, input: ImageMetadata) {
  await lockOwner(tx, ctx);
  validateImageMetadata(input);
  const attachment = { id: randomUUID(), ...input, status: 'registered' };
  await tx
    .insert(A)
    .values({ ...attachment, tenantId: ctx.tenantId, userId: ctx.userId, createdAt: ctx.now, updatedAt: ctx.now });
  await changed(tx, ctx, 'register', null, attachment);
  return { revision: ctx.expectedRevision + 1, attachment: { id: attachment.id } };
}

export async function uploadAvatar(tx: Tx, ctx: AvatarContext, id: string, base64: string) {
  await lockOwner(tx, ctx);
  const attachment = await registeredAvatar(tx, ctx, id);
  if (attachment.status !== 'registered') throw notFound();
  const bytes = decodeImage(base64);
  if (bytes.length !== attachment.byteSize || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256)
    throw new AppError('VALIDATION_FAILED', '图片内容与登记的大小或哈希不一致');
  await validateImageContent(bytes, attachment.contentType);
  const before = await currentImage(tx, ctx);
  await tx
    .update(A)
    .set({ status: 'pending_cleanup', updatedAt: ctx.now })
    .where(and(whereOwner(ctx), eq(A.status, 'uploaded')));
  await tx
    .update(A)
    .set({ status: 'uploaded', contentBase64: base64, updatedAt: ctx.now })
    .where(and(whereOwner(ctx), eq(A.id, id)));
  await changed(tx, ctx, 'upload', before, { ...attachment, status: 'uploaded' });
  return {};
}

export async function deleteAvatar(tx: Tx, ctx: AvatarContext) {
  await lockOwner(tx, ctx);
  const before = await tx.select(metadata).from(A).where(whereOwner(ctx));
  await tx.update(A).set({ status: 'pending_cleanup', updatedAt: ctx.now }).where(whereOwner(ctx));
  await changed(tx, ctx, 'delete', before, null);
  return {};
}

/** 头像是租户内展示资料；只返回当前有效头像的字节，不提供人员查找、元数据或其它身份字段。 */
export async function avatarContent(tx: Tx, ctx: TenantContext, id: string) {
  await ownMember(tx, ctx);
  return avatarContentBytes(tx, ctx.tenantId, id);
}

/** 内部字节查询；调用方必须先完成成员或本单令牌授权，不能直接挂到公共路由。 */
export async function avatarContentBytes(tx: Tx, tenantId: string, id: string) {
  const [row] = rowsOf<{ content_type: string; content_base64: string }>(
    await tx.execute(sql`
    SELECT a.content_type,a.content_base64 FROM account_avatar_attachments a
    JOIN tenant_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id
    WHERE a.tenant_id=${tenantId} AND a.id=${id}::uuid AND a.status='uploaded' AND m.status='active'`),
  );
  if (!row?.content_base64) throw notFound();
  return { contentType: row.content_type, bytes: Buffer.from(row.content_base64, 'base64') };
}
