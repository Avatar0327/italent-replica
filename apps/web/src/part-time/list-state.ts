import { useState } from 'react';
import type { Filters, Row, Sort, View } from './model.js';
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
