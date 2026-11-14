import { Button, Select, Space } from 'antd';
import { useState } from 'react';
import type { PageResult } from '../foundation/client.js';
import { ui } from '../foundation/messages.js';
import { PageState } from '../foundation/PageState.js';
import { base } from './model.js';
import { m } from './messages.js';
import { useResource } from './useResource.js';

type Option = { value: string; label: string };
const PAGE_SIZE = 50;

export function FilterCandidates({
  resource,
  label,
  value,
  onChange,
}: {
  resource: string;
  label: string;
  value?: Option[];
  onChange?(value: Option[]): void;
}) {
  const [query, setQuery] = useState({ search: '', offset: 0 });
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(query.offset) });
  if (query.search.trim()) params.set('q', query.search.trim());
  const list = useResource<PageResult<{ id: string; name: string }>>(`${base}/${resource}?${params}`);
  return (
    <Select
      aria-label={label}
      mode="multiple"
      allowClear
      labelInValue
      value={value}
      onChange={onChange}
      showSearch
      filterOption={false}
      autoClearSearchValue={false}
      searchValue={query.search}
      onSearch={(search) => setQuery({ search, offset: 0 })}
      onClear={() => setQuery({ search: '', offset: 0 })}
      loading={list.loading}
      options={(list.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))}
      notFoundContent={list.loading ? ui.loading : m.noMatch}
      popupRender={(menu) => (
        <>
          {list.error ? <PageState kind="error" error={list.error} retry={list.refresh} /> : menu}
          <Space onMouseDown={(event) => event.preventDefault()}>
            <Button
              size="small"
              disabled={list.loading || query.offset === 0}
              onClick={() => setQuery((current) => ({ ...current, offset: current.offset - PAGE_SIZE }))}
            >
              {ui.previous}
            </Button>
            <Button
              size="small"
              disabled={list.loading || !!list.error || query.offset + PAGE_SIZE >= (list.data?.total ?? 0)}
              onClick={() => setQuery((current) => ({ ...current, offset: current.offset + PAGE_SIZE }))}
            >
              {ui.next}
            </Button>
          </Space>
        </>
      )}
    />
  );
}
