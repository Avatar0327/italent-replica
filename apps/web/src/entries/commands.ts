import { createContext, useContext } from 'react';
import type { FormStore } from '../foundation/forms/store.js';
import { message } from 'antd';
import { useApiClient, useSession } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { forAction } from '../foundation/forms/action.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { ui } from '../foundation/messages.js';
import { collection, object, request, readEntry, type Row } from './model.js';
import { m } from './messages.js';
import type { Command } from '../foundation/client.js';

export const EntryStore = createContext<FormStore | undefined>(undefined);
export function useEntryAccess() {
  const p = usePermissions(object);
  const operations = p.snapshot.objects[object]?.dataOperations;
  return {
    ...p,
    edit: !!operations?.update && p.can('Employment.Edit'),
    remove: !!operations?.delete && p.can('Employment.Delete'),
  };
}
export function useEntryCommand(
  row: Row,
  action: string,
  baseline: Values = row,
  rereadValues: (values: Values) => Values = (values) => values,
) {
  const api = useApiClient();
  const store = useContext(EntryStore)!;
  const session = useSession();
  const scoped = (id: string) => JSON.stringify([session.tenantId, session.identityKey, slotKey(collection, id)]);
  const command = forAction(useCommandForm(slotKey(collection, row.id), store), { action });
  const full = command.state?.latest?.values ?? baseline;
  return {
    full,
    form: {
      ...command,
      reload: () =>
        command.reread(async (id) => {
          const values = rereadValues(await readEntry(api, { ...row, id: id ?? row.id }, true));
          return { id: String(values.id), revision: Number(values.revision), values };
        }),
    },
    async run(
      values: Values,
      fields: string[],
      send: (command: Command<Values>, link: (receipt: Values) => void) => Promise<void>,
    ) {
      const key = store.holder([scoped(row.id)]) ?? scoped(row.id);
      let replacement: string | undefined;
      const result = await command.submit({
        businessId: row.id,
        revision: Number(baseline.revision),
        baseline,
        values,
        editableFields: fields,
        context: { effectiveDate: full.effectiveDate },
        send: async (cmd) => {
          await send(cmd, (receipt) => {
            // 成功回执到达后立即钉住替换 ID；后续读取失败仍由共享内核保持同一条 unknown 命令。
            replacement = scoped(String(receipt.id));
            store.pin([scoped(row.id), replacement], key);
          });
          return { id: row.id };
        },
      });
      if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
      command.clear();
      if (replacement) store.unpin([replacement], key);
    },
  };
}
export const initial = (data: Values, fields: string[]) => ({ ...data, ...projectFields(data, fields) });
export async function refreshAfter(read: () => Promise<void>) {
  // 写回执已成功后，后续读的 4xx 不能被误判为写被拒：保持 unknown 锁，避免新命令重复写入。
  try {
    await read();
  } catch {
    throw new Error(kernel.unknown);
  }
  void message.success(m.saved);
}
export const requireWrite = (allowed: boolean) => {
  if (!allowed) throw new Error(ui.denied);
};
export { request };
