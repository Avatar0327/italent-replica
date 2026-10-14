import { Alert, Button, Select, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { ApiError, newCommand, type PageResult } from '../foundation/client.js';
import { useApiClient, useSession } from '../foundation/Session.js';
import { useFormLock } from '../foundation/forms/FormLock.js';
import { m, textValue } from './messages.js';
import type { Row } from './model.js';

/** 页面片内最小读取适配；路径、身份或代次变化时不展示上一次结果。候选与业务接口的失败不回退为演示数据。 */
export function useRead<T>(path?: string) {
  const api = useApiClient();
  const session = useSession();
  const [generation, setGeneration] = useState(0);
  const key = `${session.tenantId}/${session.identityKey}/${path}/${generation}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: unknown }>({ key: '' });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    void api.request<T>(path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ key, error });
      },
    );
    return () => controller.abort();
  }, [api, key, path]);
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    loading: !!path && (state.key !== key || (!state.data && !state.error)),
    reload: () => setGeneration((value) => value + 1),
  };
}
export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  return error ? (
    <Alert
      showIcon
      type="error"
      message={error instanceof Error ? error.message : m.failed}
      action={retry && <Button onClick={retry}>{m.refresh}</Button>}
    />
  ) : null;
}
export function useWriter(done: () => void) {
  const api = useApiClient();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [blocked, setBlocked] = useState(false);
  const reset = () => {
    setError(undefined);
    setBlocked(false);
    done();
  };
  const write = async (path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown, revision: number) => {
    if (lock.current || blocked) throw new Error(m.uncertain);
    lock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await api.request(path, { method, command: newCommand(body, revision) });
      done();
    } catch (cause) {
      setError(cause);
      if (cause instanceof ApiError && ['unknown', 'refresh', 'conflict'].includes(cause.kind)) setBlocked(true);
      throw cause;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { write, busy, error, blocked, reset };
}
export function RemoteSelect(props: {
  path: string;
  id?: string;
  value?: string | string[];
  onChange?: (value: string | string[]) => void;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  usable?: (row: Row) => boolean;
}) {
  const lock = useFormLock(props.disabled);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Row[]>([]);
  const path = `${props.path}${props.path.includes('?') ? '&' : '?'}page=${page}&pageSize=200`;
  const state = useRead<PageResult<Row>>(lock.disabled ? undefined : path);
  useEffect(() => {
    setItems([]);
    setPage(1);
  }, [props.path]);
  useEffect(() => {
    if (state.data)
      setItems((old) => [...new Map([...old, ...state.data!.items].map((row) => [row.id, row])).values()]);
  }, [state.data]);
  const options = items
    .filter((row) => !props.usable || props.usable(row))
    .map((row) => ({ value: row.id, label: row.name ?? row.id }));
  return (
    <Space direction="vertical" className="r3b-wide">
      <Select
        id={props.id}
        aria-label={props.label}
        showSearch
        optionFilterProp="label"
        allowClear
        mode={props.multiple ? 'multiple' : undefined}
        value={props.value}
        onChange={lock.guard(props.onChange)}
        options={options}
        loading={state.loading}
        disabled={lock.disabled}
        className="r3b-wide"
      />
      <Failure error={state.error} retry={state.reload} />
      {!props.path.startsWith('/api/tenant/survey360/') && state.data?.items.length === 200 && (
        <Button type="link" disabled={lock.disabled} onClick={lock.guard(() => setPage(page + 1))}>
          {m.more}
        </Button>
      )}
    </Space>
  );
}
export function FieldText({ value }: { value: unknown }) {
  return <>{textValue(value)}</>;
}
