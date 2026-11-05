import { useApiClient } from '../foundation/Session.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { slotKey } from '../foundation/forms/slot.js';
import type { Values } from '../foundation/forms/store.js';
import { requireEvaluationReceipt, type Row } from './model.js';
import { m } from './messages.js';

export function useEvaluationForm(path: string, row?: Row) {
  const api = useApiClient();
  const command = useCommandForm(slotKey(path, row?.id));
  const latest = command.state?.latest;
  const current = latest ? ({ ...latest.values, id: latest.id, revision: latest.revision } as Row) : row;
  return {
    ...command,
    current,
    reload: row
      ? () =>
          command.reread(async (id) => {
            const record = await api.request<Row>(`${path}/${id}`);
            return { id: record.id, revision: record.revision, values: record };
          })
      : undefined,
    async save(values: Values, editableFields: string[], method: 'POST' | 'PATCH') {
      const result = await command.submit({
        values,
        baseline: row ?? {},
        editableFields,
        revision: row?.revision ?? 0,
        businessId: row?.id,
        patchOnly: !!row,
        send: async (request) =>
          requireEvaluationReceipt(
            await api.request(row ? `${path}/${row.id}` : path, { method, command: request }),
            request.revision ?? 0,
            row?.id,
          ),
      });
      if (result.status !== 'done') throw result.error ?? new Error(m.uncertain);
    },
  };
}
