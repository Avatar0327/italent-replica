import { Button, TreeSelect } from 'antd';
import { useState } from 'react';
import type { ApiClient } from '../foundation/client.js';
import type { QueryField } from '../hr-reports/ReportFilters.js';
import { useReportRetryWait } from '../hr-reports/ReportReadState.js';
import { m as report } from '../hr-reports/messages.js';
import { useReportRead } from '../hr-reports/useReportRead.js';
import { m } from './messages.js';
import { canRetryRead } from './model.js';

export interface OrgCandidate {
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
}

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

export const candidateUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function organizationField(
  state: CandidateState<OrgCandidate>,
  key: string,
  label: string,
  includeChildren?: string,
): QueryField {
  const treeData = state.items.map(({ id, name, parentId, enabled }) => ({
    id,
    parentId,
    value: id,
    title: enabled ? name : m.inactive(name),
  }));
  return {
    key,
    label,
    control: (value, busy, change) => (
      <>
        <TreeSelect<string>
          aria-label={label}
          value={value || undefined}
          allowClear
          showSearch
          treeNodeFilterProp="title"
          treeDataSimpleMode={{ id: 'id', pId: 'parentId' }}
          treeData={treeData}
          placeholder={treeData.length ? report.all : undefined}
          loading={state.loading}
          disabled={busy || !treeData.length}
          onChange={(next) => change(next ?? '')}
        />
        {!treeData.length && <CandidateHint label={label} state={state} />}
      </>
    ),
    appliedText: (value, filters) => {
      const name = treeData.find((node) => node.value === value)?.title ?? value;
      const descendants =
        includeChildren && filters[includeChildren] === 'false' ? m.withoutDescendants : m.descendants;
      return `${label} ${name}（${descendants}）`;
    },
  };
}
