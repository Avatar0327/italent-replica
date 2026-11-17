import { useCallback, useEffect, useState } from 'react';
import { Alert, Select } from 'antd';
import type { ApproverSource } from '@italent/domain';
import { tenantDate } from '../../foundation/dates.js';
import { ui } from '../../foundation/messages.js';
import { useApiClient, useSession } from '../../foundation/Session.js';
import { useFormLock } from '../../foundation/forms/FormLock.js';
import {
  modeOptions,
  multipleHint,
  readCandidates,
  type CandidatePage,
  type CandidateQuery,
  type SourceCandidate,
} from './source-candidates.js';
import { referenceOf, referenceValue, type SourceOption } from './sources.js';
import { useRead } from './useRead.js';
import { s } from './source-messages.js';

export const label = (item: SourceCandidate) => (item.enabled ? item.name : `${item.name} · ${s.disabledObject}`);
/** 业务日期以租户时区的今天为候选基准（DEC-056）；实际派单时仍按申请业务日重新解析。 */
export function useAsOf() {
  const { timezone } = useSession();
  return timezone ? tenantDate(new Date(), timezone) : undefined;
}
/** 搜索结果只在关键字变化后 200ms 重读；换类型或卸载立即取消，迟到回执不能覆盖当前选项。 */
function useCandidates(
  type: ApproverSource['type'],
  asOf: string | undefined,
  keyword: string,
  off: boolean,
  approvalType: string,
) {
  const api = useApiClient();
  const [state, setState] = useState<{ page?: CandidatePage; failed: boolean; loading: boolean }>({
    failed: false,
    loading: false,
  });
  useEffect(() => {
    if (!asOf || off) return;
    const controller = new AbortController();
    setState({ failed: false, loading: true });
    const timer = setTimeout(() => {
      readCandidates(api, { type, asOf, keyword, approvalType }, controller.signal).then(
        (page) => !controller.signal.aborted && setState({ page, failed: false, loading: false }),
        () => !controller.signal.aborted && setState({ failed: true, loading: false }),
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, type, asOf, keyword, off, approvalType]);
  return state;
}

/** 已选对象按 ID 回查名称（含已停用）；与当前搜索结果合并，回查完成后仍缺失才视为对象不可用。 */
export function useKnownItems(
  query: Omit<CandidateQuery, 'asOf' | 'ids'>,
  ids: readonly string[],
  asOf: string | undefined,
  found?: readonly SourceCandidate[],
) {
  const api = useApiClient();
  const { type, approvalType } = query;
  const key = ids.join(',');
  const known = useRead(
    `${type}:${approvalType ?? ''}:${key}:${asOf ?? ''}`,
    useCallback(
      async (signal: AbortSignal) =>
        key && asOf ? (await readCandidates(api, { type, approvalType, asOf, ids: key.split(',') }, signal)).items : [],
      [api, type, approvalType, key, asOf],
    ),
  );
  const items = new Map<string, SourceCandidate>();
  for (const item of [...(known.data ?? []), ...(found ?? [])]) items.set(item.id, item);
  return { items, resolved: !!known.data || !!known.error };
}
export interface CandidateValueProps {
  source: ApproverSource;
  approvalType: string;
  /** 单人节点的主审批人：选到多人变量 / 角色列时即时提示（F-326 §5.4）。 */
  single: boolean;
  disabled: boolean;
  onChange(source: ApproverSource): void;
}
/** 组织 / 职位 / 职务 / 身份 / 变量的取值：固定表达式与候选对象同一个下拉；对象选中后按类型给取值方式。 */
export function ReferenceValue({
  source,
  fixed,
  approvalType,
  single,
  disabled,
  onChange,
}: CandidateValueProps & { fixed: readonly SourceOption[] }) {
  const lock = useFormLock();
  const asOf = useAsOf();
  const [keyword, setKeyword] = useState('');
  const reference = referenceOf(source);
  const list = useCandidates(source.type, asOf, keyword, disabled, approvalType);
  const query = { type: source.type, approvalType };
  const { items, resolved } = useKnownItems(query, reference ? [reference.id] : [], asOf, list.page?.items);
  const hint = multipleHint(source.type, reference ? items.get(reference.id) : undefined, single);
  const options = [
    ...(fixed.length
      ? [{ label: s.fixedGroup, options: fixed.map(({ value, label, disabled }) => ({ value, label, disabled })) }]
      : []),
    {
      label: s.pick(s.types[source.type]),
      options: [...items.values()].map((item) => ({ value: item.id, label: label(item) })),
    },
  ];
  // 回查失败或对象已不存在时显示固定提示而非对象 UUID。
  const shown = reference
    ? items.has(reference.id)
      ? label(items.get(reference.id)!)
      : resolved
        ? s.objectUnavailable
        : ui.loading
    : fixed.find((item) => item.value === source.value)?.label;
  const current = source.value
    ? { value: reference ? reference.id : source.value, label: shown ?? s.objectUnavailable }
    : undefined;
  const modes = modeOptions(source.type);
  const empty = list.loading ? ui.loading : list.failed ? ui.failed : ui.empty;
  return (
    <div className="flow-reference">
      <Select
        aria-label={s.value}
        value={current}
        labelInValue
        options={options}
        virtual={false}
        showSearch
        filterOption={false}
        onSearch={setKeyword}
        loading={list.loading}
        disabled={disabled || lock.disabled}
        placeholder={s.pickPlaceholder}
        notFoundContent={empty}
        onChange={lock.guard(({ value }: { value: string }) => {
          const fixedValue = fixed.some((item) => item.value === value);
          onChange({ type: source.type, value: fixedValue ? value : referenceValue(value, reference?.mode ?? 'self') });
        })}
      />
      {reference && modes.length > 0 && (
        <Select
          aria-label={s.mode}
          value={reference.mode}
          options={modes}
          virtual={false}
          disabled={disabled || lock.disabled}
          onChange={lock.guard((mode: string) =>
            onChange({ type: source.type, value: referenceValue(reference.id, mode) }),
          )}
        />
      )}
      {hint && <Alert type="warning" message={hint} />}
      {list.page?.hasMore && <p className="flow-muted">{s.candidatesMore}</p>}
      {list.failed && <Alert type="warning" message={ui.failed} />}
    </div>
  );
}
