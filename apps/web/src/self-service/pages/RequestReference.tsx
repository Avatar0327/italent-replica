import { Button, Select, Space, TreeSelect } from 'antd';
import { useState } from 'react';
import { useRead } from './useRead.js';
import { requestPaths } from './request-model.js';
import { q } from './request-messages.js';
type ReferenceItem = { id: string; name: string; parentId?: string | null; selectable?: boolean };
const departmentTree = (items: ReferenceItem[]) =>
  items.map((item) => ({
    id: item.id,
    pId: item.parentId,
    value: item.id,
    title: item.name,
    disabled: item.selectable === false,
  }));
export function RequestReference({
  field,
  date,
  value,
  onChange,
  disabled,
}: {
  field: string;
  date?: string;
  value?: string | null;
  onChange?(value: string | null): void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({
    page: String(page),
    pageSize: '20',
    name: search,
    ...(date ? { asOf: date } : {}),
  });
  const read = useRead<{ items: ReferenceItem[] }>(`${requestPaths.partTime}/references/${field}?${query}`);
  const items = read.data?.items ?? [];
  if (field === 'departmentId')
    return (
      <TreeSelect
        aria-label={q.fields[field]}
        value={value}
        disabled={disabled}
        allowClear
        showSearch
        treeDefaultExpandAll
        treeNodeFilterProp="title"
        treeDataSimpleMode
        treeData={departmentTree(items)}
        onChange={(next) => onChange?.(next ?? null)}
        loading={read.loading}
        notFoundContent={read.error ? <Button onClick={read.refresh}>{q.retry}</Button> : undefined}
      />
    );
  return (
    <Select
      aria-label={q.fields[field]}
      value={value}
      disabled={disabled}
      allowClear
      showSearch
      filterOption={false}
      onSearch={(name) => {
        setSearch(name);
        setPage(1);
      }}
      onChange={(next) => onChange?.(next ?? null)}
      loading={read.loading}
      options={items.map((item) => ({ value: item.id, label: item.name, disabled: item.selectable === false }))}
      notFoundContent={read.error ? q.optionsFailed : undefined}
      popupRender={(menu) => (
        <>
          {menu}
          <Space>
            {!!read.error && <Button onClick={read.refresh}>{q.retry}</Button>}
            <Button disabled={page === 1 || read.loading} onClick={() => setPage(page - 1)}>
              {q.previous}
            </Button>
            <Button disabled={items.length < 20 || read.loading} onClick={() => setPage(page + 1)}>
              {q.next}
            </Button>
          </Space>
        </>
      )}
    />
  );
}
