import { useState } from 'react';
import type { Command } from '../foundation/client.js';
import { useCommandForm, useDraftRefill } from '../foundation/forms/useCommandForm.js';
import { sameValue } from '../foundation/forms/values.js';
import type { Values } from '../foundation/forms/store.js';
import {
  sheetReceipt,
  sheetValues,
  type Answer,
  type AnswerPage,
  type PortalClient,
  type Sheet,
} from './portal-client.js';
import { portalMessages as m } from './portal-messages.js';

export function usePortalAnswer(api: PortalClient, path: string, initial: AnswerPage) {
  const [page, setPage] = useState(initial);
  const [draft, setDraft] = useState<Values>(() => sheetValues(initial.sheet));
  const [notice, setNotice] = useState('');
  const [reminder, setReminder] = useState(false);
  const command = useCommandForm(`/api/survey360/portal${path}`);
  const [target] = useState(() => ({ setFieldsValue: (values: Values) => setDraft((old) => ({ ...old, ...values })) }));
  const fields = ['answers', 'suggestion'];
  useDraftRefill(command, fields, target);
  const readonly = command.locked || page.sheet.status === 'submitted' || page.activity.status !== 'enabled';
  const dirty = !sameValue(draft, sheetValues(page.sheet));
  const answers = (draft.answers ?? []) as Answer[];
  const setAnswer = (id: string, patch: Partial<Answer>) => {
    setNotice('');
    setDraft((old) => {
      const list = (old.answers ?? []) as Answer[];
      const found = list.find((a) => a.itemId === id);
      return { ...old, answers: [...list.filter((a) => a.itemId !== id), { ...found, itemId: id, ...patch }] };
    });
  };
  const read = async () => {
    const latest = await api.request<AnswerPage>(path);
    setPage(latest);
    return { id: path, revision: latest.sheet.revision, values: sheetValues(latest.sheet) };
  };
  const send = async (request: Command<Values>, operation: 'save' | 'submit') => {
    const result = sheetReceipt(
      await api.request<Sheet & { reminder?: boolean }>(
        `${path}${operation === 'submit' ? '/submit' : ''}`,
        operation === 'submit' ? 'POST' : 'PUT',
        request.body,
        request,
      ),
      request.revision!,
      operation,
    );
    setPage((old) => ({ ...old, sheet: result }));
    setDraft(sheetValues(result));
    setNotice(operation === 'submit' ? m.submitted : m.saved);
    setReminder('reminder' in result && result.reminder === true);
    return { id: path };
  };
  const run = async (operation: 'save' | 'submit') => {
    setNotice('');
    const outcome = await command.submit({
      values: operation === 'save' ? draft : {},
      baseline: sheetValues(page.sheet),
      editableFields: operation === 'save' ? fields : [],
      revision: page.sheet.revision,
      businessId: path,
      context: { operation },
      send: (request) => send(request, operation),
    });
    if (outcome.status === 'done') command.clear();
  };
  const replay = async () => {
    const operation = command.state?.context?.operation;
    if (operation !== 'save' && operation !== 'submit') return;
    const outcome = await command.replay((request) => send(request, operation));
    if (outcome?.status === 'done') command.clear();
  };
  return {
    page,
    draft,
    notice,
    reminder,
    command,
    readonly,
    dirty,
    answers,
    setAnswer,
    read,
    run,
    replay,
    setNotice,
    setDraft,
  };
}
