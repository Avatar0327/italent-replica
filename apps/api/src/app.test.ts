import { useTestDb } from '@italent/testkit';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { AppError, type ErrorBody, handleError } from './errors.js';

const testDb = useTestDb();

describe('GET /healthz', () => {
  it('不带数据库时返回 ok', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('带数据库时探测成功返回 ok', async () => {
    const res = await createApp({ db: testDb().db }).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('统一错误响应', () => {
  it('未知路由返回 NOT_FOUND', async () => {
    const res = await createApp().request('/no-such-route');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('非 JSON 写请求返回 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await createApp().request('/anything', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as ErrorBody).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('请求体超过 32KB 返回 413 PAYLOAD_TOO_LARGE', async () => {
    const body = JSON.stringify({ blob: 'x'.repeat(33 * 1024) });
    const res = await createApp().request('/anything', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      body,
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('AppError 按错误码映射 HTTP 状态，未知异常一律 500 且不泄露内部信息', async () => {
    const app = new Hono();
    app.get('/conflict', () => {
      throw new AppError('CONFLICT', 'revision 不一致', { expected: 3, actual: 4 });
    });
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });
    app.onError(handleError);

    const conflict = await app.request('/conflict');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: 'CONFLICT', message: 'revision 不一致', details: { expected: 3, actual: 4 } },
    });

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = await app.request('/boom');
    consoleError.mockRestore();
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain('secret');
  });
});
