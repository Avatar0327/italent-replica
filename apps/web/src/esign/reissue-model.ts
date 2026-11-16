// F-481 §4.3、§8.1：补发回执逐条转中文结果。回执只认本次发出的业务 ID，形状不对按“结果未知”处理（DEC-067）。
import { esignFailureText } from '@italent/domain';
import { m } from './messages.js';

export const REISSUE_LIMIT = 50; // task-routes.ts reissueSchema.items.max(50)
export type ReissueBody = { items: { businessId: string }[]; templateIds: string[] };
export type ReissueReceipt =
  { id: string; ok: true; failureReason: string | null } | { id: string; ok: false; code: string };

function receiptOf(raw: unknown, sent: ReadonlySet<string>): ReissueReceipt {
  const item = raw as Record<string, unknown> | null;
  if (!item || typeof item.id !== 'string' || !sent.has(item.id)) throw new Error(m.reissue.invalidReceipt);
  if (item.ok === true && (item.failureReason === null || typeof item.failureReason === 'string'))
    return { id: item.id, ok: true, failureReason: item.failureReason };
  if (item.ok === false && typeof item.code === 'string') return { id: item.id, ok: false, code: item.code };
  throw new Error(m.reissue.invalidReceipt);
}
export function parseReissueReceipts(raw: unknown, body: ReissueBody): ReissueReceipt[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(m.reissue.invalidReceipt);
  const sent = new Set(body.items.map((item) => item.businessId));
  return items.map((item) => receiptOf(item, sent));
}
/** 不显示原始错误码：已发起 / 发起失败（原因走 DEC-842① 文案）/ 不可发起（未知码给通用说明）。 */
export function receiptText(receipt: ReissueReceipt): string {
  const r = m.reissue;
  if (!receipt.ok) return r.rejected(r.reasons[receipt.code] ?? r.otherReason);
  const reason = esignFailureText(receipt.failureReason);
  return reason === null ? r.started : r.failed(reason);
}
