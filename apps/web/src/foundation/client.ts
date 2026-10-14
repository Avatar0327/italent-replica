import { ui } from './messages.js';

export interface RequestContext {
  readonly tenantId: string;
  readonly identityKey: string;
}
export interface Command<T = unknown> {
  readonly id: string;
  readonly revision?: number;
  readonly body: T;
}
export interface PageRequest {
  page: number;
  pageSize: number;
}
export interface PageResult<T> {
  items: T[];
  total?: number;
  hasMore?: boolean;
  hasDataPermission?: boolean;
}
export interface FieldError {
  name: (string | number)[];
  errors: string[];
}
type ErrorKind = 'forbidden' | 'not-found' | 'refresh' | 'fields' | 'conflict' | 'unknown' | 'rate-limit' | 'login';
interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
}
function fieldErrors(details: unknown): FieldError[] {
  if (Array.isArray(details))
    return details.flatMap((issue: { path?: unknown[]; message?: unknown }) =>
      Array.isArray(issue.path) &&
      issue.path.length &&
      typeof issue.message === 'string' &&
      issue.path.every((part) => typeof part === 'string' || typeof part === 'number')
        ? [{ name: issue.path as (string | number)[], errors: [issue.message] }]
        : [],
    );
  const fields = (details as { fieldErrors?: Record<string, unknown> } | undefined)?.fieldErrors;
  return Object.entries(fields ?? {}).flatMap(([name, errors]) =>
    Array.isArray(errors) && errors.every((error) => typeof error === 'string')
      ? [{ name: name.split('.'), errors }]
      : [],
  );
}

export class ApiError extends Error {
  readonly fieldErrors: FieldError[];
  readonly serverMessage?: string;
  constructor(
    readonly status: number,
    readonly code: string,
    readonly kind: ErrorKind,
    message: string,
    details?: ErrorPayload['error'],
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.fieldErrors = fieldErrors(details?.details);
    this.serverMessage = details?.message;
  }
}

function errorKind(status: number, code: string): ErrorKind {
  if (status === 401) return 'login';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (code === 'REVISION_CONFLICT' || code === 'CATALOG_CHANGED') return 'refresh';
  if (status === 422 || code === 'VALIDATION_FAILED') return 'fields';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limit';
  return 'unknown';
}

function responseError(response: Response, payload: ErrorPayload) {
  const code = payload.error?.code ?? 'REQUEST_FAILED';
  const kind = errorKind(response.status, code);
  const messages = {
    login: ui.login,
    forbidden: ui.denied,
    'not-found': ui.missing,
    refresh: ui.refresh,
    fields: ui.invalid,
    conflict: payload.error?.message ?? ui.conflict,
    'rate-limit': ui.rateLimit,
    unknown: ui.uncertain,
  };
  const retry = response.headers.get('retry-after');
  return new ApiError(
    response.status,
    code,
    kind,
    messages[kind],
    payload.error,
    retry && /^\d+$/.test(retry) ? Number(retry) : undefined,
  );
}

export function newCommand<T>(body: T, revision?: number): Command<T> {
  // 固定本次命令的内容，调用方显式回查后才可重放同一命令；修改表单须新建命令。
  return { id: crypto.randomUUID(), body: structuredClone(body), revision };
}
interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  command?: Command;
  signal?: AbortSignal;
}
export function createApiClient(context: () => RequestContext) {
  return {
    async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
      const current = context();
      if (!current.tenantId) throw new ApiError(401, 'TENANT_CONTEXT_REQUIRED', 'login', ui.login);
      if (!path.startsWith('/api/tenant/') || /[\\\r\n]/.test(path)) throw new Error('Invalid API path');
      const method = options.method ?? 'GET';
      if (method !== 'GET' && !options.command) throw new Error('Command required');
      const headers = new Headers({ 'content-type': 'application/json', 'x-tenant-id': current.tenantId });
      if (options.command) {
        headers.set('idempotency-key', options.command.id);
        if (options.command.revision !== undefined) headers.set('if-match', String(options.command.revision));
      }
      // 会话 Cookie 由浏览器携带；演示身份头仅由现有 Vite 代理签名，不接受前端伪造身份。
      let response: Response;
      try {
        response = await fetch(path, {
          method,
          headers,
          credentials: 'same-origin',
          signal: options.signal,
          ...(options.command ? { body: JSON.stringify(options.command.body) } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        throw new ApiError(0, 'NETWORK_ERROR', 'unknown', ui.uncertain);
      }
      const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
      const latest = context();
      if (current.tenantId !== latest.tenantId || current.identityKey !== latest.identityKey || options.signal?.aborted)
        throw new DOMException('Context changed', 'AbortError');
      if (!response.ok) throw responseError(response, payload ?? {});
      if (response.status !== 204 && payload === undefined)
        throw new ApiError(502, 'INVALID_RESPONSE', 'unknown', ui.failed);
      return payload as T;
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;

export function pageQuery(page: PageRequest, mode: 'page' | 'offset' = 'page'): URLSearchParams {
  if (
    !Number.isSafeInteger(page.page) ||
    page.page < 1 ||
    !Number.isInteger(page.pageSize) ||
    page.pageSize < 1 ||
    page.pageSize > 200
  )
    throw new RangeError('Invalid pagination');
  return new URLSearchParams(
    mode === 'page'
      ? { page: String(page.page), pageSize: String(page.pageSize) }
      : { limit: String(page.pageSize), offset: String((page.page - 1) * page.pageSize) },
  );
}
