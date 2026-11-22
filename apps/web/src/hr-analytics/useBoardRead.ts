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
) {
  const [query, setQuery] = useState({ filters: initial, generation: 0 });
  const [selected, select] = useState<Selection<Target>>();
  const [detailGeneration, setDetailGeneration] = useState(0);
  const [invalidated, setInvalidated] = useState<Invalidated>();
  const read = useReportRead<Overview>(invalidated ? null : overviewUrl(query.filters), query.generation);
  const detail = useReportRead<Detail>(selected ? detailUrl(selected, query.filters) : null, detailGeneration);

  const currentInvalidation = detailInvalidation(detail.error, detail.data);
  const blocked = currentInvalidation ?? invalidated;
  useEffect(() => {
    if (currentInvalidation) setInvalidated(currentInvalidation);
  }, [currentInvalidation]);
  const retryAt = Math.max(detail.failure?.retryAt ?? 0, read.failure?.retryAt ?? 0);
  const [lastRetryAt, setLastRetryAt] = useState(0);
  // 关闭抽屉会清掉明细失败，但不能提前解除 Retry-After。
  if (retryAt > lastRetryAt) setLastRetryAt(retryAt);
  const waiting = useReportRetryWait(Math.max(retryAt, lastRetryAt));
  const data = blocked ? undefined : read.data;

  const apply = (filters: Query) => {
    select(undefined);
    setInvalidated(undefined);
    setQuery((previous) => ({ filters, generation: previous.generation + 1 }));
  };
  const changeDetail = (selection: Selection<Target>) => {
    select(selection);
    setDetailGeneration((generation) => generation + 1);
  };
  return {
    read,
    data,
    filters: query.filters,
    detail,
    selected,
    waiting,
    forbidden: blocked === 'forbidden' || readStatus(read.error) === 403,
    login: blocked === 'login' || readStatus(read.error) === 401,
    noScope: blocked === 'scope' || data?.hasDataPermission === false,
    apply,
    retry: () => apply(query.filters),
    changeDetail,
    closeDetail: () => select(undefined),
  };
}
