import { DatePicker, Select, TreeSelect, type TreeSelectProps } from 'antd';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn.js';
import { useEffect, useState } from 'react';
import { tenantDate } from './dates.js';
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
  onChange?: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <TreeSelect
      {...props}
      className="full-width-selector"
      showSearch
      allowClear
      treeNodeFilterProp="title"
      aria-label={`${ui.organization} · ${dimension}`}
      placeholder={ui.organization}
    />
  );
}
type PersonSelectProps = {
  load(query: string, signal: AbortSignal): Promise<Choice[]>;
  disabled?: boolean;
  id?: string;
  label?: string;
} & (
  | { multiple: true; value?: Choice[]; onChange?: (value: Choice[]) => void }
  | { multiple?: false; value?: Choice; onChange?: (value: Choice | undefined) => void }
);
export function PersonSelect(props: PersonSelectProps) {
  const { load, value, disabled, id, label } = props;
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
  let emptyText: string = ui.empty;
  if (loading) emptyText = ui.loading;
  if (failed) emptyText = ui.failed;
  return (
    <Select
      id={id}
      mode={props.multiple ? 'multiple' : undefined}
      showSearch
      labelInValue
      allowClear
      filterOption={false}
      value={value}
      onChange={(next: Choice | Choice[] | undefined) => {
        if (props.multiple) props.onChange?.(Array.isArray(next) ? next : []);
        else props.onChange?.(Array.isArray(next) ? undefined : next);
      }}
      className="full-width-selector"
      onSearch={setQuery}
      loading={loading}
      disabled={disabled}
      options={options}
      aria-label={label ?? ui.person}
      placeholder={ui.searchPerson}
      notFoundContent={emptyText}
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
      defaultPickerValue={timezone ? dayjs(tenantDate(new Date(), timezone)) : undefined}
      showNow={false}
      format="YYYY-MM-DD"
      disabled={disabled || !timezone}
      aria-label={ui.date}
      placeholder={ui.date}
      onChange={(date) => onChange?.(date ? date.format('YYYY-MM-DD') : null)}
    />
  );
}
