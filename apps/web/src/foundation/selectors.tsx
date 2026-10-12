import { DatePicker, Select, TreeSelect, type TreeSelectProps } from 'antd';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn.js';
import { useEffect, useState } from 'react';
import { ui } from './messages.js';
import { useSession } from './Session.js';

export interface Choice {
  value: string;
  label: string;
}
export function OrgTreeSelect({
  dimension,
  ...props
}: {
  dimension: string;
  treeData: TreeSelectProps['treeData'];
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <TreeSelect
      {...props}
      style={{ width: '100%' }}
      showSearch
      allowClear
      treeNodeFilterProp="title"
      aria-label={`${ui.organization} · ${dimension}`}
      placeholder={ui.organization}
    />
  );
}
export function PersonSelect({
  load,
  value,
  onChange,
  disabled,
}: {
  load(query: string, signal: AbortSignal): Promise<Choice[]>;
  value?: Choice;
  onChange?: (value: Choice | undefined) => void;
  disabled?: boolean;
}) {
  const session = useSession();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Choice[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setOptions([]);
    setFailed(false);
    if (!session.tenantId || disabled) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void load(query, controller.signal)
        .then((items) => {
          if (!controller.signal.aborted) setOptions(items);
        })
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, query, session.tenantId, session.identityKey, disabled]);
  return (
    <Select
      showSearch
      labelInValue
      allowClear
      filterOption={false}
      value={value}
      onChange={onChange}
      style={{ width: '100%' }}
      onSearch={setQuery}
      loading={loading}
      disabled={disabled}
      options={options}
      aria-label={ui.person}
      placeholder={ui.searchPerson}
      notFoundContent={failed ? ui.failed : loading ? ui.loading : ui.empty}
    />
  );
}
export function TenantDatePicker({
  value,
  onChange,
  disabled,
}: {
  value?: string | null;
  onChange?: (value: string | null) => void;
  disabled?: boolean;
}) {
  const { timezone } = useSession();
  return (
    <DatePicker
      value={value ? dayjs(value).locale('zh-cn') : null}
      format="YYYY-MM-DD"
      disabled={disabled || !timezone}
      aria-label={ui.date}
      placeholder={ui.date}
      onChange={(date) => onChange?.(date ? date.format('YYYY-MM-DD') : null)}
    />
  );
}
