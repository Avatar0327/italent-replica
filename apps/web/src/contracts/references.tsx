import { Select } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
import { tenantDate } from '../foundation/dates.js';
import type { PageResult } from '../foundation/client.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import type { Choice } from '../foundation/selectors.js';
import { m } from './messages.js';
import type { Row } from './model.js';
import { useRead } from './useRead.js';

export const refPaths = {
  typeId: '/api/tenant/contracts/master-data/types',
  companyId: '/api/tenant/contracts/master-data/companies',
  orgId: '/api/tenant/org/organizations',
  employeeId: '/api/tenant/personnel/employees',
  departmentId: '/api/tenant/org/organizations',
  postId: '/api/tenant/job/posts',
  positionId: '/api/tenant/job/positions',
} as const;
const label = (row: Row) => String(row.name ?? row.code ?? row.id);
type Api = ReturnType<typeof useApiClient>;
/** 同一时刻多个单元格读同一候选集时共用一次请求；结束即移除，不跨刷新缓存（撤权后不残留）。 */
const inflight = new WeakMap<Api, Map<string, Promise<Row[]>>>();
async function readAll(api: Api, path: string) {
  const rows: Row[] = [];
  for (let page = 1; page <= 5; page++) {
    const result = await api.request<PageResult<Row>>(`${path}?page=${page}&pageSize=200`);
    rows.push(...result.items);
    if (result.items.length < 200) return rows;
  }
  throw new Error(m.optionsLimit);
}
function shared(api: Api, path: string) {
  const pending = inflight.get(api) ?? new Map<string, Promise<Row[]>>();
  inflight.set(api, pending);
  const existing = pending.get(path);
  if (existing) return existing;
  const request = readAll(api, path).finally(() => pending.delete(path));
  pending.set(path, request);
  return request;
}
/** 候选按服务端权限逐页读取（有界）；读不全时报错，不把截断结果当完整集合。 */
export function useOptions(path: string | null) {
  const api = useApiClient();
  const [state, setState] = useState<{ path: string; rows?: Row[]; error?: boolean }>();
  useEffect(() => {
    if (!path) return;
    let active = true;
    shared(api, path).then(
      (rows) => active && setState({ path, rows }),
      () => active && setState({ path, error: true }),
    );
    return () => {
      active = false;
    };
  }, [api, path]);
  const current = state?.path === path ? state : undefined;
  return {
    rows: current?.rows ?? [],
    error: !!current?.error,
    options: (current?.rows ?? []).map((row) => ({
      value: String(row.id),
      label: label(row),
      disabled: row.enabled === false,
    })),
  };
}
export function RefSelect({
  path,
  value,
  onChange,
  multiple,
  disabled,
  ariaLabel,
}: {
  path: string;
  value?: string | string[] | null;
  onChange?: (value: string | string[] | null) => void;
  multiple?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { options, error } = useOptions(path);
  const lock = useFormLock(disabled);
  // 已停用 / 无权查看的旧值仍显示 ID，不用合成名称替换真实关联。
  const known = new Set(options.map((option) => option.value));
  const extra = (Array.isArray(value) ? value : value ? [value] : []).filter((id) => !known.has(id));
  return (
    <Select
      showSearch
      allowClear
      aria-label={ariaLabel}
      optionFilterProp="label"
      mode={multiple ? 'multiple' : undefined}
      value={value ?? (multiple ? [] : undefined)}
      disabled={lock.disabled}
      onChange={lock.guard((next: string | string[] | undefined) => onChange?.(next ?? (multiple ? [] : null)))}
      placeholder={m.choose}
      status={error ? 'error' : undefined}
      notFoundContent={error ? m.optionsError : m.empty}
      options={[...options, ...extra.map((id) => ({ value: id, label: id, disabled: false }))]}
    />
  );
}
/** 业务日按租户时区（DEC-056）；快照给了 today 时以服务端为准。 */
export function useToday() {
  const session = useSession();
  return session.today ?? (session.timezone ? tenantDate(new Date(), session.timezone) : undefined);
}
/** 任职摘要只给 ID；名称按组织 / 岗位已有接口在业务日解析，读不到时显示 ID。 */
export function NameOf({ path, id, asOf }: { path: string; id: unknown; asOf?: string }) {
  const valid = typeof id === 'string' && id.length > 0;
  const result = useRead<Row>(valid ? `${path}/${encodeURIComponent(id)}${asOf ? `?asOf=${asOf}` : ''}` : null);
  if (!valid) return <>--</>;
  return <>{result.data?.name ? String(result.data.name) : id}</>;
}
export function RefLabel({ path, id }: { path: string; id: unknown }) {
  const { options } = useOptions(typeof id === 'string' && id ? path : null);
  if (typeof id !== 'string' || !id) return <>--</>;
  return <>{options.find((option) => option.value === id)?.label ?? id}</>;
}
export function RefLabels({ path, ids }: { path: string; ids: unknown }) {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  const { options } = useOptions(list.length ? path : null);
  if (!list.length) return <>--</>;
  return <>{list.map((id) => options.find((option) => option.value === id)?.label ?? id).join('、')}</>;
}
/** 人员候选：人事列表按姓名精确筛选（personnel/lists.ts），与资格模块的人员选择一致。 */
export function usePeople() {
  const api = useApiClient();
  return useCallback(
    async (search: string, signal: AbortSignal): Promise<Choice[]> => {
      const query = new URLSearchParams({ page: '1', pageSize: '20', ...(search ? { employeeName: search } : {}) });
      const result = await api.request<PageResult<Row>>(`${refPaths.employeeId}?${query}`, { signal });
      return result.items.map((row) => ({ value: String(row.id), label: label(row) }));
    },
    [api],
  );
}
/** 多选人员（续签规则人员范围）；已选但不在当前候选中的人员保留 ID 显示。 */
export function PeopleSelect({
  value = [],
  onChange,
  disabled,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
}) {
  const load = usePeople();
  const lock = useFormLock(disabled);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Choice[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => void load(query, controller.signal).then(setOptions, () => !controller.signal.aborted && setOptions([])),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);
  const known = new Set(options.map((option) => option.value));
  return (
    <Select
      mode="multiple"
      showSearch
      filterOption={false}
      aria-label={m.fields.personIds}
      value={value}
      disabled={lock.disabled}
      onSearch={setQuery}
      onChange={lock.guard((next: string[]) => onChange?.(next))}
      placeholder={m.choose}
      options={[...options, ...value.filter((id) => !known.has(id)).map((id) => ({ value: id, label: id }))]}
    />
  );
}
