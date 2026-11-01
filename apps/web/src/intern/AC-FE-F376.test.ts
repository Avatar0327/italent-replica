// @vitest-environment happy-dom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  observe,
  ticket,
  traversed,
  useNavigationGuard,
  type NavigationGuard,
  type NavigationState,
} from './navigation.js';

// F-376：写确认后的导航票据——页面仍在且领票后没有发生过任何导航才执行。
describe('AC-FE-F376 navigation ticket', () => {
  const calls = () => {
    const seen: string[] = [];
    return { seen, navigate: (view: string) => void seen.push(view) };
  };
  const page = (entry: unknown = 'a') => {
    const state: NavigationState = { alive: true, seq: 0, entry };
    const history = { entry };
    return { state, history, current: () => history.entry };
  };

  it('页面仍在、期间没有导航：照常导航', () => {
    const { state, current } = page();
    const { seen, navigate } = calls();
    ticket(state, navigate, current)('converting');
    expect(seen).toEqual(['converting']);
  });

  it('领票后页面卸载（后退离开）：丢弃迟到导航', () => {
    const { state, current } = page();
    const { seen, navigate } = calls();
    const go = ticket(state, navigate, current);
    state.alive = false;
    go('converting');
    expect(seen).toEqual([]);
  });

  it('领票后站内 PUSH 换了历史项：路由还没重渲也丢弃，之后新领的票照常', () => {
    const { state, history, current } = page();
    const { seen, navigate } = calls();
    const stale = ticket(state, navigate, current);
    history.entry = 'b';
    stale('converting');
    ticket(state, navigate, current)('converted');
    expect(seen).toEqual(['converted']);
  });

  it('a → b → a（两次 popstate 回到同一历史项）：序号只增不减，旧票据不复活', () => {
    const { state, history, current } = page();
    const { seen, navigate } = calls();
    const stale = ticket(state, navigate, current);
    traversed(state, (history.entry = 'b'));
    traversed(state, (history.entry = 'a'));
    stale('converting');
    expect(seen).toEqual([]);
  });

  it('后退再前进回到同一历史项也不复活：卸载即作废', () => {
    const { state, current } = page();
    const { seen, navigate } = calls();
    const go = ticket(state, navigate, current);
    state.alive = false;
    observe(state, 'a');
    go('converting');
    expect(seen).toEqual([]);
  });
});

// F-376 R1 P2-1：票据判断“期间是否发生过导航”，不是“现在是否回到同一历史项”。
describe('AC-FE-F376 useNavigationGuard（真实 BrowserRouter）', () => {
  /** 浏览器后退 / 前进：等 popstate 落地并让路由渲染完。 */
  const traverse = async (step: () => void) => {
    const popped = new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    await act(async () => {
      step();
      await popped;
    });
  };

  it('a → b → a 后旧票据永久失效，新领的票照常', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const page: { guard?: NavigationGuard; navigate?: ReturnType<typeof useNavigate> } = {};
    function Probe() {
      page.guard = useNavigationGuard();
      page.navigate = useNavigate();
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root.render(h(BrowserRouter, null, h(Probe))));
    const seen: string[] = [];
    const stale = page.guard!((view: string) => void seen.push(view));
    await act(async () => void page.navigate!('/interns?view=converted'));
    await traverse(() => history.back());
    await traverse(() => history.forward());
    await traverse(() => history.back());
    stale('converting');
    expect(seen).toEqual([]);
    page.guard!((view: string) => void seen.push(view))('converted');
    expect(seen).toEqual(['converted']);
    act(() => root.unmount());
  });
});
