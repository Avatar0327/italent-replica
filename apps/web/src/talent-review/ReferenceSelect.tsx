import { Select } from 'antd';
import { useEffect, useState } from 'react';
import { useApiClient } from '../foundation/Session.js';
import type { PageResult } from '../foundation/client.js';
import type { ReviewRecord } from './types.js';
import { tr } from './messages.js';
/** 候选接口按服务端权限返回；名称缺失只回显 ID，不使用合成名称替换真实关联。 */
export function ReferenceSelect({
  path,
  value,
  onChange,
  multiple = false,
}: {
  path: string;
  value?: string | string[] | null;
  onChange?: (value: unknown) => void;
  multiple?: boolean;
}) {
  const api = useApiClient();
  const [items, setItems] = useState<ReviewRecord[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setError(false);
    void (async () => {
      const rows: ReviewRecord[] = [];
      for (let page = 1; page <= 20; page++) {
        const result = await api.request<PageResult<ReviewRecord>>(`${path}?page=${page}&pageSize=200`, {
          signal: controller.signal,
        });
        rows.push(...result.items);
        if (result.items.length < 200 || result.hasMore === false) {
          if (!controller.signal.aborted) setItems(rows);
          return;
        }
      }
      throw new Error(tr.loadLimit);
    })().catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [api, path]);
  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      mode={multiple ? 'multiple' : undefined}
      value={value}
      onChange={onChange}
      placeholder={tr.choose}
      status={error ? 'error' : undefined}
      options={items.map((item) => ({ value: item.id, label: item.name ?? item.id }))}
      notFoundContent={error ? tr.catalogError : tr.empty}
    />
  );
}
