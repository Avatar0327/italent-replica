import { useState, useSyncExternalStore } from 'react';
import { views, type Filters, type Row, type Sort, type View } from './model.js';
import type { Selection } from './PartTimeDetail.js';

interface ViewState {
  view: View;
  page: number;
  filters: Filters;
  sort?: Sort;
  checked: Row[];
  selected?: Selection;
  direct?: string;
  drawer: boolean;
}
const initialState = (view: View): ViewState => ({ view, page: 1, filters: {}, checked: [], drawer: false });

export function useViewState(view: View) {
  const [saved, setSaved] = useState(() => initialState(view));
  const current = saved.view === view ? saved : initialState(view);
  // 卡片与 Back / Forward 共用入口；在读请求副作用之前换掉旧视图状态，避免先发错参再清理。
  if (saved.view !== view) setSaved(current);
  return {
    state: current,
    patch: (next: Partial<Omit<ViewState, 'view'>>) =>
      setSaved((old) => (old.view === view ? { ...old, ...next } : old)),
    reset: () => setSaved(initialState(view)),
  };
}

export const viewOf = (params: URLSearchParams): View =>
  views.find((item) => item.key === params.get('view'))?.key ?? 'ongoing';

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}
const addressView = () => viewOf(new URLSearchParams(window.location.search));
/** 站内切视图写完地址后调用，让切换中标记先于路由 transition 生效。 */
export const viewAddressChanged = () => listeners.forEach((listener) => listener());

/**
 * 地址栏已换视图、页面仍是旧视图时为 true（F-508 P2-1）。BrowserRouter 以 transition 更新 location，
 * 新视图提交前旧表格仍在；期间旧行的操作会写进旧视图状态，提交时随上面的按视图重置丢掉。
 * 页面据此让旧列表不可交互，而不是取消按视图重置（那样会把旧视图的选中带进新视图）。
 * 直接读地址栏：按钮切换与 Back / Forward（popstate）都覆盖；外部存储的更新同步提交，不等 transition。
 */
export function useViewSwitching(view: View) {
  return useSyncExternalStore(subscribe, addressView) !== view;
}
