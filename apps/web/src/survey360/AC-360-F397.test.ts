// @vitest-environment happy-dom
import { randomBytes } from 'node:crypto';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App.js';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState({}, '', '/survey360/portal/10000000-0000-4000-8000-000000000001');
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('AC-360-F397 未登录评价者可直接打开通用网址并填写序列号和密码', async () => {
  await act(async () => root.render(h(App)));
  expect(host.textContent).toContain('360 评估作答');
  expect(host.querySelector('input[name="serial"]')).not.toBeNull();
  expect(host.querySelector('input[name="password"]')?.getAttribute('type')).toBe('password');
  expect(fetch).not.toHaveBeenCalled();
});

it('AC-360-F397 无效租户网址不请求后台或成员权限', async () => {
  window.history.replaceState({}, '', '/survey360/portal/invalid');
  await act(async () => root.render(h(App)));
  expect(host.textContent).toContain('作答网址无效');
  expect(fetch).not.toHaveBeenCalled();
});
it('AC-360-F397 恢复会话遇到 401 清除当前租户令牌并回到登录', async () => {
  const key = 'survey360.portal.10000000-0000-4000-8000-000000000001';
  const session = randomBytes(32).toString('base64url');
  sessionStorage.setItem(key, JSON.stringify({ session, expiresAt: new Date(Date.now() + 10000).toISOString() }));
  await act(async () => root.render(h(App)));
  expect(host.textContent).toContain('作答会话已失效，请重新登录');
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(host.querySelector('input[name="password"]')).not.toBeNull();
});

async function enterCredentials() {
  for (const name of ['serial', 'password']) {
    const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, crypto.randomUUID());
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  await act(async () =>
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it('AC-360-F397 登录限频显示原因，Retry-After 到期前禁止重试', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: { code: 'AUTH_LOCKED' } },
        {
          status: 429,
          headers: { 'Retry-After': '900' },
        },
      ),
    ),
  );
  await act(async () => root.render(h(App)));
  await enterCredentials();
  expect(host.textContent).toContain('尝试次数过多');
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await enterCredentials();
  expect(fetch).toHaveBeenCalledOnce();
  expect(sessionStorage.length).toBe(0);
});
