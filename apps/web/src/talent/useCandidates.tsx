import { useEffect, useState } from 'react';
import { listAll, type DimensionType } from './api.js';
import { text } from './messages.js';

export interface CandidateState<T> {
  readonly items: readonly T[] | undefined;
  readonly status: 'loading' | 'ready' | 'error';
  readonly error?: string;
}

/** 每个候选源独立加载；请求键变化立即裁掉旧选项，忽略已经过期的响应。 */
export function useCandidates<T>(tenantId: string, path: string, enabled = true): CandidateState<T> {
  const key = `${tenantId}:${path}:${enabled}`;
  const [result, setResult] = useState<{ key: string; items?: T[]; error?: string }>();
  useEffect(() => {
    if (!enabled) {
      setResult(undefined);
      return;
    }
    let active = true;
    setResult({ key });
    void listAll<T>(tenantId, path)
      .then((items) => active && setResult({ key, items }))
      .catch((cause: unknown) => {
        if (active) setResult({ key, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      active = false;
    };
  }, [tenantId, path, enabled, key]);
  const value = result?.key === key ? result : undefined;
  return {
    items: value?.items,
    status: value?.error ? 'error' : value?.items ? 'ready' : 'loading',
    error: value?.error,
  };
}

export const candidatesBlocked = <T,>(state: CandidateState<T>) => state.status !== 'ready' || !state.items?.length;

/** 字段裁剪后的候选仍可以按 ID 辨认，不补回无权查看的名称与类型。 */
export const candidateLabel = (item: { id: string; name?: string; type?: DimensionType }) =>
  `${item.name ?? item.id}${item.type ? `（${text.types[item.type]}）` : ''}`;

export function CandidateNotice<T>({ state, label }: { state: CandidateState<T>; label: string }) {
  if (state.status === 'loading')
    return (
      <p role="status">
        {label}：{text.candidatesLoading}
      </p>
    );
  if (state.status === 'error')
    return (
      <p role="alert">
        {label}：{text.candidatesFailed}（{state.error}）
      </p>
    );
  return state.items?.length ? null : (
    <p role="status">
      {label}：{text.candidatesEmpty}
    </p>
  );
}
