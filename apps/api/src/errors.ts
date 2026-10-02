import { IdempotencyConflictError, RevisionConflictError } from '@italent/db';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * 统一错误码（AGENTS.md §10「错误」）。客户端只按 `code` 判断，不解析中文 message。
 * 404/500 为框架兜底，不属于业务错误码集合。
 */
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  // 多租户（R1-T00）：非成员与租户不存在同码，不泄露租户是否存在；只有成员才会看到 TENANT_UNAVAILABLE
  TENANT_CONTEXT_REQUIRED: 400,
  TENANT_NOT_MEMBER: 403,
  TENANT_UNAVAILABLE: 403,
  SETTING_READ_ONLY: 403,
  // 并发与幂等（AGENTS.md §10）
  REVISION_REQUIRED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  REVISION_CONFLICT: 409,
  ORG_FUTURE_VERSION_EXISTS: 409,
  JOB_FUTURE_VERSION_EXISTS: 409,
  EST_FUTURE_VERSION_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  SERVICE_UNAVAILABLE: 503,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): ContentfulStatusCode {
    return ERROR_STATUS[this.code];
  }
}

export function errorResponse(c: Context, code: ErrorCode, message: string, details?: unknown): Response {
  const body: ErrorBody = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return c.json(body, ERROR_STATUS[code]);
}

/** app.onError：AppError 按码返回；其他异常一律 500，不向客户端泄露内部信息。 */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof AppError) return errorResponse(c, err.code, err.message, err.details);
  if (err instanceof RevisionConflictError) {
    return errorResponse(c, 'REVISION_CONFLICT', err.message, { expected: err.expectedRevision });
  }
  if (err instanceof IdempotencyConflictError) return errorResponse(c, 'IDEMPOTENCY_CONFLICT', err.message);
  console.error(err);
  return errorResponse(c, 'INTERNAL_ERROR', '服务器内部错误');
}
