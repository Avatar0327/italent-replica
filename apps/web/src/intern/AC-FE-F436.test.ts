// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../foundation/Session.js';
import { useRead } from '../part-time/useRead.js';
import { ticket, useNavigationGuard, type NavigationGuard, type NavigationState } from './navigation.js';

// F-436（F-376 审查 P3）：写确认成功即让列表重读，与票据是否还能导航无关；导航本身仍只经票据（F-376）。
describe('AC-FE-F436 写确认后的列表失效与导航票据分开', () => {
  const page = () => {
    const history = { entry: 'a' as unknown };
    const state: NavigationState = { alive: true, seq: 0, entry: history.entry };
    return { state, history, current: () => history.entry };
  };
  const recorder = () => {
    const seen: string[] = [];
    return {
      seen,
      navigate: (view: string) => void seen.push(`navigate:${view}`),
      confirmed: (view: string) => void seen.push(`confirmed:${view}`),
    };
  };

  it('领票后页面卸载（离页）：迟到成功丢弃导航，但仍执行写确认副作用', () => {
    const { state, current } = page();
    const { seen, navigate, confirmed } = recorder();
    const go = ticket(state, navigate, current, confirmed);
    state.alive = false;
    go('converting');
    expect(seen).toEqual(['confirmed:converting']);
  });

  it('领票后页内已导航：迟到成功丢弃导航，但仍执行写确认副作用', () => {
    const { state, history, current } = page();
    const { seen, navigate, confirmed } = recorder();
    const go = ticket(state, navigate, current, confirmed);
    history.entry = 'b';
    go('converting');
    expect(seen).toEqual(['confirmed:converting']);
  });

  it('页面仍在、期间没有导航：先确认副作用，再照常导航', () => {
    const { state, current } = page();
    const { seen, navigate, confirmed } = recorder();
    ticket(state, navigate, current, confirmed)('converting');
    expect(seen).toEqual(['confirmed:converting', 'navigate:converting']);
  });
});

/** 列表读取：真实 useRead + 真实 BrowserRouter，按 InternPage 的接法把列表重读交给票据的写确认副作用。 */
describe('AC-FE-F436 列表查询（真实 useRead / BrowserRouter）', () => {
  const session = {
    tenantId: 'synthetic-tenant',
    identityKey: 'synthetic-user',
    tenantName: '合成租户',
    timezone: 'Asia/Shanghai',
    displayName: '合成用户',
    source: 'server' as const,
  };
  const listPath = '/api/tenant/employment/interns?view=converting&page=1&pageSize=30';
  let listReads: number;
  let root: ReturnType<typeof createRoot>;
  const probe: { guard?: NavigationGuard; navigate?: ReturnType<typeof useNavigate>; refresh?: () => void } = {};
  function Probe() {
    const list = useRead<{ items: unknown[] }>(listPath);
    probe.guard = useNavigationGuard();
    probe.navigate = useNavigate();
    probe.refresh = list.refresh;
    return null;
  }
  /** 一次在途写：成功时按 RegularizeForm 的方式调用提交开始时领的票据，失败（拒绝 / 409 / 结果未知）不调用。 */
  function inflight() {
    const seen: string[] = [];
    const located = probe.guard!(
      (view: string) => void seen.push(view),
      () => probe.refresh!(),
    );
    let settle!: (ok: boolean) => void;
    const done = new Promise<void>((resolve) => {
      settle = (ok) => {
        if (ok) located('converting');
        resolve();
      };
    });
    return { seen, settle, done };
  }
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    listReads = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/employment/interns?')) listReads += 1;
        return Response.json({ items: [], page: 1, pageSize: 30, hasDataPermission: true });
      }),
    );
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root.render(h(SessionProvider, { session, children: h(BrowserRouter, null, h(Probe)) })));
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it('提交在途时页内导航 → 迟到成功：不导航，但列表重读一次', async () => {
    expect(listReads).toBe(1);
    const write = inflight();
    await act(async () => void probe.navigate!('/interns?view=converted'));
    await act(async () => write.settle(true));
    await flush();
    expect(write.seen).toEqual([]);
    expect(listReads).toBe(2);
  });

  it('提交在途时页内导航 → 失败回调：不导航，列表也不重读', async () => {
    expect(listReads).toBe(1);
    const write = inflight();
    await act(async () => void probe.navigate!('/interns?view=converted'));
    await act(async () => write.settle(false));
    await flush();
    expect(write.seen).toEqual([]);
    expect(listReads).toBe(1);
  });
});
