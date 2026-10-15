import { createContext, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSession } from '../Session.js';
import { createFormStore, isLocked, type FormStore, type Latest, type Submission, type SubmitInput } from './store.js';
import { refillDraft } from './values.js';

const Context = createContext<FormStore | undefined>(undefined);
/** 放在页面根部，不能放在会卸载的弹窗/详情内部。 */
export function FormCommands({ children }: { children: ReactNode }) {
  const [store] = useState(createFormStore);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
/**
 * resource 是恢复槽键（slot.ts slotKey）；键再按会话（租户 + 身份）隔离。
 * store 默认取页面根部的 FormCommands；页面根部会随子页切换重建时，由模块传入自己持有的存储（如合同）。
 */
export function useCommandForm(resource: string, store?: FormStore) {
  const provided = useContext(Context);
  const owner = store ?? provided;
  if (!owner) throw new Error('FormCommands provider required');
  const session = useSession();
  const key = JSON.stringify([session.tenantId, session.identityKey, resource]);
  const state = useSyncExternalStore(owner.subscribe, () => owner.get(key));
  return {
    state,
    status: state?.status ?? 'idle',
    locked: isLocked(state),
    busy: state?.status === 'submitting',
    submit: (input: SubmitInput) => owner.submit(key, input),
    reread: (read: (id?: string) => Promise<Latest>) => owner.reread(key, read),
    confirm: () => owner.confirm(key),
    clear: () => owner.clear(key),
  };
}
export type CommandForm = ReturnType<typeof useCommandForm> & { reload?: () => Promise<void> };

/**
 * 交给表单控件的草稿：重读后按 refillDraft 回填（未改与当前不可提交的字段取最新记录）。
 * 依赖只取引用与可提交字段名，结果引用稳定，调用方 setFieldsValue 不会每次渲染都重新回填。
 */
export function useDraftValues(state: Submission | undefined, submittable: readonly string[]) {
  const key = submittable.join('\n');
  const { values, latest, editedFields } = state ?? {};
  return useMemo(
    () =>
      values &&
      refillDraft({ values, latest: latest?.values, edited: editedFields ?? [], submittable: key.split('\n') }),
    [values, latest, editedFields, key],
  );
}
