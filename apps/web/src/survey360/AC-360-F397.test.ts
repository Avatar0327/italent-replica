// @vitest-environment happy-dom
import { randomBytes } from 'node:crypto';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { AUTOSAVE_MS } from './usePortalAnswer.js';

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

// 审查 F-397 第 3 轮 P2-2：登出（作答页卸载、换会话）后，在途保存的回执不得再触发新的作答请求。
it('AC-360-F397 返回列表的保存在途时继续作答再登出，回执到达后不再发作答请求', async () => {
  const key = 'survey360.portal.10000000-0000-4000-8000-000000000001';
  const session = randomBytes(32).toString('base64url');
  sessionStorage.setItem(key, JSON.stringify({ session, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const task = '/api/survey360/portal/tasks/relation/questionnaires/questionnaire';
  const options = (id: string) => [{ id, label: `合成选项${id}`, remarkRequired: false }];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls: { url: string; method: string; session: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      calls.push({ url, method, session: headers.get('x-survey360-session') });
      if (url.endsWith('/logout')) throw new TypeError('Failed to fetch');
      const sheet = { status: 'pending', revision: 0, answers: [], suggestion: null };
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
              { id: 'item', text: '合成题目', options: options('option') },
              { id: 'second-item', text: '合成题目二', options: options('second-option') },
            ],
          },
          sheet,
        });
      if (url === task) {
        await gate;
        const revision = Number(headers.get('if-match')) + 1;
        return Response.json({ ...sheet, ...JSON.parse(String(init.body)), status: 'draft', revision });
      }
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
  const choose = async (index: number) => {
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]!.click());
    await wait();
  };
  await act(async () => root.render(h(App)));
  await wait();
  await press('开始评价');
  await choose(0);
  await press('返回评价列表');
  await choose(1);
  await press('退出登录');
  const loggedOut = calls.length;
  expect(calls.at(-1)).toMatchObject({ url: '/api/survey360/portal/logout', method: 'POST', session });
  expect(calls.filter((call) => call.url === task && call.method === 'PUT')).toHaveLength(1);
  await act(async () => release());
  await wait();
  await wait();
  expect(host.querySelector('input[name="password"]')).not.toBeNull();
  expect(calls.slice(loggedOut).filter((call) => call.url.startsWith(task))).toEqual([]);
});

// 审查 F-397 第 5 轮 P2-1（DEC-948）：重开时继承的未确认保存命令（上一会话发出、本次挂载未发出），结果确认前只读；
// 本次挂载自己发出的保存在途时仍可作答。
function heldSaveFixture() {
  const key = 'survey360.portal.10000000-0000-4000-8000-000000000001';
  const session = randomBytes(32).toString('base64url');
  sessionStorage.setItem(key, JSON.stringify({ session, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
  const task = '/api/survey360/portal/tasks/relation/questionnaires/questionnaire';
  // 合成服务端：保存落库并推进 revision，If-Match 与当前 revision 不符时 409（同后端 answering 的版本校验）。
  let sheet: Record<string, unknown> = { status: 'pending', revision: 0, answers: [], suggestion: null };
  const options = ['option', 'other'].map((id) => ({ id, label: `合成选项${id}`, remarkRequired: false }));
  const item = { id: 'item', text: '合成题目', options };
  let gate = Promise.resolve();
  let reading = Promise.resolve();
  const fixture = {
    release: () => undefined as void,
    releaseRead: () => undefined as void,
    puts: 0,
    revisions: [] as number[],
    hold: () => void (gate = new Promise<void>((resolve) => (fixture.release = resolve))),
    /** 暂缓之后的答卷 GET：返回放行时的服务端答卷。 */
    holdRead: () => void (reading = new Promise<void>((resolve) => (fixture.releaseRead = resolve))),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      if (url.endsWith('/logout')) return new Response(null, { status: 204 });
      if (url.endsWith('/login'))
        return Response.json({
          session: randomBytes(32).toString('base64url'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      if (url === task && method === 'GET') {
        await reading;
        return Response.json({
          activity: { name: '合成活动', status: 'enabled' },
          object: { name: '合成对象' },
          questionnaire: { id: 'questionnaire', name: '合成套卷', type: 'key_behavior', guide: null, items: [item] },
          sheet,
        });
      }
      if (url === task) {
        fixture.puts += 1;
        const expected = Number(headers.get('if-match'));
        fixture.revisions.push(expected);
        await gate;
        if (expected !== sheet.revision)
          return Response.json({ error: { code: 'REVISION_CONFLICT', message: '版本冲突' } }, { status: 409 });
        sheet = { ...sheet, ...JSON.parse(String(init.body)), status: 'draft', revision: expected + 1 };
        return Response.json(sheet);
      }
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
  return fixture;
}
const settle = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
async function pressButton(label: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.replace(/\s/g, '') === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
const radio = (index = 0) => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[index]!;
const autosaveTwice = () =>
  act(async () => {
    vi.advanceTimersByTime(AUTOSAVE_MS * 2);
  });
/** 选答案、立即保存并暂缓回执，退出、重登同一评价者、重开同一答卷（GET 返回保存前的 revision 0）。 */
async function reopenWithHeldSave() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = heldSaveFixture();
  await act(async () => root.render(h(App)));
  await settle();
  await pressButton('开始评价');
  await act(async () => radio().click());
  await settle();
  fixture.hold();
  await pressButton('立即保存');
  expect(fixture.puts).toBe(1);
  await pressButton('退出登录');
  await enterCredentials();
  await pressButton('开始评价');
  // GET 已完成，原保存仍未返回：恢复原命令的答案，但不可再作答。
  expect(radio().checked).toBe(true);
  expect(radio().disabled).toBe(true);
  return fixture;
}

it('AC-360-F397 保存在途时退出并重登、重开同一答卷：继承的保存未确认前只读，原回执到达后恢复可写', async () => {
  const fixture = await reopenWithHeldSave();
  await act(async () => fixture.release());
  await settle();
  await settle();
  expect(radio().checked).toBe(true);
  expect(radio().disabled).toBe(false);
  expect(fixture.puts).toBe(1);
  // 第 6 轮审查 P2-1：原回执到达后不做任何输入，跨过自动保存周期，不得以旧 revision 再发 PUT、不得再次锁定。
  await autosaveTwice();
  await settle();
  expect(fixture.revisions).toEqual([0]);
  expect(radio().checked).toBe(true);
  expect(radio().disabled).toBe(false);
  // 随后新输入的保存带原回执之后的 revision；本次挂载发出的保存在途时可继续作答。
  await act(async () => radio(1).click());
  await settle();
  fixture.hold();
  await pressButton('立即保存');
  expect(fixture.revisions).toEqual([0, 1]);
  expect(radio(1).disabled).toBe(false);
  await act(async () => fixture.release());
  await settle();
  expect(radio(1).checked).toBe(true);
  expect(radio(1).disabled).toBe(false);
});

// 原回执已落定、本挂载确认新基线的 GET 还未返回：这段时间里跨过自动保存周期也不发 PUT，GET 返回后也不补发。
it('AC-360-F397 重开继承保存：原回执后新基线确认前跨过自动保存周期，不重复保存', async () => {
  const fixture = await reopenWithHeldSave();
  fixture.holdRead();
  await act(async () => fixture.release());
  await settle();
  await autosaveTwice();
  await settle();
  await act(async () => fixture.releaseRead());
  await settle();
  await autosaveTwice();
  await settle();
  expect(fixture.revisions).toEqual([0]);
  expect(radio().checked).toBe(true);
  expect(radio().disabled).toBe(false);
});

// 同一时间段内新输入并显式保存：等新基线确认后再发，带原回执之后的 revision，本页输入保留（DEC-936）。
it('AC-360-F397 重开继承保存：新基线确认前的新输入与显式保存，确认后带回执之后的 revision 发出', async () => {
  const fixture = await reopenWithHeldSave();
  fixture.holdRead();
  await act(async () => fixture.release());
  await settle();
  await act(async () => radio(1).click());
  await settle();
  await pressButton('立即保存');
  expect(fixture.revisions).toEqual([0]);
  await act(async () => fixture.releaseRead());
  await settle();
  expect(fixture.revisions).toEqual([0, 1]);
  expect(radio(1).checked).toBe(true);
  expect(radio(1).disabled).toBe(false);
});

it('AC-360-F397 对照：本次挂载发出的保存在途时仍可继续作答', async () => {
  const fixture = heldSaveFixture();
  await act(async () => root.render(h(App)));
  await settle();
  await pressButton('开始评价');
  await act(async () => radio().click());
  await settle();
  fixture.hold();
  await pressButton('立即保存');
  expect(fixture.puts).toBe(1);
  expect(radio().checked).toBe(true);
  expect(radio().disabled).toBe(false);
  await act(async () => fixture.release());
  await settle();
  expect(radio().disabled).toBe(false);
});
