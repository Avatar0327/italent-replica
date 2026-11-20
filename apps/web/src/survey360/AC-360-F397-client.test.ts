import { afterEach, expect, it, vi } from 'vitest';
import { createPortalClient, portalTenant, sheetReceipt, type Sheet } from './portal-client.js';
const tenantId = crypto.randomUUID();
const token = Buffer.from(crypto.randomUUID()).toString('base64url');
afterEach(() => vi.unstubAllGlobals());
it('AC-360-F397 保存按真实 draft 回执校验，不要求后端返回 id', () => {
  const sheet: Sheet = { status: 'draft', revision: 4, answers: [], suggestion: null };
  expect(sheetReceipt(sheet, 3, 'save')).toBe(sheet);
  expect(() => sheetReceipt(sheet, 4, 'save')).toThrow('结果待确认');
  expect(() => sheetReceipt(sheet, 3, 'submit')).toThrow('结果待确认');
});
it('AC-360-F397 只识别本模块完整租户公共路由', () => {
  expect(portalTenant(`/survey360/portal/${tenantId}`)).toBe(tenantId);
  expect(portalTenant('/survey360')).toBeUndefined();
  expect(portalTenant('/survey360/portal/')).toBeUndefined();
  expect(portalTenant(`/survey360/portal/${tenantId}/extra`)).toBeUndefined();
});
it('AC-360-F397 登录不带命令台账头、不发送成员 Cookie', async () => {
  const fetcher = vi.fn(async () => Response.json({ session: token }));
  vi.stubGlobal('fetch', fetcher);
  await createPortalClient(tenantId).request('/login', 'POST', {
    serial: crypto.randomUUID(),
    password: crypto.randomUUID(),
  });
  const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(options.credentials).toBe('omit');
  expect((options.headers as Headers).get('idempotency-key')).toBeNull();
  expect((options.headers as Headers).get('x-tenant-id')).toBe(tenantId);
});
it('AC-360-F397 作答命令携带原命令 ID、实际 revision 与会话专用头', async () => {
  const fetcher = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetcher);
  const command = { id: crypto.randomUUID(), revision: 6, body: { answers: [] } };
  await createPortalClient(tenantId, token).request(
    '/tasks/relation/questionnaires/questionnaire',
    'PUT',
    command.body,
    command,
  );
  const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  const headers = options.headers as Headers;
  expect(headers.get('if-match')).toBe('6');
  expect(headers.get('idempotency-key')).toBe(command.id);
  expect(headers.get('x-survey360-session')).toBe(token);
  expect(headers.get('x-survey360-token')).toBeNull();
});
it('AC-360-F397 会话 401 触发清理，凭据错误不伪装成会话过期', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })),
  );
  const expire = vi.fn();
  await expect(createPortalClient(tenantId, token, expire).request()).rejects.toThrow('作答会话已失效');
  expect(expire).toHaveBeenCalledOnce();
  await expect(createPortalClient(tenantId).request('/login', 'POST', {})).rejects.toThrow('密码和序列号不匹配');
});
it('AC-360-F397 429 保留 Retry-After 且不自动重试', async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { error: { code: 'AUTH_LOCKED' } },
      {
        status: 429,
        headers: { 'Retry-After': '900' },
      },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(createPortalClient(tenantId).request('/login', 'POST', {})).rejects.toMatchObject({
    status: 429,
    retryAfter: 900,
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('AC-360-F397 无回执与断网不能当成成功', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('invalid')),
  );
  await expect(createPortalClient(tenantId, token).request()).rejects.toThrow('结果待确认');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  await expect(createPortalClient(tenantId, token).request()).rejects.toMatchObject({
    status: 0,
    code: 'NETWORK_ERROR',
  });
});
