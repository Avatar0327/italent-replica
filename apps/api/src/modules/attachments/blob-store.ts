/**
 * 附件字节存储端口（F-479 设计 §1.1）。唯一实现 PgBlobStore：字节写入 attachment_blobs（bytea），与元数据同库同事务，
 * 本地、CI 都不需要外部凭据；以后换对象存储只换实现，调用方只认这个接口。
 */
import { attachmentBlobs as B, and, eq, type Tx } from '@italent/db';

export interface AttachmentBlobStore {
  put(tx: Tx, tenantId: string, fileId: string, bytes: Uint8Array): Promise<void>;
  read(tx: Tx, tenantId: string, fileId: string): Promise<Uint8Array | null>;
  /** 只由清理任务调用（S3）。 */
  remove(tx: Tx, tenantId: string, fileId: string): Promise<void>;
}

const where = (tenantId: string, fileId: string) => and(eq(B.tenantId, tenantId), eq(B.fileId, fileId));

export const PgBlobStore: AttachmentBlobStore = {
  async put(tx, tenantId, fileId, bytes) {
    await tx.insert(B).values({ tenantId, fileId, bytes: Buffer.from(bytes) });
  },
  async read(tx, tenantId, fileId) {
    const [row] = await tx.select({ bytes: B.bytes }).from(B).where(where(tenantId, fileId));
    return row?.bytes ?? null;
  },
  async remove(tx, tenantId, fileId) {
    await tx.delete(B).where(where(tenantId, fileId));
  },
};
