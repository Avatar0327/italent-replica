import { useCallback, useLayoutEffect, useRef } from 'react';

/** 页面导航代次：页面是否仍挂载、单调递增的导航序号、最近一次看到的历史项。 */
export interface NavigationState {
  alive: boolean;
  seq: number;
  entry: unknown;
}

/** 浏览器前进 / 后退（popstate）：每次都递增，回到同一历史项也算发生过导航。 */
export function traversed(state: NavigationState, entry: unknown) {
  state.entry = entry;
  state.seq += 1;
}

/** 站内 PUSH / REPLACE 会换掉当前历史项（history.state）：发现变了就递增。 */
export function observe(state: NavigationState, entry: unknown) {
  if (entry !== state.entry) traversed(state, entry);
}

/**
 * 领票时记下序号；执行时页面仍在且序号没变（期间没有发生过任何导航）才执行，否则丢弃。
 * 序号只增不减，a → b → a 回到同一历史项后旧票据也永久失效（F-376 R1 P2-1）。
 */
export function ticket<A extends unknown[]>(
  state: NavigationState,
  navigate: (...args: A) => void,
  entry: () => unknown,
) {
  observe(state, entry());
  const seq = state.seq;
  return (...args: A) => {
    observe(state, entry());
    if (state.alive && state.seq === seq) navigate(...args);
  };
}

const currentEntry = () => window.history.state as unknown;

/**
 * 写结果确认与页面导航分开（F-376，F-285 R3 P2-R3-F1）：已发出的写命令照常按原命令上下文确认
 * （未确认命令、成功提示照旧，DEC-464 / DEC-473），但写确认后的页面导航只经这里的票据执行——
 * 提交开始时领票；HR 后退离开页面或期间发生了别的导航，迟到的回调不再把用户带回旧页面。
 * 页面级（随页面挂载），不随表单卸载作废：表单关了、页面还在且没导航时照常切视图。
 * 代次在导航发生时同步递增，不等路由重渲（BrowserRouter 以 transition 更新 location）：
 * popstate 监听同步计数；站内 PUSH / REPLACE 在领票与执行时直接比对当前历史项。
 */
export function useNavigationGuard() {
  const state = useRef<NavigationState>({ alive: true, seq: 0, entry: undefined });
  useLayoutEffect(() => {
    const current = state.current;
    current.alive = true;
    const pop = () => traversed(current, currentEntry());
    window.addEventListener('popstate', pop);
    return () => {
      current.alive = false;
      window.removeEventListener('popstate', pop);
    };
  }, []);
  return useCallback(
    <A extends unknown[]>(navigate: (...args: A) => void) => ticket(state.current, navigate, currentEntry),
    [],
  );
}
export type NavigationGuard = ReturnType<typeof useNavigationGuard>;
