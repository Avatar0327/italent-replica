import { Button, Checkbox, Select, TreeSelect } from 'antd';
import { useState } from 'react';
import { pageQuery, type ApiClient } from '../foundation/client.js';
import { QueryFilters, type QueryField } from '../hr-reports/ReportFilters.js';
import { useReportRetryWait } from '../hr-reports/ReportReadState.js';
import { m as report } from '../hr-reports/messages.js';
import type { Filters } from '../hr-reports/model.js';
import { useReportRead } from '../hr-reports/useReportRead.js';
import { m } from './messages.js';
import { canRetryRead, validAsOf } from './model.js';
import { dictionaryFilters, includeChildrenDefaults, organizationFilters, structureOrgUrl } from './structure-model.js';

interface OrgCandidate {
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
}
interface Candidate {
  id?: string;
  code?: string;
  name?: string;
}
type List<T> = { items: T[] };
type Choice = { label: string; value: string };

async function readSequences(api: ApiClient, path: string, signal: AbortSignal): Promise<List<Candidate>> {
  const pageSize = 200;
  const items: Candidate[] = [];
  for (let page = 1; page <= 1_000_000; page++) {
    const result = await api.request<List<Candidate> & { hasDataPermission: boolean }>(
      `${path}&${pageQuery({ page, pageSize })}`,
      { signal },
    );
    // 职位序列接口没有 total。仅在末页成功后发布完整候选。
    if (!result.hasDataPermission) return { items: [] };
    items.push(...result.items);
    if (result.items.length < pageSize) return { items };
  }
  return { items: [] };
}

function useCandidates<T>(
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
type CandidateState = ReturnType<typeof useCandidates<unknown>>;

function CandidateHint({ label, state }: { label: string; state: CandidateState }) {
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

function choices(items: Candidate[], field: 'id' | 'code' | 'name'): Choice[] {
  // 字段被裁剪时不能用另一个字段或 ID 代替选择值。
  if (items.some((item) => !item.name || !item[field])) return [];
  return items.map((item) => ({ label: item.name!, value: item[field]! }));
}

function dictionaryField(
  key: (typeof dictionaryFilters)[number],
  options: Choice[],
  state: CandidateState,
): QueryField {
  const label = m.filters[key];
  return {
    key,
    label,
    options,
    control: (value, busy, change) => (
      <>
        <Select<string>
          aria-label={label}
          value={value || undefined}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={options.length ? report.all : undefined}
          loading={state.loading}
          disabled={busy || !options.length}
          options={options}
          onChange={(next) => change(next ?? '')}
        />
        {!options.length && <CandidateHint label={label} state={state} />}
      </>
    ),
  };
}

function organizationFields(state: ReturnType<typeof useCandidates<OrgCandidate>>): QueryField[] {
  const treeData = state.items.map(({ id, name, parentId, enabled }) => ({
    id,
    parentId,
    value: id,
    title: enabled ? name : m.inactive(name),
  }));
  return (Object.keys(organizationFilters) as (keyof typeof organizationFilters)[]).flatMap((key) => {
    const label = m.filters[key];
    return [
      {
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
          const descendants = filters[organizationFilters[key]] === 'false' ? m.withoutDescendants : m.descendants;
          return `${label} ${name}（${descendants}）`;
        },
      },
      {
        key: organizationFilters[key],
        label: '',
        control: (value, busy, change) => (
          <Checkbox
            checked={value !== 'false'}
            disabled={busy || !treeData.length}
            aria-label={`${label}${m.descendants}`}
            onChange={(event) => change(String(event.target.checked))}
          >
            {m.descendants}
          </Checkbox>
        ),
        appliedText: () => undefined,
      },
    ];
  });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function StructureFilters({
  today,
  asOf,
  applied,
  busy,
  forbidden,
  waiting,
  apply,
}: {
  today: string;
  asOf: string;
  applied?: Filters;
  busy: boolean;
  forbidden: boolean;
  waiting: boolean;
  apply(filters: Filters): void;
}) {
  // 单值筛选变动不改变同一统计日的候选域。换页、会话或权限刷新由上层卸载清退全部候选。
  const org = useCandidates<OrgCandidate>(forbidden ? null : structureOrgUrl(asOf));
  const sequences = useCandidates<Candidate>(
    forbidden ? null : `/api/tenant/job/sequences?${new URLSearchParams({ asOf })}`,
    readSequences,
  );
  const forms = useCandidates<Candidate>(forbidden ? null : '/api/tenant/employment/employment-forms');
  const categories = useCandidates<Candidate>(forbidden ? null : '/api/tenant/employment/employment-types/options');
  if (forbidden) return null;
  const hasAppliedFilters = applied && Object.keys(m.filters).some((key) => applied[key]);
  return (
    <QueryFilters
      fields={[
        ...organizationFields(org),
        dictionaryField('sequenceId', choices(sequences.items, 'id'), sequences),
        dictionaryField('employmentForm', choices(forms.items, 'code'), forms),
        dictionaryField('employmentType', choices(categories.items, 'name'), categories),
      ]}
      initial={includeChildrenDefaults}
      busy={busy}
      applied={hasAppliedFilters ? applied : undefined}
      submitDisabled={waiting}
      validate={(filters) =>
        validAsOf(asOf) &&
        ['institutionId', 'departmentId', 'sequenceId'].every((key) => !filters[key] || uuid.test(filters[key]))
      }
      apply={(filters) => apply({ ...filters, asOf: applied?.asOf ?? today })}
    />
  );
}
