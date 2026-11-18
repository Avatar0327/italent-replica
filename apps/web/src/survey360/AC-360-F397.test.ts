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
  vi.useRealTimers();
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

// 审查 F-397 第 1 轮 P2-3：设计 F-076 §4.8 登出“无论成败都丢弃本地令牌”。
it('AC-360-F397 登出断网仍丢弃本地会话并退出作答页，刷新与网络恢复后不再用旧令牌', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const tenant = '10000000-0000-4000-8000-000000000001';
  const key = `survey360.portal.${tenant}`;
  const session = randomBytes(32).toString('base64url');
  sessionStorage.setItem(key, JSON.stringify({ session, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const task = '/api/survey360/portal/tasks/relation/questionnaires/questionnaire';
  const sheet = { status: 'pending', revision: 0, answers: [], suggestion: null };
  let offline = true;
  const calls: { url: string; method: string; session: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      calls.push({ url, method, session: new Headers(init.headers).get('x-survey360-session') });
      if (offline && url.endsWith('/logout')) throw new TypeError('Failed to fetch');
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      if (url === task && method === 'GET')
        return Response.json({
          activity: { name: '合成活动', status: 'enabled' },
          object: { name: '合成对象' },
          questionnaire: {
            id: 'questionnaire',
            name: '合成套卷',
            type: 'key_behavior',
            guide: null,
            items: [
              { id: 'item', text: '合成题目', options: [{ id: 'option', label: '合成选项', remarkRequired: false }] },
            ],
          },
          sheet,
        });
      if (url === task)
        return Response.json({ ...sheet, ...JSON.parse(String(init.body)), status: 'draft', revision: 1 });
      return Response.json({
        kind: 'answer',
        activity: { id: 'activity', name: '合成活动', welcome: null, status: 'enabled' },
        tasks: [
          {
            relationId: 'relation',
            object: { name: '合成对象' },
            questionnaires: [{ id: 'questionnaire', name: '合成套卷', status: 'pending' }],
          },
        ],
      });
    }),
  );
  const wait = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  const press = async (label: string) => {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.replace(/\s/g, '') === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
    await wait();
  };
  await act(async () => root.render(h(App)));
  await wait();
  await press('开始评价');
  await act(async () => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await wait();
  await press('退出登录');
  const loggedOut = calls.length;
  expect(calls.at(-1)).toMatchObject({ method: 'POST', session });
  expect(sessionStorage.getItem(key)).toBeNull();
  expect(host.querySelector('input[name="password"]')).not.toBeNull();
  expect(host.textContent).not.toContain('退出登录');
  expect(host.querySelector('input[type="radio"]')).toBeNull();
  offline = false;
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  await wait();
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(h(App)));
  await wait();
  expect(host.querySelector('input[name="password"]')).not.toBeNull();
  expect(calls.slice(loggedOut).filter((call) => call.session === session)).toEqual([]);
});
