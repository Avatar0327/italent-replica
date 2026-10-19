import { createContext, useContext, useState, type ReactNode } from 'react';
import { useApiClient, useSession } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { createFormStore, type FormStore } from '../foundation/forms/store.js';
import { FormCommands } from '../foundation/forms/useCommandForm.js';
import { useConflictCommand, type Snapshot } from '../foundation/forms/ConflictCommands.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Values } from '../foundation/forms/values.js';
import { apiRoot, object, type Row } from './model.js';
import { directValues, recordReceipt } from './direct-model.js';
import { d } from './direct-messages.js';
export const collection = `${apiRoot}/part-times`;
const Store = createContext<FormStore | undefined>(undefined);
export function DirectCommands({ children }: { children: ReactNode }) {
  const [store] = useState(createFormStore);
  return (
    <Store.Provider value={store}>
      <FormCommands store={store}>{children}</FormCommands>
    </Store.Provider>
  );
}
export function useDirectAccess() {
  const p = usePermissions(object);
  const operations = p.snapshot.objects[object]?.dataOperations;
  const operation = (create: boolean) => !!operations?.[create ? 'create' : 'update'];
  return {
    p,
    operation,
    field: (key: string, create: boolean) => {
      if (key === 'employeeId') return { visible: true, editable: create && operation(true) };
      // 读 DTO 的 serviceType 与新增写权限编码 partTimeType 不同（routes.writeBusiness）。
      const code = create && key === 'serviceType' ? 'partTimeType' : key;
      return {
        visible: p.field(code).visible,
        editable:
          operation(create) && p.field(code).editable && (create || !['serviceType', 'effectiveDate'].includes(key)),
      };
    },
  };
}
export function useDirectCommand(
  snapshot: Snapshot,
  action: string,
  read: (baseline?: Values, id?: string) => Promise<Values>,
) {
  const store = useContext(Store)!;
  const session = useSession();
  const resource = action === 'create' ? `${apiRoot}/employees` : collection;
  const cmd = useConflictCommand(resource, snapshot, undefined, { action });
  const reload = () =>
    cmd.form.reread(async (id) => {
      const values = await read(cmd.form.state?.baseline, id);
      return { id: id!, revision: Number(values.revision), values };
    });
  const scoped = (path: string) => JSON.stringify([session.tenantId, session.identityKey, path]);
  const sourceSlots = (snapshot.objects ?? [{ id: snapshot.id! }])
    .filter((row) => !!row.id)
    .map((row) => scoped(slotKey(resource, row.id)));
  return {
    ...cmd,
    form: { ...cmd.form, reload },
    async finish(receipt: Row | undefined, refresh: () => Promise<void>) {
      // 创建成功后的新 ID 也钉在同一条原命令上；后续读取失败时编辑入口仍然锁定。
      const holder = store.holder(sourceSlots);
      const replacement = receipt && action === 'create' ? scoped(slotKey(collection, receipt.id)) : undefined;
      if (holder && replacement) store.pin([replacement], holder);
      try {
        await refresh();
      } catch {
        throw new Error(d.invalidReceipt);
      }
      if (holder && replacement) store.unpin([replacement], holder);
    },
  };
}
export function useRecordRead() {
  const api = useApiClient();
  return async (id: string) =>
    directValues(
      recordReceipt(await api.request<Row>(`${collection}/${encodeURIComponent(id)}`), id, {
        id: '',
        revision: 0,
        body: {},
      }),
    );
}
