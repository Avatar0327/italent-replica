import { Checkbox, type TableColumnsType } from 'antd';
import { useEffect, useState } from 'react';
import type { PageResult } from '../foundation/client.js';
import { useSession } from '../foundation/Session.js';
import { base, type UserMou } from './model.js';
import { useResource } from './useResource.js';
import { m } from './messages.js';

export function useSettingsList<T>(resource: string, fixed: Record<string, string> = {}) {
  const [page, setPage] = useState({ page: 1, pageSize: 15 });
  const [filters, setFilters] = useState<Record<string, string>>({});
  const query = new URLSearchParams({
    ...fixed,
    ...filters,
    limit: String(page.pageSize),
    offset: String((page.page - 1) * page.pageSize),
  });
  const list = useResource<PageResult<T>>(`${base}/${resource}?${query}`);
  useEffect(() => {
    const total = list.data?.total;
    if (total !== undefined && page.page > 1 && (page.page - 1) * page.pageSize >= total)
      setPage((current) => ({ ...current, page: Math.max(1, Math.ceil(total / current.pageSize)) }));
  }, [list.data, page.page, page.pageSize]);
  return {
    ...list,
    page,
    setPage,
    apply: (values: Record<string, string>) => {
      setFilters(values);
      setPage((current) => ({ ...current, page: 1 }));
    },
  };
}

export function useRowSelection<T extends object>(items: T[], key: (row: T) => string): TableColumnsType<T> {
  const [selected, setSelected] = useState<{ items: T[]; keys: string[] }>({ items, keys: [] });
  const keys = selected.items === items ? selected.keys : [];
  return [
    {
      key: 'selection',
      width: 30,
      title: (
        <Checkbox
          aria-label={m.selectPage}
          disabled={!items.length}
          checked={!!items.length && keys.length === items.length}
          indeterminate={keys.length > 0 && keys.length < items.length}
          onChange={(event) => setSelected({ items, keys: event.target.checked ? items.map(key) : [] })}
        />
      ),
      render: (_: unknown, row: T) => (
        <Checkbox
          aria-label={m.selectRow}
          checked={keys.includes(key(row))}
          onChange={(event) =>
            setSelected({
              items,
              keys: event.target.checked ? [...keys, key(row)] : keys.filter((id) => id !== key(row)),
            })
          }
        />
      ),
    },
  ];
}

export function useListInstant() {
  const { timezone } = useSession();
  return (value?: string | null) =>
    value && timezone
      ? new Intl.DateTimeFormat('zh-CN', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).format(new Date(value))
      : (value ?? m.empty);
}
export const textValue = (value?: string | null) => value || m.empty;
export const columnGear = { key: 'columns', title: '', width: 24, render: () => <span aria-hidden>⚙</span> };
export const mouText = (values?: UserMou[]) =>
  values?.map((row) => `${row.appCode}：${row.name}`).join('、') || m.empty;
export const mouOptions = (items: { mous?: UserMou[] }[]) =>
  uniqueOptions(items.flatMap((item) => (item.mous ?? []).map((row) => ({ value: row.mouId, label: row.name }))));
export function uniqueOptions(items: { value: string; label: string }[]) {
  return [...new Map(items.map((row) => [row.value, row])).values()];
}
