import { Select } from 'antd';
import { pageQuery, type ApiClient } from '../foundation/client.js';
import type { QueryField } from '../hr-reports/ReportFilters.js';
import { m as report } from '../hr-reports/messages.js';
import { CandidateHint, useCandidates, type CandidateState } from './BoardCandidates.js';
import { contractTermOptions } from './contract-board-model.js';
import { m } from './messages.js';
import { asOfBounds } from './model.js';

interface MasterCandidate {
  id: string;
  name: string;
}

async function readMasters(api: ApiClient, path: string, signal: AbortSignal) {
  const pageSize = 200;
  const items: MasterCandidate[] = [];
  for (let page = 1; page <= 1_000_000; page++) {
    const result = await api.request<{ items: Partial<MasterCandidate>[] }>(
      `${path}?${pageQuery({ page, pageSize })}`,
      { signal },
    );
    // §3.1：主数据不返回总数；只在最后一页成功且全部有可披露的 ID／名称时开放。
    if (!Array.isArray(result.items)) return { items: [] };
    for (const item of result.items) {
      if (typeof item?.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name) return { items: [] };
      items.push({ id: item.id, name: item.name });
    }
    if (result.items.length < pageSize) return { items };
  }
  return { items: [] };
}

function masterField(key: 'companyId' | 'typeId', state: CandidateState<MasterCandidate>): QueryField {
  const label = m.contract.filters[key];
  const options = state.items.map(({ id, name }) => ({ value: id, label: name }));
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

export function useContractFilterFields(enabled: boolean): QueryField[] {
  const base = '/api/tenant/contracts/master-data';
  const companies = useCandidates<MasterCandidate>(enabled ? `${base}/companies` : null, readMasters);
  const types = useCandidates<MasterCandidate>(enabled ? `${base}/types` : null, readMasters);
  const labels = m.contract.filters;
  return [
    { key: 'changeFrom', label: labels.changeFrom, type: 'date', bounds: asOfBounds },
    { key: 'changeTo', label: labels.changeTo, type: 'date', bounds: asOfBounds },
    masterField('companyId', companies),
    masterField('typeId', types),
    { key: 'termType', label: labels.termType, options: contractTermOptions },
  ];
}
