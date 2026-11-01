import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/** 页面导航代次：页面是否仍挂载、当前 location.key。 */
export interface NavigationState {
  alive: boolean;
  key: string;
}

/** 领票时记下代次；执行时页面仍在且期间没有发生导航才执行，否则丢弃这次导航。 */
export function ticket<A extends unknown[]>(state: NavigationState, navigate: (...args: A) => void) {
  const key = state.key;
  return (...args: A) => {
    if (state.alive && state.key === key) navigate(...args);
  };
}

/**
 * 写结果确认与页面导航分开（F-376，F-285 R3 P2-R3-F1）：已发出的写命令照常按原命令上下文确认
 * （未确认命令、成功提示照旧，DEC-464 / DEC-473），但写确认后的页面导航只经这里的票据执行——
 * 提交开始时领票；HR 后退离开页面或期间发生了别的导航，迟到的回调不再把用户带回旧页面。
 * 页面级（随页面挂载），不随表单卸载作废：表单关了、页面还在且没导航时照常切视图。
 */
export function useNavigationGuard() {
  const { key } = useLocation();
  const state = useRef<NavigationState>({ alive: true, key });
  useLayoutEffect(() => {
    state.current.key = key;
  }, [key]);
  useLayoutEffect(() => {
    const current = state.current;
    current.alive = true;
    return () => {
      current.alive = false;
    };
  }, []);
  return useCallback(<A extends unknown[]>(navigate: (...args: A) => void) => ticket(state.current, navigate), []);
}
export type NavigationGuard = ReturnType<typeof useNavigationGuard>;
