import { useApiClient } from '../foundation/Session.js';
import { usePermissions } from '../foundation/Permissions.js';
import { slotKey } from '../foundation/forms/slot.js';
import { forAction } from '../foundation/forms/action.js';
import { useCommandForm } from '../foundation/forms/useCommandForm.js';
import { messages } from '../foundation/forms/messages.js';
import type { Values } from '../foundation/forms/store.js';
import type { Row } from '../evaluation/model.js';
import { ui } from './alignment.js';

/** 360 的原单回执均为 id + revision；用实际发出的版本校验，不能用打开时的版本。 */
export function surveyReceipt(result: Row, revision: number, id?: string) {
  if (
    !result ||
    typeof result.id !== 'string' ||
    !result.id ||
    (id && result.id !== id) ||
    !Number.isSafeInteger(result.revision) ||
    result.revision <= revision
  )
    throw new Error(messages.unknown);
  return result;
}
export function useSurveyForm(path: string, row?: Row, project: (row: Row) => Values = (value) => value) {
  const api = useApiClient();
  let object = 'Survey360.Questionnaire';
  if (path.includes('/activities')) object = 'Survey360.Activity';
  if (path.includes('/objects')) object = 'Survey360.Relation';
  const permission = usePermissions(object);
  const command = forAction(useCommandForm(slotKey(path, row?.id)), row ? { action: 'edit' } : {});
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
      if (!permission.snapshot.objects[object]?.dataOperations[row ? 'update' : 'create']) throw new Error(ui.noWrite);
      const result = await command.submit({
        values,
        baseline: row ? project(row) : {},
        editableFields,
        revision: row?.revision ?? 0,
        businessId: row?.id,
        patchOnly: !!row,
        send: async (request) =>
          surveyReceipt(
            await api.request<Row>(row ? `${path}/${row.id}` : path, {
              method,
              command: { ...request, body: normalize(request.body) },
            }),
            request.revision ?? 0,
            row?.id,
          ),
      });
      if (result.status !== 'done') throw result.error ?? new Error(messages.unknown);
    },
  };
}
