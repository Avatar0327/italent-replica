import { ApiError } from '../foundation/client.js';
import { ui } from '../foundation/messages.js';

/** F-234：接口约定先行，字段裁剪与最近一次发送记录由服务端决定。 */
export interface OfferMail {
  offerId: string;
  name: string;
  recipient: string | null;
  subject: '录用通知';
  notice: { title: '录用通知书'; paragraphs: string[] };
  attachments: [];
  cc: string[] | null;
  bcc: string[] | null;
}
export async function readOfferMail(tenantId: string, id: string, signal: AbortSignal): Promise<OfferMail | null> {
  if (!tenantId) throw new ApiError(401, 'TENANT_CONTEXT_REQUIRED', 'login', ui.login);
  // 通用客户端不保留 details.reason；与 transfer/draft-server 同法在模块内读取错误信封。
  const response = await fetch(`/api/tenant/offers/${encodeURIComponent(id)}/mail`, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
    signal,
  });
  const body = await response.json().catch(() => undefined);
  signal.throwIfAborted();
  if (response.status === 404 && body?.error?.details?.reason === 'OFFER_MAIL_NOT_SENT') return null;
  if (!response.ok) {
    const kind =
      response.status === 401
        ? 'login'
        : response.status === 403
          ? 'forbidden'
          : response.status === 404
            ? 'not-found'
            : 'unknown';
    const message = { login: ui.login, forbidden: ui.denied, 'not-found': ui.missing, unknown: ui.failed }[kind];
    throw new ApiError(response.status, body?.error?.code ?? 'REQUEST_FAILED', kind, message);
  }
  if (!body) throw new ApiError(502, 'INVALID_RESPONSE', 'unknown', ui.failed);
  return body as OfferMail;
}
