// F-323b（DEC-431①）：人员类别下拉的唯一入口。选项取 /employment-types/options（只含启用项，按任职查看权开放），
// 提交字典 ID；当前值已停用或不在选项里时仍按已保存的名称显示，不显示 ID。
import { Select } from 'antd';
import { useRead } from '../contracts/useRead.js';
import { m } from './messages.js';
import { OPTIONS_PATH } from './model.js';

interface Option {
  id: string;
  name: string;
}
const parse = (raw: unknown): Option[] => {
  const items = (raw as { items?: unknown } | undefined)?.items;
  return Array.isArray(items)
    ? items.filter((item): item is Option => typeof item?.id === 'string' && typeof item?.name === 'string')
    : [];
};

export function EmploymentTypeSelect({
  value,
  onChange,
  id,
  disabled,
  ariaLabel,
  currentName,
}: {
  value?: string | null;
  onChange?(value: string | null): void;
  id?: string;
  disabled?: boolean;
  ariaLabel: string;
  /** 已保存值的名称（后端 employmentTypeName）。 */
  currentName?: unknown;
}) {
  const read = useRead<unknown>(OPTIONS_PATH);
  const options = parse(read.data).map((item) => ({ value: item.id, label: item.name }));
  if (value && !options.some((item) => item.value === value))
    options.unshift({ value, label: typeof currentName === 'string' && currentName ? currentName : m.savedValue });
  return (
    <Select
      id={id}
      aria-label={ariaLabel}
      value={value ?? undefined}
      onChange={(next) => onChange?.(typeof next === 'string' ? next : null)}
      disabled={disabled}
      loading={read.loading}
      options={options}
      allowClear
      showSearch
      optionFilterProp="label"
      virtual={false}
    />
  );
}
