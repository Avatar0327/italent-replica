import { useCallback, useState } from 'react';
import { Alert, Select } from 'antd';
import { ui } from '../../foundation/messages.js';
import { useApiClient } from '../../foundation/Session.js';
import { useFormLock } from '../../foundation/forms/FormLock.js';
import { label, useAsOf, useKnownItems, type CandidateValueProps } from './ReferenceValue.js';
import { matrixOptions, multipleHint, readMatrixCandidates, type SourceCandidate } from './source-candidates.js';
import { matrixReference } from './sources.js';
import { useRead } from './useRead.js';
import { s } from './source-messages.js';

const option = (item: SourceCandidate) => ({ value: item.id, label: label(item) });
/**
 * 审批矩阵两级选择（F-326 §5.4）：先选矩阵，再选该矩阵的角色列；值存“矩阵:角色列”。
 * 换矩阵清空角色列，未选角色列时值为空串，由整单校验拦截。已选值按 ID 回查（含已停用），不显示 UUID。
 */
export function MatrixValue({ source, approvalType, single, disabled, onChange }: CandidateValueProps) {
  const api = useApiClient();
  const lock = useFormLock();
  const asOf = useAsOf();
  const reference = matrixReference(source);
  const [pending, setPending] = useState<string>();
  const all = useRead(
    `matrix:${asOf ?? ''}:${disabled}`,
    useCallback(
      async (signal: AbortSignal) =>
        asOf && !disabled ? readMatrixCandidates(api, asOf, signal) : { items: [], hasMore: false },
      [api, asOf, disabled],
    ),
  );
  const ids = reference ? [reference.matrixId, reference.columnKey] : [];
  const query = { type: 'matrix' as const, approvalType };
  const { items, resolved } = useKnownItems(query, ids, asOf, all.data?.items);
  const head = reference?.matrixId ?? pending;
  const groups = matrixOptions([...items.values()]);
  const columns = groups.find((group) => group.head.id === head)?.columns ?? [];
  const shown = (id: string) => (items.has(id) ? label(items.get(id)!) : resolved ? s.objectUnavailable : ui.loading);
  const hint = multipleHint('matrix', reference ? items.get(reference.columnKey) : undefined, single);
  const empty = all.error ? ui.failed : all.data ? ui.empty : ui.loading;
  const off = disabled || lock.disabled;
  return (
    <div className="flow-reference">
      <Select
        aria-label={s.matrix}
        value={head ? { value: head, label: shown(head) } : undefined}
        labelInValue
        options={groups.map(({ head: item }) => option(item))}
        virtual={false}
        showSearch
        optionFilterProp="label"
        loading={!all.data && !all.error && !disabled}
        disabled={off}
        placeholder={s.pickPlaceholder}
        notFoundContent={empty}
        onChange={lock.guard(({ value }: { value: string }) => {
          setPending(value);
          if (value !== reference?.matrixId) onChange({ type: 'matrix', value: '' });
        })}
      />
      <Select
        aria-label={s.roleColumn}
        value={reference ? { value: reference.columnKey, label: shown(reference.columnKey) } : undefined}
        labelInValue
        options={columns.map(option)}
        virtual={false}
        showSearch
        optionFilterProp="label"
        disabled={off || !head}
        placeholder={s.choose}
        notFoundContent={empty}
        onChange={lock.guard(({ value }: { value: string }) => onChange({ type: 'matrix', value }))}
      />
      {hint && <Alert type="warning" message={hint} />}
      {all.data?.hasMore && <p className="flow-muted">{s.matrixMore}</p>}
      {!!all.error && <Alert type="warning" message={ui.failed} />}
    </div>
  );
}
