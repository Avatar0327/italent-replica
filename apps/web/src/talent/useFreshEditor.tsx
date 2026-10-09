import { useEffect, useRef, useState } from 'react';
import { request } from './api.js';
import { text } from './messages.js';

/** 编辑只取当前详情中实际存在的字段，缺席与 null / false / 0 / [] 不等价（DEC-285②）。 */
export function readFields<T extends object, K extends keyof T>(item: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(item, key) && item[key] !== undefined).map((key) => [key, item[key]]),
  ) as Partial<Pick<T, K>>;
}

/** 列表仅用于定位 ID；取消、新建、换对象或租户后，旧详情不能进入编辑草稿。 */
export function useFreshEditor<T, D>(tenantId: string, path: string, toDraft: (item: T) => D) {
  const key = `${tenantId}:${path}`;
  const active = useRef(true);
  const sequence = useRef(0);
  const identity = useRef(key);
  if (identity.current !== key) {
    identity.current = key;
    sequence.current += 1;
  }
  const [result, setResult] = useState<{
    key: string;
    sequence: number;
    editor: D | null;
    loading: boolean;
    error?: string;
  }>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      sequence.current += 1;
    };
  }, []);
  const setEditor = (editor: D | null) => {
    sequence.current += 1;
    setResult({ key, sequence: sequence.current, editor, loading: false });
  };
  const edit = (id: string) => {
    const current = ++sequence.current;
    setResult({ key, sequence: current, editor: null, loading: true });
    const isCurrent = () => active.current && identity.current === key && sequence.current === current;
    void request<T>(tenantId, `${path}/${id}`)
      .then((item) => {
        if (isCurrent()) setResult({ key, sequence: current, editor: toDraft(item), loading: false });
      })
      .catch((cause: unknown) => {
        if (isCurrent()) {
          setResult({
            key,
            sequence: current,
            editor: null,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
  };
  const value = result?.key === key && result.sequence === sequence.current ? result : undefined;
  return { editor: value?.editor ?? null, setEditor, edit, loading: value?.loading ?? false, error: value?.error };
}

export function FreshEditNotice({
  state,
}: {
  state: { loading: boolean; error?: string; setEditor: (editor: null) => void };
}) {
  if (state.loading)
    return (
      <>
        <p role="status">{text.editLoading}</p>
        <button type="button" onClick={() => state.setEditor(null)}>
          {text.cancel}
        </button>
      </>
    );
  return state.error ? (
    <p role="alert">
      {text.editReadFailed}：{state.error}
    </p>
  ) : null;
}
