// @vitest-environment happy-dom
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
