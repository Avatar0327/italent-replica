import { Button } from 'antd';
import { useState } from 'react';
import type { ApiClient } from '../foundation/client.js';
import { useReportRetryWait } from '../hr-reports/ReportReadState.js';
import { m as report } from '../hr-reports/messages.js';
import { useReportRead } from '../hr-reports/useReportRead.js';
import { m } from './messages.js';
import { canRetryRead } from './model.js';

type List<T> = { items: T[] };

export function useCandidates<T>(
  path: string | null,
  load?: (api: ApiClient, path: string, signal: AbortSignal) => Promise<List<T>>,
) {
  const [generation, next] = useState(0);
  const read = useReportRead<List<T>>(path, generation, load);
  const waiting = useReportRetryWait(read.failure?.retryAt ?? 0);
  return {
    items: read.data?.items ?? [],
    loading: read.loading,
    retry: canRetryRead(read.error) ? () => next((value) => value + 1) : undefined,
    waiting,
  };
}
export type CandidateState<T = unknown> = ReturnType<typeof useCandidates<T>>;

export function CandidateHint({ label, state }: { label: string; state: CandidateState }) {
  if (state.loading) return null;
  return (
    <div className="hr-structure-candidate-hint">
      <span>{m.candidateUnavailable}</span>
      {state.retry && (
        <Button
          type="link"
          size="small"
          disabled={state.waiting}
          aria-label={m.retryCandidate(label)}
          onClick={state.retry}
        >
          {report.retry}
        </Button>
      )}
    </div>
  );
}
