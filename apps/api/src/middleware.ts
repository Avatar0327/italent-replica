import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { errorResponse } from './errors.js';

/** 请求体默认上限 32KB（AGENTS.md §10「请求」）。个别接口可在路由上另挂更大的 bodyLimit。 */
export const DEFAULT_BODY_LIMIT = 32 * 1024;

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** 写请求只接受 JSON（AGENTS.md §10「请求」）；无请求体的 DELETE 放行。 */
export const requireJson: MiddlewareHandler = async (c, next) => {
  if (METHODS_WITH_BODY.has(c.req.method)) {
    const hasBody = c.req.header('content-length') !== '0' && c.req.raw.body !== null;
    const contentType = c.req.header('content-type') ?? '';
    if (hasBody && !/^application\/json(;|$)/i.test(contentType)) {
      return errorResponse(c, 'UNSUPPORTED_MEDIA_TYPE', '只接受 application/json 请求体');
    }
  }
  await next();
};

export const limitBody = (maxSize: number = DEFAULT_BODY_LIMIT): MiddlewareHandler =>
  bodyLimit({
    maxSize,
    onError: (c) => errorResponse(c, 'PAYLOAD_TOO_LARGE', `请求体超过 ${maxSize} 字节上限`),
  });
