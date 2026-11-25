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
  /** 服务端给的机器原因码（details.reason）：只用于程序判断，不显示给用户（DEC-045）。 */
  readonly reason?: string;
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
    const reason = (details?.details as { reason?: unknown } | undefined)?.reason;
    this.reason = typeof reason === 'string' ? reason : undefined;
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

/**
 * 拒绝原因的展示入口（F-141 缺陷 4，DEC-500 / DEC-464 / 473）：字段校验类、业务冲突类拒绝没有字段明细时，显示服务端给出的原因；
 * 有字段明细由表单回填到字段，其余错误用底座文案。ApiError.message 保持默认文案（AC-FE-R1c-21），状态条、表单浮层、调动表单都经这里。
 */
export function rejectionMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const rejection = error.kind === 'fields' || error.kind === 'conflict';
    return rejection && error.fieldErrors.length === 0 ? error.serverMessage || error.message : error.message;
  }
  return error instanceof Error && error.message ? error.message : ui.uncertain;
}

/**
 * 命令 ID（UUID v4）。crypto.randomUUID 只在安全上下文提供（Web Cryptography 规范），http 页面与老浏览器没有；
 * getRandomValues 不受此限，按 RFC 9562 §5.4 置版本与变体位生成同格式的 ID（F-110 第 2 轮 P2-1）。
 */
export function commandId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function newCommand<T>(body: T, revision?: number): Command<T> {
  // 固定本次命令的内容，调用方显式回查后才可重放同一命令；修改表单须新建命令。
  return { id: commandId(), body: structuredClone(body), revision };
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
