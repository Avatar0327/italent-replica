import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useSession } from '../Session.js';
import { createFormStore, isLocked, type FormStore, type Latest, type SubmitInput } from './store.js';

const Context = createContext<FormStore | undefined>(undefined);
/** 放在页面根部，不能放在会卸载的弹窗/详情内部。 */
export function FormCommands({ children }: { children: ReactNode }) {
  const [store] = useState(createFormStore);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useCommandForm(resource: string) {
  const store = useContext(Context);
  if (!store) throw new Error('FormCommands provider required');
  const session = useSession();
  const key = JSON.stringify([session.tenantId, session.identityKey, resource]);
  const state = useSyncExternalStore(store.subscribe, () => store.get(key));
  return {
    state,
    status: state?.status ?? 'idle',
    locked: isLocked(state),
    busy: state?.status === 'submitting',
    submit: (input: SubmitInput) => store.submit(key, input),
    reread: (read: (id?: string) => Promise<Latest>) => store.reread(key, read),
    confirm: () => store.confirm(key),
    clear: () => store.clear(key),
  };
}
export type CommandForm = ReturnType<typeof useCommandForm> & { reload?: () => Promise<void> };
