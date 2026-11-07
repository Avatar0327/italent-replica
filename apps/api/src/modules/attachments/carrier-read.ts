/**
 * F-479 S2 载体读取（设计 §3）：离职申请单的附件摘要与字节读取，供三个载体（本人 / 审批 / HR）共用。
 * 只认“已绑定在本单”的文件：引用列表由各载体按自己的字段权限与可见范围取值后传入（取值函数与详情接口同一个），
 * 本模块不做权限判定，只做归属与状态判定；任何不满足一律同一个 404。
 */
import { attachmentBlobs as B, attachmentFiles as F, and, eq, inArray, type Tx } from '@italent/db';
import type { Context } from 'hono';
import { attachmentDisposition } from '@italent/domain';
import { AppError } from '../../errors.js';
import { PgBlobStore } from './blob-store.js';
import type { FileRow } from './audit.js';
import { EXIT_BUSINESS_TYPE } from './binding.js';

export interface AttachmentSummary {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly byteSize: number;
  readonly uploadedAt: string | null;
  /** 字节缺失（清理或损坏）时为真：详情仍列出，下载 404（设计 §3.2）。 */
  readonly missing?: true;
}

const missingFile = () => new AppError('NOT_FOUND', '附件不存在');
const lower = (id: string) => id.toLowerCase();

async function boundRows(tx: Tx, tenantId: string, businessId: string, ids: readonly string[]) {
  if (!ids.length) return [];
  const rows = await tx
    .select()
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, [...ids])));
  return rows.filter(
    (row) =>
      row.status === 'bound' &&
      row.businessType === EXIT_BUSINESS_TYPE &&
      lower(row.businessId ?? '') === lower(businessId),
  );
}

/** 按引用列表顺序展开摘要；只列已绑定在本单的文件，不回显别的状态（含 detached）的元数据。 */
export async function attachmentSummaries(
  tx: Tx,
  tenantId: string,
  businessId: string,
  refs: readonly string[] | null | undefined,
): Promise<AttachmentSummary[]> {
  const ids = (refs ?? []).map(lower);
  const rows = new Map((await boundRows(tx, tenantId, businessId, ids)).map((row) => [lower(row.id), row]));
  const withBytes = new Set(
    rows.size
      ? (
          await tx
            .select({ id: B.fileId })
            .from(B)
            .where(
              and(
                eq(B.tenantId, tenantId),
                inArray(
                  B.fileId,
                  [...rows.values()].map((row) => row.id),
                ),
              ),
            )
        ).map((row) => lower(row.id))
      : [],
  );
  return ids.flatMap((id) => {
    const row = rows.get(id);
    if (!row) return [];
    return [
      {
        id: row.id,
        filename: row.filename,
        contentType: row.contentType,
        byteSize: row.byteSize,
        uploadedAt: row.uploadedAt?.toISOString() ?? null,
        ...(withBytes.has(id) ? {} : { missing: true as const }),
      },
    ];
  });
}

/** 载体下载：文件必须在本单引用列表里、状态 bound、归属本单、字节存在；否则 404 “附件不存在”。 */
export async function readCarrierAttachment(
  tx: Tx,
  tenantId: string,
  businessId: string,
  refs: readonly string[] | null | undefined,
  fileId: string,
): Promise<{ row: FileRow; bytes: Uint8Array }> {
  const id = lower(fileId);
  if (!(refs ?? []).some((ref) => lower(ref) === id)) throw missingFile();
  const [row] = await boundRows(tx, tenantId, businessId, [id]);
  if (!row?.contentType) throw missingFile();
  const bytes = await PgBlobStore.read(tx, tenantId, row.id);
  if (!bytes) throw missingFile();
  return { row, bytes };
}

/** 防内联执行：附件下载、禁嗅探、沙箱 CSP、同源资源策略、不缓存（设计 §3.4）。 */
export function respondAttachment(c: Context, row: FileRow, bytes: Uint8Array) {
  c.header('Content-Type', row.contentType!);
  c.header('Content-Disposition', attachmentDisposition(row.filename));
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Content-Security-Policy', "default-src 'none'; sandbox");
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Cache-Control', 'private, no-store');
  c.header('Content-Length', String(bytes.length));
  c.header('ETag', `"${row.sha256}"`);
  return c.body(new Uint8Array(bytes));
}
