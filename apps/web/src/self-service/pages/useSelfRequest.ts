import { useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Form } from 'antd';
import { useApiClient, useSession } from '../../foundation/Session.js';
import { changedFields } from '../../foundation/forms/values.js';
import { createFormStore, type Values } from '../../foundation/forms/store.js';
import { slotKey } from '../../foundation/forms/slot.js';
import { useCommandForm, useDraftRefill } from '../../foundation/forms/useCommandForm.js';
import { useDirectApi } from '../../part-time/direct-api.js';
import { requestError } from '../../part-time/request-model.js';
import { confirmationOf } from '../../intern/model.js';
import { ask } from '../../exit/ExitCommands.js';
import { x } from '../../exit/messages.js';
import { pendingReplay, recoverSelfRequest, replayChanges, replaySelfRequest } from './request-replay.js';
import {
  acceptSelfRequest,
  requestPaths,
  selfRequestAccess,
  selfRequestBody,
  selfRequestErrors,
  selfRequestValues,
  type RequestFormData,
  type RequestKind,
} from './request-model.js';
import { q } from './request-messages.js';
const store = createFormStore();
function useRequestState(kind: RequestKind, initial: RequestFormData, row: Values | undefined, refresh: () => void) {
  const api = useApiClient();
  const post = useDirectApi('/api/tenant/self-service');
  const session = useSession();
  const navigate = useNavigate();
  const id = row?.id as string | undefined;
  const path = slotKey(requestPaths[kind], id);
  const scope = JSON.stringify([session.tenantId, session.identityKey, path]);
  const command = useCommandForm(path, store);
  const pending = useSyncExternalStore(replayChanges, () => pendingReplay(scope));
  const [access, setAccess] = useState(initial);
  const [error, setError] = useState<unknown>();
  const [form] = Form.useForm();
  const watched = Form.useWatch([], { form, preserve: true });
  const permission = selfRequestAccess(access, !!id);
  const baseline = selfRequestValues(kind, row ?? initial.values);
  const full = command.state?.latest?.values ?? baseline;
  const editable = permission.editableFields;
  useDraftRefill(command, editable, form);
  const editableState = !id || ['draft', 'rejected'].includes(String(full.status));
  const dirty = !!id && changedFields(watched ?? baseline, full, editable).length > 0;
  const locked = command.locked || !editableState || !access.dataOperations[id ? 'update' : 'create'];
  const read = async () => {
    const latest = await api.request<RequestFormData>(`${requestPaths[kind]}/form`);
    if (latest.employee.id !== initial.employee.id) throw new Error(x.invalidReceipt);
    setAccess(latest);
    const value = id ? await api.request<Values>(path) : latest.values;
    if (id && (value.id !== id || !Number.isSafeInteger(value.revision))) throw new Error(x.invalidReceipt);
    return {
      id: id ?? initial.employee.id,
      revision: id ? Number(value.revision) : latest.employee.revision,
      values: selfRequestValues(kind, value),
    };
  };
  const reload = () => command.reread(read);
  const receipt = command.state?.status === 'done' ? (command.state.context?.receipt as Values | undefined) : undefined;
  useEffect(() => {
    if (!receipt) return;
    const action = command.state?.context?.action;
    command.clear();
    if (action === 'submit') navigate('/self/requests');
    else if (!id) navigate(`/self/${kind}/${String(receipt.id)}`, { replace: true });
    else refresh();
  }, [receipt, command, id, kind, navigate, refresh]);
  return {
    form,
    baseline,
    full,
    permission,
    locked,
    dirty,
    error,
    kind,
    initial,
    row,
    id,
    path,
    scope,
    post,
    editable,
    setError,
    command: { ...command, reload },
    pending,
    replay: () => replaySelfRequest(scope, read).catch(() => setError(new Error(q.failed))),
  };
}

async function run(state: ReturnType<typeof useRequestState>, action: 'save' | 'submit', ack?: Values) {
  const {
    locked,
    dirty,
    setError,
    full,
    form,
    kind,
    editable,
    command,
    baseline,
    id,
    row,
    initial,
    path,
    scope,
    post,
  } = state;
  if (locked || (action === 'submit' && dirty)) return;
  setError(undefined);
  try {
    const values = { ...full, ...(await form.validateFields()) };
    const invalid = selfRequestErrors(kind, values).filter((key) => editable.includes(key));
    if (invalid.length) {
      form.setFields(invalid.map((name) => ({ name, errors: [q.required] })));
      return;
    }
    const outcome = await command.submit({
      values,
      baseline,
      editableFields: action === 'submit' ? [] : editable,
      revision: id ? Number(row!.revision) : initial.employee.revision,
      businessId: id ?? initial.employee.id,
      patchOnly: !!id,
      context: { action },
      send: async (sent) => {
        const body = { ...(action === 'submit' ? {} : selfRequestBody(kind, sent.body, editable)), ...ack };
        const target = action === 'submit' ? `${path}/submit` : path;
        const raw = await recoverSelfRequest(scope, async () => {
          try {
            return acceptSelfRequest(
              await post(target, id && action === 'save' ? 'PATCH' : 'POST', { ...sent, body }),
              initial.employee.id,
              sent.revision!,
              id,
            );
          } catch (cause) {
            throw confirmationOf(cause) ? cause : requestError(cause);
          }
        });
        command.peek()!.context!.receipt = raw;
        return { id: id ?? initial.employee.id };
      },
    });
    if (outcome.status === 'conflict') await command.reload();
    const confirmation = confirmationOf(outcome.error);
    if (confirmation && !ack && (await ask(x.confirmTitle, confirmation.message)))
      await run(state, action, confirmation.extra);
  } catch (cause) {
    setError(cause);
  }
}

export function useSelfRequest(...args: Parameters<typeof useRequestState>) {
  const state = useRequestState(...args);
  return { ...state, run: (action: 'save' | 'submit') => run(state, action) };
}
