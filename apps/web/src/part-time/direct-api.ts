import { useMemo, useRef } from 'react';
import { ApiError, type Command } from '../foundation/client.js';
import { useSession } from '../foundation/Session.js';
import type { Values } from '../foundation/forms/values.js';
import { ui } from '../foundation/messages.js';
import { apiRoot } from './model.js';
import { d } from './direct-messages.js';
export class DirectError extends ApiError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly details: Values,
  ) {
    super(status, code, directErrorKind(status, code), message);
  }
}
function directErrorKind(status: number, code: string) {
  if (code === 'REVISION_CONFLICT') return 'refresh';
  if (status === 409) return 'conflict';
  if (status === 400) return 'fields';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 401) return 'login';
  if (status === 429) return 'rate-limit';
  return 'unknown';
}
// 共享 ApiError 不保留 details.items；局部保留批量明细，不改共享客户端契约。
export function useDirectApi() {
  const session = useSession();
  const latest = useRef(session);
  latest.current = session;
  return useMemo(
    () => async (path: string, method: 'POST' | 'PATCH', command: Command, signal?: AbortSignal) => {
      if (!path.startsWith(`${apiRoot}/`) || /[\\\r\n]/.test(path)) throw new Error('Invalid API path');
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
        response = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers,
          body: JSON.stringify(command.body),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ApiError(0, 'NETWORK_ERROR', 'unknown', ui.uncertain);
      }
      const payload = await response.json().catch(() => undefined);
      if (
        signal?.aborted ||
        latest.current.tenantId !== context.tenantId ||
        latest.current.identityKey !== context.identityKey
      )
        throw new DOMException('Context changed', 'AbortError');
      if (!response.ok) {
        const { code = 'REQUEST_FAILED', message, details = {} } = payload?.error ?? {};
        throw new DirectError(response.status, code, d.reasons[details.reason] ?? message ?? ui.failed, details);
      }
      if (!payload) throw new Error(d.invalidReceipt);
      return payload as Values;
    },
    [],
  );
}
