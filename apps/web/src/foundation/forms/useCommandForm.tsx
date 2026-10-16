import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSession } from '../Session.js';
import { createFormStore, isLocked, type FormStore, type Latest, type SubmitInput, type Values } from './store.js';
import { slotKey } from './slot.js';
import { refillDraft } from './values.js';

const Context = createContext<FormStore | undefined>(undefined);
/**
 * 放在页面根部，不能放在会卸载的弹窗/详情内部。模块的几个入口各是一页、页面根部随切换重建时，
 * 传入模块持有的 store，入口下的新建、编辑和行内命令同在这份存储里（F-164）。
 */
export function FormCommands({ children, store }: { children: ReactNode; store?: FormStore }) {
  const [own] = useState(createFormStore);
  return <Context.Provider value={store ?? own}>{children}</Context.Provider>;
}
/**
 * resource 是恢复槽键（slot.ts slotKey）；键再按会话（租户 + 身份）隔离。
 * store 默认取页面根部的 FormCommands；页面根部会随子页切换重建时，由模块传入自己持有的存储（如合同）。
 */
export function useCommandForm(resource: string, store?: FormStore) {
  return usePinnedCommand([resource], resource, store);
}
/**
 * 批量命令（F-147）：条目是集合路径 + 排序后的对象 id，逐个对象的恢复槽都钉到它。
 * 结果未知时同一对象的单条动作、别的批量都落到这条命令上，仍锁定。
 */
export function useBatchCommand(collection: string, ids: readonly string[], store?: FormStore) {
  const slots = ids.map((id) => slotKey(collection, id));
  const entry = `${slotKey(collection)}#${[...ids].sort().map(encodeURIComponent).join(',')}`;
  return usePinnedCommand(slots, entry, store);
}
/**
 * slots 是本命令涉及的恢复槽（稳定原单路径），entry 是本命令的条目：单对象就是槽本身，批量、带版本的冲突恢复另起名。
 * 提交前先把各槽钉到本条目，结果未知就一直钉着（claude_fe_rules e、g）：同对象的其他入口读到的是这条命令，
 * 关闭重开、换入口、换版本也仍锁定，不另起命令；已确认的结果（完成、被拒、冲突）放开。
 */
export function usePinnedCommand(slots: readonly string[], entry: string, store?: FormStore) {
  const provided = useContext(Context);
  const owner = store ?? provided;
  if (!owner) throw new Error('FormCommands provider required');
  const session = useSession();
  const scope = (name: string) => JSON.stringify([session.tenantId, session.identityKey, name]);
  const scoped = slots.map(scope);
  const own = scope(entry);
  const key = useSyncExternalStore(owner.subscribe, () => owner.holder(scoped) ?? own);
  const state = useSyncExternalStore(owner.subscribe, () => owner.get(key));
  return {
    state,
    status: state?.status ?? 'idle',
    locked: isLocked(state),
    busy: state?.status === 'submitting',
    async submit(input: SubmitInput) {
      const holder = owner.holder(scoped);
      const held = holder === undefined || holder === own ? undefined : owner.get(holder);
      if (isLocked(held)) return held!;
      owner.pin(scoped, own);
      const result = await owner.submit(own, input);
      if (result.status !== 'unknown') owner.unpin(scoped, own);
      return result;
    },
    /** 存储里的当前状态（不是渲染时的快照）：异步流程中途据此核对恢复槽上有没有新的未确认命令。 */
    peek: () => owner.get(owner.holder(scoped) ?? own),
    reread: (read: (id?: string) => Promise<Latest>) => owner.reread(key, read),
    settle: (submittable: readonly string[]) => owner.settle(key, submittable),
    confirm: () => owner.confirm(key),
    clear: () => owner.clear(key),
  };
}
export type CommandForm = ReturnType<typeof useCommandForm> & {
  reload?: () => Promise<void>;
  /** 本对象有别的动作未确认（forAction）：本入口不能提交，弹窗给出提示。 */
  blocked?: boolean;
};

/** 接收回填的表单：antd FormInstance 即满足。 */
export interface DraftTarget {
  setFieldsValue(values: Values): void;
}
/**
 * 把内核草稿交给表单控件（claude_fe_rules b）。
 * - 内核状态变化（恢复、提交、重读）时整份回填 refillDraft 的结果：这些时刻表单刚打开或处于锁定，内核草稿就是用户草稿。
 * - 只有可提交字段集合变化（动态字段显隐、权限变化）时不覆盖整份表单：用户核对后继续输入的实时草稿是基准，
 *   未改字段本就等于最新记录，只把转为不可提交的字段取最新记录。
 * - 转为不可提交的已改字段同时经 settle 改写内核草稿、记为未改，并把这些字段的控件值改成内核新值（最新记录没有就清空）；
 *   这次内核变化不再整份回填，免得覆盖实时草稿。
 */
export function useDraftRefill(
  command: Pick<CommandForm, 'state' | 'settle'> | undefined,
  submittable: readonly string[],
  form: DraftTarget,
) {
  const key = submittable.join('\n');
  const fields = useRef(key);
  const settled = useRef<Values>(undefined);
  const { values, latest, editedFields } = command?.state ?? {};
  const settle = command?.settle;
  // 先登记字段集合再回填：两者同一次渲染变化时，回填按新的可提交字段判断。
  useEffect(() => {
    const changed = fields.current !== key;
    fields.current = key;
    if (!latest) return;
    const submittable = key.split('\n');
    const result = editedFields?.some((field) => !submittable.includes(field)) ? settle?.(submittable) : undefined;
    if (result) settled.current = result.values;
    // settle 改过的字段按内核新值写回控件：最新记录里没有的字段（如组织“是否新增任职”）清空，不能留着旧选择。
    const released = result ? (editedFields ?? []).filter((field) => !result.editedFields.includes(field)) : [];
    const fixed = (changed ? Object.keys(latest.values) : []).filter((field) => !submittable.includes(field));
    const sync = [...new Set([...fixed, ...released])];
    if (sync.length) form.setFieldsValue(Object.fromEntries(sync.map((field) => [field, latest.values[field]])));
  }, [form, key, latest, editedFields, settle]);
  useEffect(() => {
    if (!values || values === settled.current) return;
    const submittable = fields.current.split('\n');
    form.setFieldsValue(refillDraft({ values, latest: latest?.values, edited: editedFields ?? [], submittable }));
  }, [form, values, latest, editedFields]);
}
