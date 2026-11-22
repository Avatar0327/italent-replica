import { Button, Checkbox, TreeSelect } from 'antd';
import { useMemo, useState } from 'react';
import { m } from './messages.js';
import { validReportDate, type Filters } from './model.js';
import { useReportRetryWait } from './ReportReadState.js';
import { useReportRead } from './useReportRead.js';

interface Candidate {
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
}

export interface DepartmentContext {
  committed: Filters;
  allowed: boolean;
  object: 'HrStructureReport' | 'HrMovementReport';
}

function useDepartmentCandidates(object?: DepartmentContext['object'], asOf?: string) {
  const [generation, refresh] = useState(0);
  const path =
    object && asOf && validReportDate(asOf)
      ? `/api/tenant/analytics/organization-candidates?${new URLSearchParams({ object, asOf })}`
      : null;
  const read = useReportRead<{ items: Candidate[] }>(path, generation);
  const waiting = useReportRetryWait(read.failure?.retryAt ?? 0);
  const nodes = useMemo(
    () =>
      (read.data?.items ?? []).map(({ id, name, parentId, enabled }) => ({
        id,
        pId: parentId,
        value: id,
        title: enabled ? name : m.disabledDepartment(name),
      })),
    [read.data],
  );
  return {
    nodes,
    loading: read.loading,
    waiting,
    available: nodes.length > 0,
    retry: path && !read.loading && !nodes.length ? () => refresh((n) => n + 1) : undefined,
  };
}

export function useReportDepartment(draft: Filters, context?: DepartmentContext) {
  const candidates = useDepartmentCandidates(context?.object, context?.allowed ? draft.asOf : undefined);
  // 候选不可用时沿用已应用的部门条件，避免查询被静默扩成全部组织。
  const selected = candidates.available ? draft : context?.committed;
  const departmentId = selected?.departmentId ?? '';
  const filters = {
    departmentId,
    departmentIncludeChildren: selected?.departmentIncludeChildren ?? 'true',
    departmentLabel: candidates.nodes.find(({ id }) => id === departmentId)?.title ?? selected?.departmentLabel ?? '',
  };
  return { candidates, filters };
}

export function DepartmentFilter({
  candidates,
  filters,
  busy,
  includeChildrenToggle,
  change,
}: {
  candidates: ReturnType<typeof useDepartmentCandidates>;
  filters: Filters;
  busy: boolean;
  includeChildrenToggle: boolean;
  change(filters: Filters): void;
}) {
  const disabled = busy || !candidates.available;
  const { nodes } = candidates;
  const { departmentId, departmentLabel, departmentIncludeChildren } = filters;
  return (
    <>
      <label className="hr-report-filter">
        <span>{m.department}</span>
        <TreeSelect
          aria-label={m.department}
          className="hr-report-department"
          disabled={disabled}
          loading={candidates.loading}
          placeholder={m.all}
          allowClear
          showSearch
          treeNodeFilterProp="title"
          treeDataSimpleMode
          treeData={nodes}
          treeDefaultExpandedKeys={nodes.filter(({ pId }) => pId === null).map(({ id }) => id)}
          labelInValue
          value={departmentId ? { value: departmentId, label: departmentLabel || departmentId } : undefined}
          onChange={(selected: { value: string; label?: string } | undefined) => {
            const id = selected?.value ?? '';
            change({ departmentId: id, departmentLabel: nodes.find((node) => node.id === id)?.title ?? '' });
          }}
        />
      </label>
      {includeChildrenToggle && (
        <Checkbox
          checked={departmentIncludeChildren !== 'false'}
          disabled={disabled}
          onChange={(event) => change({ departmentIncludeChildren: String(event.target.checked) })}
        >
          {m.includeChildren}
        </Checkbox>
      )}
      {!candidates.available && !candidates.loading && <span role="status">{m.candidateUnavailable}</span>}
      {candidates.retry && (
        <Button disabled={candidates.waiting} onClick={candidates.retry}>
          {m.retryCandidates}
        </Button>
      )}
    </>
  );
}
