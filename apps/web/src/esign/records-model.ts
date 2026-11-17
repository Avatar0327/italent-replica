// F-481 §8.2：签署记录列表与提醒 / 撤销回执。形状按后端 record-access.ts presentRecord（无读权的字段整个省略）、
// records.ts listRecords / actOnRecords；回执里出现未发出的 id、形状不对都按识别不了处理（结果未知，DEC-067）。
import { ESIGN_BASE } from './model.js';
import { m } from './messages.js';
import { rowsOf, type Named } from './sign-model.js';

export const RECORD_OBJECT = 'TenantBase.ESignRecord';
export const RECORDS_PATH = `${ESIGN_BASE}/records`;
export const RECORD_TABS = ['all', 'signing', 'completed'] as const;
export type RecordTab = (typeof RECORD_TABS)[number];
export type RecordAction = 'remind' | 'revoke';
export interface RecordRow {
  readonly id: string;
  readonly revision: number;
  readonly initiator?: Named | null;
  readonly owner?: Named | null;
  readonly ownerDepartment?: Named | null;
  readonly scene?: string;
  readonly initiatedAt?: string | null;
  readonly completedAt?: string | null;
  readonly status?: string;
  readonly currentNode?: string | null;
  readonly failureReason?: string | null;
  readonly files?: readonly { readonly seq: number; readonly name?: string }[];
}
export type RecordReceipt = { id: string; ok: true } | { id: string; ok: false; code: string };
export type RecordBody = { items: { id: string; revision: number }[] };

export function parseRecords(raw: unknown): { items: RecordRow[]; total: number } {
  const body = raw as { items?: unknown; total?: unknown } | null;
  if (!Number.isSafeInteger(body?.total)) throw new Error(m.invalidList);
  return { items: rowsOf<RecordRow>(body!.items), total: body!.total as number };
}
export function parseRecordReceipts(raw: unknown, body: RecordBody): RecordReceipt[] {
  const items = (raw as { items?: unknown } | null)?.items;
  const sent = new Set(body.items.map((item) => item.id));
  if (!Array.isArray(items)) throw new Error(m.records.invalidReceipt);
  return items.map((value) => {
    const item = value as Record<string, unknown> | null;
    if (typeof item?.id !== 'string' || !sent.has(item.id)) throw new Error(m.records.invalidReceipt);
    if (item.ok === true) return { id: item.id, ok: true };
    if (item.ok === false && typeof item.code === 'string') return { id: item.id, ok: false, code: item.code };
    throw new Error(m.records.invalidReceipt);
  });
}
/** 不显示原始错误码：409 REVISION_CONFLICT 只提示刷新后重试（不自动重提），未知码给通用说明。 */
export const receiptText = (receipt: RecordReceipt, action: RecordAction) =>
  receipt.ok ? m.records.done[action]! : (m.records.reasons[receipt.code] ?? m.records.otherReason);
export const filesPath = (ids: readonly string[]) =>
  `${RECORDS_PATH}/files?${new URLSearchParams({ ids: ids.join(',') })}`;
