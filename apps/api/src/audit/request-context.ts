/**
 * 审计的请求来源上下文（docs/02_业务建模/20 §2：来源动作、来源页面类型、来源页面、终端内核、前端版本、IP、TraceID）。
 * 中间件按请求取值放进 AsyncLocalStorage，统一写入函数（record.ts）在同一请求的事务里读取，不必让每个模块的
 * 上下文对象都携带这些字段；定时任务等不经 HTTP 的写入没有上下文，来源动作记“定时任务”。
 *
 * - IP：取反向代理写入的 X-Forwarded-For 第一跳（部署须由代理覆盖该头，见 docs/06_部署），其次 X-Real-IP、套接字地址；
 * - 来源页面 / 动作等由前端随请求带上，中文按 URL 编码传输，这里解码并去掉控制字符、截断长度；
 * - TraceID：取 X-Trace-Id 或 W3C traceparent 的 trace-id，都没有则生成，并回写响应头 X-Trace-Id 便于排查。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AuditSource } from '@italent/db';
import type { MiddlewareHandler } from 'hono';

export interface AuditRequest {
  readonly source: AuditSource;
  readonly method: string;
  readonly path: string;
  /** 与业务写入同一个时钟（测试注入），失败命令审计的事件时间与业务时间口径一致。 */
  readonly clock: () => Date;
}

const storage = new AsyncLocalStorage<AuditRequest>();

export function currentAuditRequest(): AuditRequest | undefined {
  return storage.getStore();
}

export const TRACE_HEADER = 'x-trace-id';

export function auditRequestContext(clock: () => Date): MiddlewareHandler {
  return async (c, next) => {
    const traceId = token(c.req.header(TRACE_HEADER)) ?? traceparentId(c.req.header('traceparent')) ?? randomUUID();
    c.header('X-Trace-Id', traceId);
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
    const source: AuditSource = {
      sourceAction: text(c.req.header('x-source-action'), 100),
      sourcePageType: text(c.req.header('x-source-page-type'), 100),
      sourcePage: text(c.req.header('x-source-page'), 300),
      terminal: text(c.req.header('user-agent'), 512, false),
      clientVersion: text(c.req.header('x-client-version'), 64, false),
      ip:
        ip(c.req.header('x-forwarded-for')?.split(',')[0]) ??
        ip(c.req.header('x-real-ip')) ??
        ip(socket?.remoteAddress),
      traceId,
    };
    await storage.run({ source, method: c.req.method, path: c.req.path, clock }, () => next());
  };
}

function text(raw: string | undefined, max: number, decode = true): string | null {
  if (raw === undefined) return null;
  let value = raw;
  if (decode) {
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
  }
  // eslint-disable-next-line no-control-regex -- 去掉控制字符，防止日志注入
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function ip(raw: string | undefined): string | null {
  const value = raw?.trim().replace(/^::ffff:/, '');
  return value && /^[0-9A-Fa-f:.]{2,45}$/.test(value) ? value : null;
}

function token(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function traceparentId(raw: string | undefined): string | null {
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(raw?.trim() ?? '');
  return match ? match[1]! : null;
}
