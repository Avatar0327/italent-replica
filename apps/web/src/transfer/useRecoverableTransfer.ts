import { useEffect, useRef, useState } from 'react';
import { missingTransferRequiredFields } from '@italent/domain';
import { reloadSavedModel, savedNotice } from '../self-service/shared/transfer-loading.js';
import { requestError, TransferApiError } from './api.js';
import { text } from './messages.js';
import {
  confirmedReceipt,
  forgetPending,
  leaveRecovery,
  prepareReceipt,
  readRecovery,
  rememberRecovery,
  sendOriginal,
  type TransferReceipt,
} from './recovery.js';
import type { TransferAction, TransferFormModel } from './types.js';

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;
interface FormContext {
  tenantId: string;
  model: TransferFormModel;
  loadingPreview: boolean;
  setModel: Setter<TransferFormModel>;
  setError: Setter<string>;
  setNotice: Setter<string>;
}
interface RecoveryState {
  receipt?: TransferReceipt;
  busy: boolean;
  needsReload: boolean;
  blocked: boolean;
}
interface Context extends FormContext {
  scope: string;
  state: RecoveryState;
  update: Setter<RecoveryState>;
  running: React.RefObject<boolean>;
}
export function useRecoverableTransfer(form: FormContext, scope?: string) {
  const [state, update] = useState<RecoveryState>({ busy: false, needsReload: false, blocked: false });
  const running = useRef(false);
  const context: Context = { ...form, scope: scope ?? '', state, update, running };
  useEffect(() => {
    if (!scope) return;
    try {
      const session = readRecovery(scope);
      const receipt = session.active ? session.entries[session.active] : undefined;
      if (receipt) void restore(context, receipt);
    } catch {
      update((current) => ({ ...current, blocked: true }));
      form.setError(text.recoveryUnavailable);
    }
    // 身份 / 租户变化会重建表单，恢复不能随预览响应重复执行。
  }, [scope]);
  const saved = state.receipt?.saved ?? null;
  return {
    saved,
    busy: state.busy || state.blocked,
    needsReload: state.needsReload,
    unknownCommand: state.receipt?.pending?.id ?? '',
    submit: (action: TransferAction) => submit(context, action),
    recover: () => recover(context),
    reloadSaved: () => state.receipt && restore(context, state.receipt),
    clearActive: () => clearActive(context),
    restoreSelection: (field: string, value: string) => restoreSelection(context, field, value),
  };
}
function selectModel(model: TransferFormModel, receipt: TransferReceipt): TransferFormModel {
  return { ...model, ...receipt.selection, fields: {}, customFields: {}, preview: null };
}
async function restore(context: Context, receipt: TransferReceipt) {
  if (context.running.current) return;
  const { setModel, update, setError } = context;
  const selected = selectModel(context.model, receipt);
  setModel(selected);
  update({ receipt, busy: false, needsReload: !!receipt.saved, blocked: false });
  if (receipt.pending || !receipt.saved) return;
  context.running.current = true;
  update((current) => ({ ...current, busy: true }));
  setError('');
  try {
    await readSaved(context, selected, receipt);
  } catch (cause) {
    setError(requestError(cause));
  } finally {
    context.running.current = false;
    update((current) => ({ ...current, busy: false }));
  }
}
async function readSaved(context: Context, model: TransferFormModel, receipt: TransferReceipt) {
  const { latest, refreshed } = await reloadSavedModel(context.tenantId, model, receipt.saved!);
  const confirmed = confirmedReceipt(receipt, latest);
  rememberRecovery(context.scope, confirmed);
  // 不覆盖回读期间加载的员工 / 表单目录。
  context.setModel((current) => ({ ...current, ...refreshed, employees: current.employees, catalog: current.catalog }));
  context.update({ receipt: confirmed, busy: false, needsReload: false, blocked: false });
  context.setNotice(text.draftReloaded);
}
async function submit(context: Context, action: TransferAction) {
  const { state, model, running } = context;
  if (state.blocked || state.needsReload || state.receipt?.pending || running.current || context.loadingPreview) return;
  if (!model.preview || model.preview.requiredFieldsUnavailable) return;
  if (missingTransferRequiredFields(model.preview.form, { ...model.preview.fields, ...model.fields }).length) return;
  const receipt = prepareReceipt(model, action, state.receipt?.saved ?? null);
  try {
    rememberRecovery(context.scope, receipt);
  } catch {
    context.setError(text.recoveryUnavailable);
    return;
  }
  await execute(context, receipt, false);
}
async function execute(context: Context, receipt: TransferReceipt, recovering: boolean) {
  context.running.current = true;
  context.update({ receipt, busy: true, needsReload: recovering, blocked: false });
  context.setError('');
  context.setNotice('');
  try {
    const result = await sendOriginal(context.tenantId, receipt);
    const confirmed = confirmedReceipt(receipt, result);
    rememberRecovery(context.scope, confirmed);
    context.update({ receipt: confirmed, busy: true, needsReload: recovering, blocked: false });
    if (recovering) await readSaved(context, selectModel(context.model, receipt), confirmed);
    else context.setNotice(savedNotice(result, receipt.pending!.action));
  } catch (cause) {
    try {
      handleFailure(context, receipt, cause, recovering);
    } catch {
      // 写后存储失效仍在内存保留原命令，不能解除保护或产生未捕获异常。
      context.update({ receipt, busy: false, needsReload: true, blocked: false });
      context.setError(text.unknown);
    }
  } finally {
    context.running.current = false;
    context.update((current) => ({ ...current, busy: false }));
  }
}
function handleFailure(context: Context, receipt: TransferReceipt, cause: unknown, recovering: boolean) {
  const unknown = recovering || !(cause instanceof TransferApiError) || cause.status >= 500;
  if (unknown) {
    // 回查 / 恢复失败也不能依据 404 / 409 创建新单；原命令仍是唯一恢复入口。
    rememberRecovery(context.scope, receipt);
    context.update({ receipt, busy: false, needsReload: true, blocked: false });
    context.setError(text.unknown);
  } else {
    forgetPending(context.scope, receipt);
    context.update({
      receipt: receipt.saved ? { ...receipt, pending: undefined } : undefined,
      busy: false,
      needsReload: !!receipt.saved && cause.code === 'REVISION_CONFLICT',
      blocked: false,
    });
    context.setError(requestError(cause));
    if (cause.code === 'REVISION_CONFLICT' && !receipt.saved)
      context.setModel((current) => ({ ...current, preview: null }));
  }
}
async function recover(context: Context) {
  const receipt = context.state.receipt;
  if (!receipt?.pending || context.running.current || context.state.blocked) return;
  // 后端没有命令查询接口：用户显式恢复时按原路径、原 revision、原载荷重放同一个幂等命令。
  // 已知单号时先按当前权限回查，成功后才请求原命令回执。
  if (receipt.saved) {
    context.running.current = true;
    context.update((current) => ({ ...current, busy: true }));
    try {
      await reloadSavedModel(context.tenantId, selectModel(context.model, receipt), receipt.saved);
    } catch (cause) {
      context.setError(requestError(cause));
      return;
    } finally {
      context.running.current = false;
      context.update((current) => ({ ...current, busy: false }));
    }
  }
  await execute(context, receipt, true);
}
function clearActive(context: Context) {
  if (context.state.needsReload || context.state.receipt?.pending || context.running.current) return false;
  try {
    leaveRecovery(context.scope, context.state.receipt);
    context.update({ busy: false, needsReload: false, blocked: false });
    context.setModel((current) => ({ ...current, employeeId: '' }));
    return true;
  } catch {
    context.setError(text.recoveryUnavailable);
    return false;
  }
}
function restoreSelection(context: Context, field: string, value: string) {
  if (field !== 'employeeId' && field !== 'transferTypeCode') return false;
  const employee = field === 'employeeId' ? value : context.model.employeeId;
  const type = field === 'transferTypeCode' ? value : context.model.transferTypeCode;
  try {
    const form = context.model.catalog.types.find((item) => item.code === type)?.formId;
    const receipt = readRecovery(context.scope).entries[JSON.stringify([employee, form])];
    if (!receipt) return false;
    rememberRecovery(context.scope, receipt);
    void restore(context, receipt);
    return true;
  } catch {
    context.update((current) => ({ ...current, blocked: true }));
    context.setError(text.recoveryUnavailable);
    return true;
  }
}
