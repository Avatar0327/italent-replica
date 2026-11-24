import { useRef, useState } from 'react';
import { usePinnedCommand, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { loadPreview, savedNotice } from '../self-service/shared/transfer-loading.js';
import { text } from './messages.js';
import { missingTransferRequiredFields } from '@italent/domain';
import { saveTransfer } from './api.js';
import {
  needsEstablishmentConfirm,
  sendWithEstablishmentConfirm,
  useEstablishmentConfirm,
} from './establishment-confirm.js';
import { draftValues, editableKeys, previewRecord, withReread } from './hr-conflict.js';
import { terminatesOriginalContract } from './hr-form-model.js';
import { transferCommands, transferEntry, transferResult, transferSlot } from './commands.js';
import type { TransferAction, TransferFormModel } from './types.js';
import { useHrWrite } from './useHrWrite.js';
import { useTerminateConfirm } from './useTerminateConfirm.js';

type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;
type Reread = Awaited<ReturnType<typeof loadPreview>>;

/**
 * HR 调动写入。版本冲突走 F-142 内核（#350 第 1 轮 P2-2）：冲突后表单锁定，重读最新预览、核对“变更前”差异，
 * 确认后保留仍可编辑的已改字段、换上最新预览，由用户主动重提；重提的 If-Match 取内核记下的最新版本。
 * 处理中 / 结果未知由同一内核按共享恢复记录锁定（F-110）：幂等键就是内核命令 ID，查询结果只按这个 ID。
 */
export function useHrTransferCommand(
  tenantId: string,
  model: TransferFormModel,
  loadingPreview: boolean,
  setModel: SetModel,
) {
  const write = useHrWrite();
  const confirmTerminate = useTerminateConfirm();
  const confirmEstablishment = useEstablishmentConfirm();
  const [chosen, setAction] = useState<TransferAction>('draft');
  const [awaitingEstablishment, setAwaitingEstablishment] = useState(false);
  const submitting = useRef(false);
  const command = usePinnedCommand([transferSlot], transferEntry(model.employeeId), transferCommands);
  // 刷新后恢复的命令按它当初的动作给提示（动作存在命令上下文里，不进请求体）。
  const action = (command.state?.context?.action as TransferAction | undefined) ?? chosen;
  const processing = awaitingEstablishment || command.status === 'submitting' || command.status === 'unknown';
  const reread = useRef<{ employeeId: string; loaded: Reread }>(undefined);
  let commandNotice = '';
  if (write.result) {
    commandNotice = write.result.status === 'draft' ? text.hrDraftSaved : savedNotice(write.result, action);
  }
  const read = async () => {
    const loaded = await loadPreview(tenantId, model, new AbortController().signal);
    reread.current = { employeeId: model.employeeId, loaded };
    return previewRecord(model.employeeId, loaded.preview);
  };
  // 新一次尝试（含清除、换人后重来）从当前预览起算：丢掉已确认冲突留下的旧版本与重读缓存（#350 第 2 轮 P2-1）。
  // 内核对锁定中的槽（提交中、冲突、结果未知）不清除，这些状态仍按原规则锁定。
  const restart = () => {
    command.clear();
    reread.current = undefined;
  };
  const conflict: CommandForm = {
    ...command,
    state: command.status === 'rejected' && needsEstablishmentConfirm(command.state?.error) ? undefined : command.state,
    // 处理中整页只读，原单回查没有可对的表单；只给按原命令 ID 查询结果（F-120）。
    reload: processing ? undefined : () => command.reread(read),
    queryResult: async () => {
      await command.recoverResult((sent) => transferResult(tenantId, sent.id, write.setResult));
    },
    confirm: () => {
      const latest = reread.current;
      reread.current = undefined;
      command.confirm();
      if (latest) setModel((current) => withReread(current, latest.employeeId, latest.loaded));
    },
  };
  return {
    saved: write.result,
    processing,
    commandError: write.error,
    commandNotice,
    busy: awaitingEstablishment || command.locked,
    conflict,
    needsReload: false,
    unknownCommand: '',
    reloadSaved: async () => {},
    submit: async (action: TransferAction) => {
      const { preview } = model;
      if (submitting.current) return;
      if (write.result || command.locked || loadingPreview || !preview || preview.requiredFieldsUnavailable) return;
      if (model.typeConfirmation) return;
      if (missingTransferRequiredFields(preview.form, { ...preview.fields, ...model.fields }).length) return;
      submitting.current = true;
      try {
        // F-504：暂存不生效、不终止原合同，不问；提交 / 保存每次都先确认，取消即不发请求、表单不动。
        if (action !== 'draft' && terminatesOriginalContract(model) && !(await confirmTerminate())) return;
        setAction(action);
        restart();
        write.refuse('');
        await submitHrTransfer(command, write, { tenantId, model, preview, action }, () => {
          setAwaitingEstablishment(true);
          return confirmEstablishment();
        });
      } catch (error) {
        // 确认取消时收到原 409：保留输入，提示由确认框处理。
        if (!needsEstablishmentConfirm(error)) throw error;
        command.clear();
      } finally {
        submitting.current = false;
        setAwaitingEstablishment(false);
      }
    },
  };
}

function submitHrTransfer(
  command: CommandForm,
  write: Pick<ReturnType<typeof useHrWrite>, 'run' | 'refuse'>,
  input: {
    tenantId: string;
    model: TransferFormModel;
    preview: NonNullable<TransferFormModel['preview']>;
    action: TransferAction;
  },
  ask: () => Promise<boolean>,
) {
  const { tenantId, model, preview, action } = input;
  const { employeeId } = model;
  const record = previewRecord(employeeId, preview);
  // F-026 / F-110：首次和确认后的请求分别走内核登记，各自的幂等键就是各自的恢复命令 ID。
  return sendWithEstablishmentConfirm(async (confirmed) => {
    let sent = false;
    const outcome = await command.submit({
      values: draftValues(model, record),
      baseline: record.values,
      editableFields: editableKeys(preview),
      revision: record.revision,
      businessId: employeeId,
      context: { action },
      send: async (issued) => {
        sent = true;
        // 回执按实际发出的 If-Match 核对（#350 第 2 轮 P2-2）。
        const revision = issued.revision ?? record.revision;
        const save = () => saveTransfer(tenantId, model, action, issued.id, revision, confirmed);
        await write.run(save, { employeeId, revision });
        // 内核按员工记录核对回执；业务单回执已由 useHrWrite 校验并保存。
        return { id: employeeId };
      },
    });
    // A 已落定。确认重提之前保留这条状态，避免持久记录排队删除时被同步重新当作未知命令。
    if (outcome.status === 'rejected' && needsEstablishmentConfirm(outcome.error)) throw outcome.error;
    // 登记就被拒（锁被他页占用、不支持锁、别页已登记、存储不可用）时命令未发出，useHrWrite 没机会提示，用内核的文案。
    if (outcome.status === 'rejected' && !sent) write.refuse((outcome.error as Error).message);
    // 普通拒绝由 useHrWrite 给出提示，下次提交按当时的预览起算。
    if (outcome.status === 'done' || outcome.status === 'rejected') command.clear();
  }, ask);
}
