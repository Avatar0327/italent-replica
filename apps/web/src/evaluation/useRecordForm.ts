import { useApiClient } from '../foundation/Session.js';
import { slotKey } from '../foundation/forms/slot.js';
import { forAction } from '../foundation/forms/action.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { messages } from '../foundation/forms/messages.js';
import type { Values } from '../foundation/forms/store.js';
import type { Row } from './model.js';

/**
 * API 适配只负责 DTO；锁定、命令 ID、冲突重读由底座统一负责。
 * action 是本表单在该对象上的动作（如 { action: 'edit' }）：同一对象别的动作未确认时本表单锁定（F-147 forAction）。
 */
export function useRecordForm(
  path: string,
  row?: Row,
  project: (row: Row) => Values = (value) => value,
  action: Values = {},
) {
  const api = useApiClient();
  const resource = row ? `${path}/${row.id}` : path;
  // 恢复槽：编辑为原单路径、新建为集合路径（与 CreateEntry 的在途新建检查同一个槽，F-142）。
  const command = forAction(useCommandForm(slotKey(path, row?.id)), action);
  const latest = command.state?.latest;
  const current = latest ? ({ ...latest.values, id: latest.id, revision: latest.revision } as Row) : row;
  return {
    ...command,
    current,
    reload: row
      ? () =>
          command.reread(async (id) => {
            const result = await api.request<Row>(`${path}/${id}`);
            return { id: result.id, revision: result.revision, values: project(result) };
          })
      : undefined,
    async save(
      values: Values,
      editableFields: string[],
      method: 'POST' | 'PUT' | 'PATCH',
      normalize: (values: Values) => Values = (value) => value,
    ) {
      const result = await command.submit({
        values,
        baseline: row ? project(row) : {},
        editableFields,
        revision: row?.revision ?? 0,
        businessId: row?.id,
        patchOnly: !!row,
        send: (request) =>
          api.request<Row>(resource, { method, command: { ...request, body: normalize(request.body) } }),
      });
      if (result.status !== 'done') throw result.error ?? new Error(messages.unknown);
    },
  };
}
