import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSession } from '../Session.js';
import {
  createFormStore,
  isLocked,
  type FormStore,
  type Latest,
  type Submission,
  type SubmitInput,
  type Values,
} from './store.js';
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

/** 接收回填的表单：antd FormInstance 即满足。 */
export interface DraftTarget {
  setFieldsValue(values: Values): void;
}
/**
 * 把内核草稿交给表单控件（claude_fe_rules b）。
 * - 内核状态变化（恢复、提交、重读）时整份回填 refillDraft 的结果：这些时刻表单刚打开或处于锁定，内核草稿就是用户草稿。
 * - 只有可提交字段集合变化（动态字段显隐、权限变化）时不覆盖整份表单：用户核对后继续输入的实时草稿是基准，
 *   未改字段本就等于最新记录，只把转为不可提交的字段取最新记录。
 */
export function useDraftRefill(state: Submission | undefined, submittable: readonly string[], form: DraftTarget) {
  const key = submittable.join('\n');
  const fields = useRef(key);
  const { values, latest, editedFields } = state ?? {};
  // 先登记字段集合再回填：两者同一次渲染变化时，回填按新的可提交字段判断。
  useEffect(() => {
    if (fields.current === key) return;
    fields.current = key;
    if (!latest) return;
    const submittable = key.split('\n');
    const fixed = Object.keys(latest.values).filter((field) => !submittable.includes(field));
    form.setFieldsValue(Object.fromEntries(fixed.map((field) => [field, latest.values[field]])));
  }, [form, key, latest]);
  useEffect(() => {
    if (!values) return;
    const submittable = fields.current.split('\n');
    form.setFieldsValue(refillDraft({ values, latest: latest?.values, edited: editedFields ?? [], submittable }));
  }, [form, values, latest, editedFields]);
}
