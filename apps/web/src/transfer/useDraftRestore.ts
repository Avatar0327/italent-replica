import { useEffect, useRef, useState } from 'react';
import { createFormStore, type SubmitInput } from '../foundation/forms/store.js';
import { slotKey } from '../foundation/forms/slot.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { TRANSFER_API, TransferApiError } from './api.js';
import { clearDraft, restoreDraft } from './draft-restore.js';
import { deleteServerDraft, readServerDraft, type ServerDraft } from './draft-server.js';
import { needsEstablishmentConfirm, useEstablishmentConfirm } from './establishment-confirm.js';
import type { TransferFormModel } from './types.js';

// 页面层共用一份内核存储，关闭表单、切换视图或入口不销毁未确认命令（同合同模块）；刷新恢复归 F-110。
const store = createFormStore();
export type DraftRestoreStatus = 'idle' | 'loading' | 'restored' | 'failed';
type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;

/** F-181b：元数据只从服务端读取；清除按员工暂存资源钉住，替换单号也不能绕过未知锁。 */
export function useDraftRestore(tenantId: string, scope: string | undefined, employeeId: string, setModel: SetModel) {
  const [status, setStatus] = useState<DraftRestoreStatus>('idle');
  const [draft, setDraft] = useState<ServerDraft | null>(null);
  const command = useCommandForm(slotKey(`${TRANSFER_API}/employees`, employeeId || undefined), store);
  const active = useRef<AbortController | undefined>(undefined);
  const askDelete = useEstablishmentConfirm('delete');
  const apply = (latest: ServerDraft | null, reset: boolean) => {
    setDraft(latest);
    setStatus(latest ? 'restored' : 'idle');
    setModel((current) => {
      if (current.employeeId !== employeeId) return current;
      if (!latest) return reset ? clearDraft(current) : current;
      return restoredModel(current, latest);
    });
  };
  const load = async (reset: boolean, signal?: AbortSignal) => {
    const latest = await readServerDraft(tenantId, employeeId, signal);
    if (!signal?.aborted) apply(latest, reset);
    return latest;
  };
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setDraft(null);
    setStatus(scope && employeeId ? 'loading' : 'idle');
    if (scope && employeeId) {
      void load(false, controller.signal).catch(() => {
        if (!controller.signal.aborted) setStatus('failed');
      });
    }
    return () => controller.abort();
    // 仅选人或会话切换触发带出，不因用户编辑而覆盖表单。
  }, [tenantId, scope, employeeId, setModel]);
  const reload = () =>
    command.reread(async () => {
      const latest = await load(true, active.current?.signal);
      // 恢复对象是该员工的暂存资源，单号只是它的值；替换后仍在原资源核对差异。
      return { id: employeeId, revision: latest?.revision ?? 0, values: latest ? { ...latest } : { id: null } };
    });
  const form: CommandForm = {
    ...command,
    reload,
    confirm: () => {
      command.confirm();
      command.clear();
    },
  };
  return {
    status,
    command: form,
    error: command.status === 'rejected' && command.state?.error instanceof Error ? command.state.error.message : '',
    clear: async () => {
      if (!scope || !draft || command.locked || status === 'loading') return;
      command.clear();
      const signal = active.current?.signal;
      const submit = (confirmed: boolean) =>
        submitDraftDeletion(command.submit, draft, confirmed, async (sent) => {
          await deleteServerDraft(tenantId, employeeId, draft.id, sent);
          // 重读仍在 submitting 内，读取失败保留 unknown。
          await load(true, signal);
          return { id: employeeId };
        });
      let outcome = await submit(false);
      if (outcome.status === 'rejected' && needsEstablishmentConfirm(outcome.error)) {
        command.clear();
        if (signal?.aborted || !(await askDelete()) || signal?.aborted) return;
        // 确定拒绝后用内核创建新命令，确认参数也留在命令中供结果未知时恢复。
        outcome = await submit(true);
      }
      if (outcome.status === 'conflict') await reload();
      if (outcome.status === 'rejected' && outcome.error instanceof TransferApiError && outcome.error.status === 404) {
        setStatus('loading');
        try {
          await load(true, active.current?.signal);
          command.clear();
        } catch {
          setStatus('failed');
        }
      }
    },
  };
}

function submitDraftDeletion(
  submit: CommandForm['submit'],
  draft: ServerDraft,
  confirmed: boolean,
  send: SubmitInput['send'],
) {
  const values = { ...draft, ...(confirmed ? { confirmed } : {}) };
  return submit({
    values,
    baseline: { ...draft },
    editableFields: Object.keys(values),
    revision: draft.revision,
    businessId: draft.employeeId,
    send,
  });
}

function restoredModel(current: TransferFormModel, latest: ServerDraft): TransferFormModel {
  const restored = restoreDraft(current, latest);
  const editable = current.catalog.editableFields;
  return {
    ...restored,
    reasonCode: !editable || editable.includes('reasonCode') ? (latest.reasonCode ?? '') : '',
    withEstablishment: (!editable || editable.includes('withEstablishment')) && latest.withEstablishment === true,
  };
}
