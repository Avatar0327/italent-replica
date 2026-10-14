/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, newCommand, pageQuery } from '../../apps/web/src/foundation/client.js';

afterEach(() => vi.unstubAllGlobals());
const context = { tenantId: 'tenant-a', identityKey: 'person-a' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AC-FE-0-01 统一客户端', () => {
  it('会话走同源 Cookie，租户头来自当前上下文，写命令保留原幂等键与 revision', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({ revision: 3 })));
    vi.stubGlobal('fetch', fetcher);
    const api = createApiClient(() => context);
    const command = newCommand({ name: '合成名称' }, 2);
    await api.request('/api/tenant/example', { method: 'PUT', command });
    await api.request('/api/tenant/example', { method: 'PUT', command });
    const options = fetcher.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(options.headers);
    expect(options.credentials).toBe('same-origin');
    expect(headers.get('x-tenant-id')).toBe('tenant-a');
    expect(headers.get('if-match')).toBe('2');
    expect(headers.get('idempotency-key')).toBe(command.id);
    expect(headers.has('x-dev-user-id')).toBe(false);
    expect(options.body).toBe(JSON.stringify({ name: '合成名称' }));
    expect(new Headers(fetcher.mock.calls[1]![1].headers).get('idempotency-key')).toBe(command.id);
  });

  it.each([
    [403, 'FORBIDDEN', 'forbidden'],
    [404, 'NOT_FOUND', 'not-found'],
    [409, 'REVISION_CONFLICT', 'refresh'],
    [422, 'VALIDATION_FAILED', 'fields'],
    [429, 'REQUEST_RATE_LIMITED', 'rate-limit'],
    [503, 'SERVICE_UNAVAILABLE', 'unknown'],
  ])('HTTP %s 映射为 %s，且不自动重试', async (status, code, kind) => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: { code, message: '服务端说明' } }, Number(status)));
    vi.stubGlobal('fetch', fetcher);
    await expect(createApiClient(() => context).request('/api/tenant/example')).rejects.toMatchObject({ kind, code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('422 与现有 400 字段错误都保留字段路径，409 业务冲突不误报 revision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        json(
          {
            error: { code: 'VALIDATION_FAILED', details: { fieldErrors: { name: ['名称不能为空'] } } },
          },
          422,
        ),
      ),
    );
    const error = await createApiClient(() => context)
      .request('/api/tenant/example')
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw error;
    expect(error.fieldErrors).toEqual([{ name: ['name'], errors: ['名称不能为空'] }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { code: 'CONFLICT' } }, 409)));
    await expect(createApiClient(() => context).request('/api/tenant/example')).rejects.toMatchObject({
      kind: 'conflict',
    });
  });

  it('空租户、外域 URL、没有命令的写入被拒绝；上下文变更后丢弃旧响应', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      createApiClient(() => ({ ...context, tenantId: '' })).request('/api/tenant/example'),
    ).rejects.toThrow();
    const api = createApiClient(() => context);
    await expect(api.request('https://example.com/api/tenant/example')).rejects.toThrow();
    await expect(api.request('/api/tenant/example', { method: 'POST' })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    let active = context;
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = createApiClient(() => active).request('/api/tenant/example');
    active = { tenantId: 'tenant-b', identityKey: 'person-b' };
    finish(json({ secret: '旧租户内容' }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('分页支持 page/pageSize 与 limit/offset，越界不静默修正', () => {
    expect(pageQuery({ page: 3, pageSize: 20 }).toString()).toBe('page=3&pageSize=20');
    expect(pageQuery({ page: 3, pageSize: 20 }, 'offset').toString()).toBe('limit=20&offset=40');
    expect(() => pageQuery({ page: 0, pageSize: 20 })).toThrow();
    expect(() => pageQuery({ page: 1, pageSize: 201 })).toThrow();
  });
  it('现有后端的 Zod issues 数组回填表单，保留数组字段下标', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            error: {
              code: 'VALIDATION_FAILED',
              details: [{ path: ['members', 0, 'name'], message: '名称不能为空' }],
            },
          },
          400,
        ),
      ),
    );
    await expect(createApiClient(() => context).request('/api/tenant/example')).rejects.toMatchObject({
      kind: 'fields',
      fieldErrors: [{ name: ['members', 0, 'name'], errors: ['名称不能为空'] }],
    });
  });
});
