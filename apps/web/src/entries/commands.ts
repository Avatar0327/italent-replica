import { message } from 'antd';
import { useApiClient } from '../foundation/Session.js';
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

export function useEntryAccess() {
  const p = usePermissions(object);
  const operations = p.snapshot.objects[object]?.dataOperations;
  return {
    ...p,
    edit: !!operations?.update && p.can('Employment.Edit'),
    remove: !!operations?.delete && p.can('Employment.Delete'),
  };
}
export function useEntryCommand(row: Row, action: string, baseline: Values = row) {
  const api = useApiClient();
  const command = forAction(useCommandForm(slotKey(collection, row.id)), { action });
  const full = command.state?.latest?.values ?? baseline;
  return {
    full,
    form: {
      ...command,
      reload: () =>
        command.reread(async () => {
          const values = await readEntry(api, row, true);
          return { id: String(values.id), revision: Number(values.revision), values };
        }),
    },
    async run(values: Values, fields: string[], send: (command: Command<Values>) => Promise<void>) {
      const result = await command.submit({
        businessId: row.id,
        revision: Number(baseline.revision),
        baseline,
        values,
        editableFields: fields,
        context: { effectiveDate: full.effectiveDate },
        send: async (cmd) => {
          await send(cmd);
          return { id: row.id };
        },
      });
      if (result.status !== 'done') throw result.error ?? new Error(kernel.unknown);
      command.clear();
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
