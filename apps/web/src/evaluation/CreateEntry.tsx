import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, Button, Descriptions, Modal } from 'antd';
import { useSession } from '../foundation/Session.js';
import { createCommandStore } from './create-commands.js';
import { m } from './messages.js';

type Store = ReturnType<typeof createCommandStore>;
const StoreContext = createContext<Store | undefined>(undefined);
const EntryContext = createContext<{ store: Store; key: string; path: string } | undefined>(undefined);
export const useCreateEntry = () => useContext(EntryContext);

export function CreateCommands({ children }: { children: ReactNode }) {
  const [store] = useState(createCommandStore);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** 全部创建表单共用此入口；记录在页面 Provider 中，页签、详情和表单卸载不会丢掉保护。 */
export function CreateEntry({
  path,
  title,
  close,
  children,
}: {
  path: string;
  title: string;
  close(): void;
  children: ReactNode;
}) {
  const store = useContext(StoreContext);
  if (!store) throw new Error('CreateCommands provider required');
  const session = useSession();
  const key = `${session.tenantId}/${session.identityKey}/${path}`;
  const pending = useSyncExternalStore(store.subscribe, () => store.get(key));
  const [openedPending] = useState(!!pending);
  if (pending && (openedPending || pending.status === 'unknown'))
    return (
      <Modal open title={title} onCancel={close} footer={<Button onClick={close}>{m.cancel}</Button>}>
        <Alert type="info" showIcon message={pending.status === 'pending' ? m.createPending : m.createUnknown} />
        <Descriptions
          column={1}
          items={[
            { key: 'object', label: m.createObject, children: title },
            { key: 'summary', label: m.createSummary, children: pending.summary },
            { key: 'command', label: m.commandId, children: pending.command.id },
          ]}
        />
      </Modal>
    );
  return <EntryContext.Provider value={{ store, key, path }}>{children}</EntryContext.Provider>;
}
