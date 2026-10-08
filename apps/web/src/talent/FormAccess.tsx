import { useEffect, useState, type ReactNode } from 'react';
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
export function useFormAccess(tenantId: string, object: string, original: { id: string } | null | undefined) {
  const operation = original ? 'update' : 'create';
  const path = `forms/${object}?operation=${operation}${original ? `&id=${original.id}` : ''}`;
  const key = `${tenantId}:${path}`;
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
  const noEditable = value?.access?.editableFields.length === 0;
  return {
    access: value?.access ?? EMPTY,
    blocked: !value?.access || !!value.access.blockedReason || noEditable,
    reason:
      value?.error ??
      value?.access?.blockedReason ??
      (noEditable ? text.noEditableFields : !value?.access ? text.formLoading : undefined),
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
