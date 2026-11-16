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

/**
 * 办理份里的附件展示元数据（F-479 §2.3 捕获契约）：只有 ID 与展示用的四项，不含字节、下载地址、上传时间。
 * 办理人此后的展开与下载以这份为准（设计 §3.2 审批载体判定集）。
 */
export interface CapturedAttachment {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string | null;
  readonly byteSize: number;
}

/** 冻结读展开的摘要：展示元数据取办理份；字节缺失（清理或损坏）时为真，下载 404。 */
export type FrozenAttachmentSummary = CapturedAttachment & { readonly missing?: true };

const missingFile = () => new AppError('NOT_FOUND', '附件不存在');
const lower = (id: string) => id.toLowerCase();

type CarrierStatus = 'bound' | 'detached';
/** 现值读只认 bound；已办冻结读（办理份里的文件后来被本人删去而 detached）另认 detached。 */
const LIVE_STATUSES: readonly CarrierStatus[] = ['bound'];
const FROZEN_STATUSES: readonly CarrierStatus[] = ['bound', 'detached'];

async function boundRows(
  tx: Tx,
  tenantId: string,
  businessId: string,
  ids: readonly string[],
  statuses: readonly CarrierStatus[] = LIVE_STATUSES,
) {
  if (!ids.length) return [];
  const rows = await tx
    .select()
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, [...ids])));
  return rows.filter(
    (row) =>
      (statuses as readonly string[]).includes(row.status) &&
      row.businessType === EXIT_BUSINESS_TYPE &&
      lower(row.businessId ?? '') === lower(businessId),
  );
}

/** 办理时采集：已绑定摘要 → 办理份里的展示元数据（按引用顺序，去掉上传时间与字节状态）。 */
export function captureAttachments(summaries: readonly AttachmentSummary[]): CapturedAttachment[] {
  return summaries.map(({ id, filename, contentType, byteSize }) => ({ id, filename, contentType, byteSize }));
}

const isCaptured = (value: unknown): value is CapturedAttachment => {
  const item = value as Partial<CapturedAttachment> | null;
  return (
    !!item && typeof item.id === 'string' && typeof item.filename === 'string' && typeof item.byteSize === 'number'
  );
};

/** 从办理份 ext（离职内容）里取出采集的附件元数据；缺失或畸形一律视为空（不退回现值，DEC-807）。 */
export function capturedFromExt(ext: unknown): CapturedAttachment[] {
  const exit = (ext as { exit?: { attachments?: unknown } } | null | undefined)?.exit;
  const list = exit?.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter(isCaptured).map(({ id, filename, contentType, byteSize }) => ({
    id,
    filename,
    contentType: typeof contentType === 'string' ? contentType : null,
    byteSize,
  }));
}

async function idsWithBytes(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  const found = await tx
    .select({ id: B.fileId })
    .from(B)
    .where(and(eq(B.tenantId, tenantId), inArray(B.fileId, [...ids])));
  return new Set(found.map((row) => lower(row.id)));
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
  const withBytes = await idsWithBytes(
    tx,
    tenantId,
    [...rows.values()].map((row) => row.id),
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

/**
 * 已办冻结读的展开（设计 §3.2）：以办理份为准——只展开“引用列表（已按披露集裁剪）∩ 办理份”的文件，展示元数据取办理份；
 * 现值只复核：状态 bound / detached、归属本单。pending_cleanup / purged / 别单的文件整项缺席，不回显办理时的旧文件名。
 */
export async function frozenAttachmentSummaries(
  tx: Tx,
  tenantId: string,
  businessId: string,
  refs: readonly string[] | null | undefined,
  captured: readonly CapturedAttachment[],
): Promise<FrozenAttachmentSummary[]> {
  const byId = new Map(captured.map((item) => [lower(item.id), item]));
  const ids = (refs ?? []).map(lower).filter((id) => byId.has(id));
  const rows = await boundRows(tx, tenantId, businessId, ids, FROZEN_STATUSES);
  const alive = new Set(rows.map((row) => lower(row.id)));
  const withBytes = await idsWithBytes(tx, tenantId, [...alive]);
  return ids.flatMap((id) => {
    const item = byId.get(id);
    if (!item || !alive.has(id)) return [];
    return [{ ...item, ...(withBytes.has(id) ? {} : { missing: true as const }) }];
  });
}

/** 载体下载的读口径：现值读只认 bound；已办冻结读另认 detached，且文件须在办理份里（设计 §3.2、§3.3）。 */
export type CarrierReadMode =
  { readonly mode: 'live' } | { readonly mode: 'frozen'; readonly captured: readonly string[] };

/** 载体下载：文件必须在本单引用列表里、状态合格、归属本单、字节存在；否则 404 “附件不存在”。 */
export async function readCarrierAttachment(
  tx: Tx,
  tenantId: string,
  businessId: string,
  refs: readonly string[] | null | undefined,
  fileId: string,
  read: CarrierReadMode = { mode: 'live' },
): Promise<{ row: FileRow; bytes: Uint8Array }> {
  const id = lower(fileId);
  if (!(refs ?? []).some((ref) => lower(ref) === id)) throw missingFile();
  if (read.mode === 'frozen' && !read.captured.some((item) => lower(item) === id)) throw missingFile();
  const statuses = read.mode === 'frozen' ? FROZEN_STATUSES : LIVE_STATUSES;
  const [row] = await boundRows(tx, tenantId, businessId, [id], statuses);
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
