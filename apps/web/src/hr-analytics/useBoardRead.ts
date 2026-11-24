import { useEffect, useState } from 'react';
import { useReportRetryWait } from '../hr-reports/ReportReadState.js';
import { useReportRead } from '../hr-reports/useReportRead.js';
import { readStatus } from './model.js';

interface BoardResponse {
  asOf: string;
  hasDataPermission: boolean;
}
interface Selection<Target> {
  target: Target;
  asOf: string;
  page: number;
}
type Invalidated = 'forbidden' | 'login' | 'scope';

function detailInvalidation(error: unknown, data?: BoardResponse): Invalidated | undefined {
  if (readStatus(error) === 401) return 'login';
  if (readStatus(error) === 403) return 'forbidden';
  if (data?.hasDataPermission === false) return 'scope';
  return undefined;
}

export function useBoardRead<Query, Target, Overview extends BoardResponse, Detail extends BoardResponse>(
  initial: Query,
  overviewUrl: (query: Query) => string,
  detailUrl: (selection: Selection<Target>, query: Query) => string | null,
  inlineUrl?: (overview: Overview, query: Query, page: number) => string | null,
) {
  const [query, setQuery] = useState({ filters: initial, generation: 0 });
  const [selected, select] = useState<Selection<Target> & { open: boolean }>();
  const [detailGeneration, setDetailGeneration] = useState(0);
  const [invalidated, setInvalidated] = useState<Invalidated>();
  const read = useReportRead<Overview>(invalidated ? null : overviewUrl(query.filters), query.generation);
  const [inlinePage, setInlinePage] = useState({ page: 1, generation: 0 });
  const inline = useReportRead<Detail>(
    read.data?.hasDataPermission && inlineUrl ? inlineUrl(read.data, query.filters, inlinePage.page) : null,
    inlinePage.generation,
  );
  const inlineInvalidation = detailInvalidation(inline.error, inline.data);
  // 关闭开始时取消读取，选中项留到抽屉过渡结束以完成库内焦点归还。
  const detail = useReportRead<Detail>(
    selected?.open && !inlineInvalidation ? detailUrl(selected, query.filters) : null,
    detailGeneration,
  );

  const currentInvalidation = inlineInvalidation ?? detailInvalidation(detail.error, detail.data);
  const blocked = currentInvalidation ?? invalidated;
  useEffect(() => {
    if (currentInvalidation) setInvalidated(currentInvalidation);
    if (inlineInvalidation) select(undefined);
  }, [currentInvalidation, inlineInvalidation]);
  const retryAt = Math.max(detail.failure?.retryAt ?? 0, read.failure?.retryAt ?? 0, inline.failure?.retryAt ?? 0);
  const [lastRetryAt, setLastRetryAt] = useState(0);
  // 关闭抽屉会清掉明细失败，但不能提前解除 Retry-After。
  if (retryAt > lastRetryAt) setLastRetryAt(retryAt);
  const waiting = useReportRetryWait(Math.max(retryAt, lastRetryAt));
  const data = blocked ? undefined : read.data;

  const changeInlinePage = (page: number) => {
    setInlinePage((previous) => ({ page, generation: previous.generation + 1 }));
  };
  const apply = (filters: Query) => {
    if (inlineUrl) changeInlinePage(1);
    select(undefined);
    setInvalidated(undefined);
    setQuery((previous) => ({ filters, generation: previous.generation + 1 }));
  };
  const changeDetail = (selection: Selection<Target>) => {
    select({ ...selection, open: true });
    setDetailGeneration((generation) => generation + 1);
  };
  return {
    read,
    data,
    filters: query.filters,
    detail,
    selected: inlineInvalidation ? undefined : selected,
    inline,
    inlinePage: inlinePage.page,
    changeInlinePage,
    waiting,
    forbidden: blocked === 'forbidden' || readStatus(read.error) === 403,
    login: blocked === 'login' || readStatus(read.error) === 401,
    noScope: blocked === 'scope' || data?.hasDataPermission === false,
    apply,
    retry: () => apply(query.filters),
    changeDetail,
    detailDrawer: {
      open: selected?.open ?? false,
      onClose: () => select((current) => (current?.open ? { ...current, open: false } : current)),
      afterClose: () => select((current) => (current?.open ? current : undefined)),
    },
  };
}
