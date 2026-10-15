import { Select } from 'antd';
import { useState } from 'react';
import { useRemote } from './page-support.js';
import { pageText as m } from './messages.js';

interface Candidate {
  id: string;
  name?: string;
  code?: string;
  departmentName?: string;
}
/** 负责人、HRBP 候选取组织模块的人员候选接口；无填写权时接口拒绝，下拉提示加载失败。 */
export function PersonSelect({
  date,
  value,
  onChange,
}: {
  date: string;
  value?: string | null;
  onChange?: (value: string | null) => void;
}) {
  const [keyword, setKeyword] = useState('');
  const query = new URLSearchParams({ asOf: date, page: '1', pageSize: '50', ...(keyword ? { keyword } : {}) });
  const remote = useRemote<{ items: Candidate[] }>(`/api/tenant/org/person-candidates?${query}`);
  const options = (remote.data?.items ?? []).map((item) => ({
    value: item.id,
    label: [item.name ?? m.missing, item.departmentName].filter(Boolean).join(' · '),
  }));
  return (
    <Select
      showSearch
      allowClear
      filterOption={false}
      className="r1-wide-control"
      value={value}
      onChange={(next) => onChange?.(next ?? null)}
      onSearch={setKeyword}
      options={options}
      loading={remote.loading}
      placeholder={m.personHint}
      notFoundContent={remote.error ? m.personFailed : undefined}
    />
  );
}
/** 组织接口只返回负责人 ID；姓名按当前人员权限读取，读不到或被裁剪时明确提示，不补写。 */
export function PersonName({ id }: { id: string }) {
  const person = useRemote<{ name?: string }>(`/api/tenant/personnel/employees/${id}`);
  if (person.error) return <>{m.hiddenPerson}</>;
  if (!person.data) return <>{m.missing}</>;
  return <>{person.data.name ?? m.hiddenPerson}</>;
}
