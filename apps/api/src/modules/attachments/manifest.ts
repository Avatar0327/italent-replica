/**
 * F-479 S3 恢复校验（设计 §2.6）：备份恢复后（或运维定期）逐文件核对“元数据 ↔ 字节”。
 * 范围：status ∈ {uploaded, bound, detached}（registered 还没有字节，pending_cleanup / purged 本就不可读）。
 * 做法：重算 sha256 与长度，与登记值比对；缺字节、长度不符、摘要不符的写进报告，并置为 pending_cleanup 使其不可读。
 * 不自动修复、不改字节：只隔离，等人工用备份核对。已封存的文件被隔离后保留字节（清理任务的 purge 阶段跳过 sealed_at，
 * 见 cleanup.ts），保留证据，也避免把审批在途引用的材料悄悄删光。
 * 调用方在目标租户的 withTenant 事务里调用；tenantId 与事务租户不一致时 RLS 让它什么都看不到，结果是空报告（fail-closed）。
 */
import { createHash } from 'node:crypto';
import { attachmentFiles as F, and, eq, inArray, sql, type Tx } from '@italent/db';
import { SYSTEM_USER_ID } from '../../system-actor.js';
import { AppError } from '../../errors.js';
import { PgBlobStore, type AttachmentBlobStore } from './blob-store.js';
import { record } from './audit.js';

export type ManifestProblem = 'missing' | 'size_mismatch' | 'hash_mismatch';
export interface ManifestReport {
  readonly checked: number;
  readonly corrupted: readonly { readonly fileId: string; readonly problem: ManifestProblem }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 200;

function diagnose(file: { byteSize: number; sha256: string }, bytes: Uint8Array | null): ManifestProblem | null {
  if (!bytes) return 'missing';
  if (bytes.length !== file.byteSize) return 'size_mismatch';
  return createHash('sha256').update(bytes).digest('hex') === file.sha256 ? null : 'hash_mismatch';
}

export async function verifyAttachmentManifest(
  tx: Tx,
  tenantId: string,
  options: { readonly now?: Date; readonly store?: AttachmentBlobStore } = {},
): Promise<ManifestReport> {
  if (!UUID.test(tenantId)) throw new AppError('VALIDATION_FAILED', '租户标识必须是 UUID');
  const now = options.now ?? new Date();
  const store = options.store ?? PgBlobStore;
  const corrupted: { fileId: string; problem: ManifestProblem }[] = [];
  let checked = 0;
  let after: string | null = null;
  // 按主键分页，避免一次载入全部元数据；字节逐个读取，不整批驻留内存
  for (;;) {
    const page = await tx
      .select()
      .from(F)
      .where(
        and(
          eq(F.tenantId, tenantId),
          inArray(F.status, ['uploaded', 'bound', 'detached']),
          after ? sql`${F.id} > ${after}::uuid` : undefined,
        ),
      )
      .orderBy(F.id)
      .limit(PAGE);
    for (const file of page) {
      checked += 1;
      const problem = diagnose(file, await store.read(tx, tenantId, file.id));
      if (!problem) continue;
      corrupted.push({ fileId: file.id, problem });
      const [isolated] = await tx
        .update(F)
        .set({ status: 'pending_cleanup', cleanupAt: now, revision: file.revision + 1, updatedAt: now })
        .where(and(eq(F.tenantId, tenantId), eq(F.id, file.id), eq(F.revision, file.revision)))
        .returning();
      if (isolated)
        await record(
          tx,
          { tenantId, userId: SYSTEM_USER_ID, now, commandId: `att-manifest:${file.id}:${file.revision}` },
          'quarantine',
          file,
          isolated,
        );
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!.id;
  }
  return { checked, corrupted };
}
