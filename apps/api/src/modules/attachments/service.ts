/**
 * F-479 S1 附件服务：登记 / 上传 / 删除 / 本人读取。元数据一文件一行（attachment_files），字节走 PgBlobStore；
 * 业务写、审计、outbox 同事务，审计与 outbox 只含元数据，不含字节与 base64。
 */
import { createHash, randomUUID } from 'node:crypto';
import { attachmentFiles as F, attachmentOutbox as O, and, eq, inArray, sql, type Tx } from '@italent/db';
import {
  ATTACHMENT_PURPOSES,
  attachmentExtension,
  attachmentPurpose,
  sanitizeAttachmentFilename,
  type AttachmentPurposeConfig,
} from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantContext } from '../../tenant-context.js';
import type { SelfAccess } from '../employee-self-service/access.js';
import { decodeImage, sniffImageType, validateImageMetadata } from '../talent/model-image-format.js';
import { PgBlobStore } from './blob-store.js';
import { attachmentNotFound } from './access.js';

export interface AttachmentContext extends TenantContext {
  readonly now: Date;
  readonly commandId: string;
}

export interface RegisterInput {
  readonly purpose: string;
  readonly filename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
}

type FileRow = typeof F.$inferSelect;
const HOUR = 3_600_000;
const limitsOf = (config: AttachmentPurposeConfig) => ({
  maxBytes: config.maxBytes,
  label: '附件',
  limitText: `${config.maxBytes / 1024 / 1024}MiB`,
});

/** 回执：顶层 id / revision / kind（命令结果回查按这三个键取）；不含字节。 */
export function receipt(row: FileRow) {
  return {
    kind: 'attachment_file' as const,
    id: row.id,
    revision: row.revision,
    status: row.status,
    purpose: row.purpose,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    uploadedAt: row.uploadedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const snapshot = (row: FileRow) => {
  const { kind: _kind, ...rest } = receipt(row);
  return rest;
};

async function record(tx: Tx, ctx: AttachmentContext, operation: string, before: FileRow | null, after: FileRow) {
  const eventType = `attachment.file.${operation}`;
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action: eventType,
    objectType: 'attachment_file',
    objectId: after.id,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  await tx.insert(O).values({
    tenantId: ctx.tenantId,
    fileId: after.id,
    commandId: ctx.commandId,
    eventType,
    payload: snapshot(after),
    createdAt: ctx.now,
  });
}

/** 本人名下、尚未绑定的文件；锁行以串行化上传 / 删除。别人的、不存在的、跨租户的（RLS）一律同一个 404。 */
async function ownFile(tx: Tx, self: SelfAccess, id: string, lock: boolean): Promise<FileRow> {
  const query = tx
    .select()
    .from(F)
    .where(
      and(
        eq(F.tenantId, self.ctx.tenantId),
        eq(F.id, id),
        eq(F.ownerUserId, self.ctx.userId),
        eq(F.ownerEmployeeId, self.employee.id),
        inArray(F.status, ['registered', 'uploaded']),
      ),
    );
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw attachmentNotFound();
  return row;
}

function checkRegistration(input: RegisterInput) {
  const config = attachmentPurpose(input.purpose);
  if (!config) throw new AppError('VALIDATION_FAILED', '附件用途不支持');
  const filename = sanitizeAttachmentFilename(input.filename);
  if (!filename) throw new AppError('VALIDATION_FAILED', '文件名无效');
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new AppError('VALIDATION_FAILED', 'sha256 必须为 64 位十六进制');
  if (!config.extensions.includes(attachmentExtension(filename))) unsupportedType();
  // 扩展名与声明类型必须匹配（415）、大小 1～上限（413 / 400）；内容嗅探在上传时做
  validateImageMetadata(
    { filename, contentType: input.contentType, byteSize: input.byteSize, sha256: input.sha256 },
    limitsOf(config),
  );
  return { config, filename };
}

function unsupportedType(): never {
  throw new AppError('UNSUPPORTED_MEDIA_TYPE', '仅支持 jpeg、jpg、gif、png、bmp 格式的图片');
}

/**
 * 登记串行锁的键。请求头里的租户 UUID 保留原始大小写，用户 UUID 同理，而库按 UUID 值比较；
 * 键里不统一成小写，大小写不同的两个请求会拿到两把锁，并发登记就能突破临时文件上限。
 */
function ownerLockKey(ctx: AttachmentContext): string {
  return `${ctx.tenantId.toLowerCase()}:${ctx.userId.toLowerCase()}:attachments`;
}

export async function registerFile(tx: Tx, self: SelfAccess, ctx: AttachmentContext, input: RegisterInput) {
  const { config, filename } = checkRegistration(input);
  // 同一所有人串行登记，临时文件数上限才不会被并发突破
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerLockKey(ctx)}, 0))`);
  const [counted] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(F)
    .where(
      and(
        eq(F.tenantId, ctx.tenantId),
        eq(F.ownerUserId, ctx.userId),
        eq(F.purpose, input.purpose),
        inArray(F.status, ['registered', 'uploaded']),
      ),
    );
  if ((counted?.count ?? 0) >= config.maxTemporaryPerOwner)
    throw new AppError('ATTACHMENT_TEMP_LIMIT', '未使用的临时附件过多，请先删除不需要的附件');
  const [row] = await tx
    .insert(F)
    .values({
      id: randomUUID(),
      tenantId: ctx.tenantId,
      purpose: input.purpose,
      ownerUserId: ctx.userId,
      ownerEmployeeId: self.employee.id,
      filename,
      declaredType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await record(tx, ctx, 'register', null, row!);
  return receipt(row!);
}

export async function uploadFile(
  tx: Tx,
  self: SelfAccess,
  ctx: AttachmentContext,
  id: string,
  expectedRevision: number,
  base64: string,
) {
  const before = await ownFile(tx, self, id, true);
  if (before.revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', '附件已变化，请刷新后重新提交');
  if (before.status !== 'registered') throw new AppError('CONFLICT', '附件已上传，不能重复上传');
  const config = ATTACHMENT_PURPOSES[before.purpose as keyof typeof ATTACHMENT_PURPOSES];
  const bytes = decodeImage(base64, limitsOf(config));
  if (bytes.length !== before.byteSize || createHash('sha256').update(bytes).digest('hex') !== before.sha256)
    throw new AppError('VALIDATION_FAILED', '附件内容与登记的大小或哈希不一致');
  const contentType = sniffImageType(bytes);
  if (!contentType) unsupportedType();
  await PgBlobStore.put(tx, ctx.tenantId, id, bytes);
  const [row] = await tx
    .update(F)
    .set({
      status: 'uploaded',
      contentType,
      uploadedAt: ctx.now,
      expiresAt: new Date(ctx.now.getTime() + config.tempTtlHours * HOUR),
      revision: before.revision + 1,
      updatedAt: ctx.now,
    })
    .where(and(eq(F.tenantId, ctx.tenantId), eq(F.id, id)))
    .returning();
  await record(tx, ctx, 'upload', before, row!);
  return receipt(row!);
}

/** 本人删除未绑定文件：只改状态，字节由清理任务（S3）释放。 */
export async function deleteFile(
  tx: Tx,
  self: SelfAccess,
  ctx: AttachmentContext,
  id: string,
  expectedRevision: number,
) {
  const before = await ownFile(tx, self, id, true);
  if (before.revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', '附件已变化，请刷新后重新提交');
  const [row] = await tx
    .update(F)
    .set({ status: 'pending_cleanup', cleanupAt: ctx.now, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(F.tenantId, ctx.tenantId), eq(F.id, id)))
    .returning();
  await record(tx, ctx, 'delete', before, row!);
  return receipt(row!);
}

/** 读变体 readTemporary：只给本人名下未绑定（registered / uploaded）的元数据。 */
export async function readTemporaryMeta(tx: Tx, self: SelfAccess, id: string) {
  return receipt(await ownFile(tx, self, id, false));
}

/** 内容只给 uploaded；registered 还没有字节，同样 404。 */
export async function readTemporaryContent(tx: Tx, self: SelfAccess, id: string) {
  const row = await ownFile(tx, self, id, false);
  if (row.status !== 'uploaded' || !row.contentType) throw attachmentNotFound();
  const bytes = await PgBlobStore.read(tx, self.ctx.tenantId, id);
  if (!bytes) throw attachmentNotFound();
  return { row, bytes };
}
