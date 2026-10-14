import { Select } from 'antd';
import { useCallback, type AriaAttributes } from 'react';
import type { PageResult } from '../foundation/client.js';
import { PersonSelect } from '../foundation/selectors.js';
import { useApiClient } from '../foundation/Session.js';
import { useCollection } from './api.js';
import { t } from './messages.js';
import { useNames } from './useNames.js';

/** 表单项注入的 id 与 aria-* 要透传到真实输入，标签才能关联到控件（LockedField 同口径）。 */
type Labelled = { id?: string } & Pick<AriaAttributes, 'aria-label' | 'aria-describedby' | 'aria-invalid'>;

/** 候选按服务端权限返回；失败时显示错误而不是合成候选（DEC-494）。名称缺失回显 ID。 */
export function CatalogSelect({
  path,
  value,
  onChange,
  disabled,
  ...labelled
}: Labelled & {
  path: string;
  value?: string | null;
  onChange?: (value: string | undefined) => void;
  disabled?: boolean;
}) {
  const catalog = useCollection<{ id: string; name?: string }>(path);
  return (
    <Select
      {...labelled}
      showSearch
      allowClear
      optionFilterProp="label"
      value={value ?? undefined}
      onChange={onChange}
      disabled={disabled}
      loading={catalog.loading}
      placeholder={t.choose}
      status={catalog.error ? 'error' : undefined}
      notFoundContent={catalog.error ? t.catalogError : t.empty}
      options={(catalog.items ?? []).map((item) => ({ value: item.id, label: item.name ?? item.id }))}
    />
  );
}

export const ORG_PATH = '/api/tenant/org/organizations';
const EMPLOYEE_PATH = '/api/tenant/employment/employees';

/** 表单里只存员工 ID，避免把 {value,label} 当作字段值提交或参与修改比对。 */
export function EmployeeSelect({
  value,
  onChange,
  disabled,
  id,
  ...aria
}: Labelled & {
  value?: string | null;
  onChange?: (value: string | null) => void;
  disabled?: boolean;
}) {
  const api = useApiClient();
  const name = useNames('employee', [value]);
  const load = useCallback(
    async (query: string, signal: AbortSignal) => {
      const search = query.trim() ? `&name=${encodeURIComponent(query.trim())}` : '';
      const result = await api.request<PageResult<{ id: string; name?: string }>>(
        `${EMPLOYEE_PATH}?page=1&pageSize=20${search}`,
        { signal },
      );
      return result.items.map((item) => ({ value: item.id, label: item.name ?? item.id }));
    },
    [api],
  );
  // PersonSelect（底座）不透传 id，外包一层承接表单项的 id，标签点击与读屏仍能定位到该字段
  return (
    <span id={id} {...aria} className="idp-person-select">
      <PersonSelect
        load={load}
        disabled={disabled}
        value={value ? { value, label: name(value) } : undefined}
        onChange={(choice) => onChange?.(choice?.value ?? null)}
      />
    </span>
  );
}
