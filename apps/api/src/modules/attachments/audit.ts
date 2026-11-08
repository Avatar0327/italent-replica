/**
 * F-479 附件审计与回执（无业务模块依赖，供 service.ts 与 binding.ts 共用，避免与 employment 模块循环引用）。
 * 审计与 outbox 只含元数据，不含字节与 base64。
 */
import { type attachmentFiles as F, attachmentOutbox as O, type Tx } from '@italent/db';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';

export type FileRow = typeof F.$inferSelect;

export interface RecordContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly now: Date;
  readonly commandId: string;
}

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
  // 绑定后的归属与封存时刻进审计快照（设计 §4.4）；未绑定的行保持 S1 形状
  return {
    ...rest,
    ...(row.businessId ? { businessType: row.businessType, businessId: row.businessId } : {}),
    ...(row.sealedAt ? { sealedAt: row.sealedAt.toISOString() } : {}),
  };
};

/** 审计 + outbox，与调用方业务写同一事务；绑定函数（binding.ts）共用。 */
export async function record(tx: Tx, ctx: RecordContext, operation: string, before: FileRow | null, after: FileRow) {
  const eventType = `attachment.file.${operation}`;
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    // 清理任务以系统身份写入：审计操作人记空（显示为“系统”），不冒用真实用户
    actorUserId: auditActor(ctx.userId),
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
