import { useMemo, useRef } from 'react';
import { ApiError, type Command } from '../../foundation/client.js';
import { useSession } from '../../foundation/Session.js';
import type { Values } from '../../foundation/forms/values.js';
import { ui } from '../../foundation/messages.js';
import { acceptProcessReceipt, base } from './model.js';

type Kind = ConstructorParameters<typeof ApiError>[2];
// 与共享客户端 errorKind 同口径（内核按 status / code 判冲突与拒绝，kind 只决定展示文案）。
function errorKind(status: number, code: string): Kind {
  if (status === 401) return 'login';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (code === 'REVISION_CONFLICT' || code === 'CATALOG_CHANGED') return 'refresh';
  if (status === 422 || code === 'VALIDATION_FAILED') return 'fields';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limit';
  return 'unknown';
}
const kindMessages: Record<Kind, string> = {
  login: ui.login,
  forbidden: ui.denied,
  'not-found': ui.missing,
  refresh: ui.refresh,
  fields: ui.invalid,
  conflict: ui.conflict,
  'rate-limit': ui.rateLimit,
  unknown: ui.uncertain,
};

/** 共享 ApiError 不保留 details；设计器定位 400 reason / 422 来源需要 nodeKey、exit、branchNo，局部保留，不改共享客户端。 */
export class DesignerError extends ApiError {
  readonly details: Values;
  constructor(status: number, code: string, serverMessage: string | undefined, details: unknown, retryAfter?: number) {
    const kind = errorKind(status, code);
    const message = kind === 'conflict' && serverMessage ? serverMessage : kindMessages[kind];
    // 原样交给 ApiError：字段明细（数组）仍按共享口径回填表单
    super(status, code, kind, message, { code, message: serverMessage, details }, retryAfter);
    this.details = details && typeof details === 'object' && !Array.isArray(details) ? (details as Values) : {};
  }
  /** 定位后的展示文案替换服务端原文；状态码、错误码与明细不变，内核仍按它们判定拒绝。 */
  located(message: string) {
    return new DesignerError(this.status, this.code, message, this.details, this.retryAfter);
  }
}

/** 草稿保存 / 新建版本的写入：请求头与上下文校验同共享客户端；回执仍须绑定本次 revision。 */
export function useDesignerWrite() {
  const session = useSession();
  const latest = useRef(session);
  latest.current = session;
  return useMemo(
    () => async (id: string, action: 'draft' | 'versions', command: Command) => {
      const context = latest.current;
      if (!context.tenantId) throw new ApiError(401, 'TENANT_CONTEXT_REQUIRED', 'login', ui.login);
      const headers = new Headers({
        'content-type': 'application/json',
        'x-tenant-id': context.tenantId,
        'idempotency-key': command.id,
      });
      if (command.revision !== undefined) headers.set('if-match', String(command.revision));
      let response: Response;
      try {
        response = await fetch(`${base}/${encodeURIComponent(id)}/${action}`, {
          method: action === 'draft' ? 'PUT' : 'POST',
          headers,
          credentials: 'same-origin',
          body: JSON.stringify(command.body),
        });
      } catch {
        throw new ApiError(0, 'NETWORK_ERROR', 'unknown', ui.uncertain);
      }
      const payload = await response.json().catch(() => undefined);
      if (latest.current.tenantId !== context.tenantId || latest.current.identityKey !== context.identityKey)
        throw new DOMException('Context changed', 'AbortError');
      if (!response.ok) {
        const { code = 'REQUEST_FAILED', message, details } = payload?.error ?? {};
        const retry = response.headers.get('retry-after');
        const after = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
        throw new DesignerError(response.status, code, message, details, after);
      }
      if (payload === undefined) throw new ApiError(502, 'INVALID_RESPONSE', 'unknown', ui.failed);
      return acceptProcessReceipt(payload, id, command.revision!);
    },
    [],
  );
}
