import { useEffect, useRef, useState, type ReactNode } from 'react';
import { request } from './api.js';
import { text } from './messages.js';

export interface FormAccess {
  readonly editableFields: readonly string[];
  readonly requiredFields: readonly string[];
  readonly blockedReason?: string;
}
export interface FormAccessState {
  readonly access: FormAccess;
  readonly blocked: boolean;
  readonly reason?: string;
  readonly loading?: boolean;
}
const EMPTY: FormAccess = { editableFields: [], requiredFields: [] };

/** 服务端给出当前对象的表单契约；切换对象时只使用新请求的结果（DEC-285②）。 */
export function useFormAccess(
  tenantId: string,
  object: string,
  original: { id: string } | null | undefined,
  readFrom?: object | null,
) {
  const operation = original ? 'update' : 'create';
  const path = `forms/${object}?operation=${operation}${original ? `&id=${original.id}` : ''}`;
  const source = useRef(readFrom);
  const generation = useRef(0);
  if (source.current !== readFrom) {
    source.current = readFrom;
    generation.current += 1;
  }
  const key = `${tenantId}:${path}:${generation.current}`;
  const active = original !== undefined;
  const [result, setResult] = useState<{ key: string; access?: FormAccess; error?: string }>();
  useEffect(() => {
    if (!active) {
      setResult(undefined);
      return;
    }
    let current = true;
    setResult({ key });
    void request<FormAccess>(tenantId, path)
      .then((access) => current && setResult({ key, access }))
      .catch((cause: unknown) => {
        if (current) setResult({ key, error: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      current = false;
    };
  }, [tenantId, path, key, active]);
  const value = active && result?.key === key ? result : undefined;
  const loaded = value?.access;
  // 详情读取与契约取得之间也可能授权；未读到的值不能变成新获权字段的默认草稿。
  const access = loaded
    ? {
        ...loaded,
        editableFields: loaded.editableFields.filter(
          (field) => !readFrom || (Object.hasOwn(readFrom, field) && Reflect.get(readFrom, field) !== undefined),
        ),
      }
    : EMPTY;
  const unread = !!loaded && loaded.editableFields.length !== access.editableFields.length;
  const noEditable = !!loaded && access.editableFields.length === 0;
  return {
    access,
    blocked: !loaded || !!loaded.blockedReason || noEditable,
    reason:
      value?.error ??
      value?.access?.blockedReason ??
      (unread ? text.editUnread : noEditable ? text.noEditableFields : !loaded ? text.formLoading : undefined),
    loading: !value?.access && !value?.error,
  } satisfies FormAccessState;
}

export const canEdit = (access: FormAccess | undefined, field: string) => !!access?.editableFields.includes(field);

/** 提交只带契约允许的字段；裁剪值不从历史对象补回（DEC-285②）。 */
export function editableBody<T extends Record<string, unknown>>(body: T, access: FormAccess): Partial<T> {
  return Object.fromEntries(Object.entries(body).filter(([field]) => canEdit(access, field))) as Partial<T>;
}

export function Editable({ access, field, children }: { access?: FormAccess; field: string; children: ReactNode }) {
  return canEdit(access, field) ? children : null;
}

export function AccessNotice({ state }: { state: FormAccessState }) {
  return state.reason ? <p role={state.loading ? 'status' : 'alert'}>{state.reason}</p> : null;
}
