import { useRef, useState } from 'react';
import { usePinnedCommand, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { loadPreview, savedNotice } from '../self-service/shared/transfer-loading.js';
import { text } from './messages.js';
import { missingTransferRequiredFields } from '@italent/domain';
import { saveTransfer } from './api.js';
import { sendWithEstablishmentConfirm, useEstablishmentConfirm } from './establishment-confirm.js';
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
  const command = usePinnedCommand([transferSlot], transferEntry(model.employeeId), transferCommands);
  // 刷新后恢复的命令按它当初的动作给提示（动作存在命令上下文里，不进请求体）。
  const action = (command.state?.context?.action as TransferAction | undefined) ?? chosen;
  const processing = command.status === 'submitting' || command.status === 'unknown';
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
    busy: command.locked,
    conflict,
    needsReload: false,
    unknownCommand: '',
    reloadSaved: async () => {},
    submit: async (action: TransferAction) => {
      const { preview } = model;
      if (write.result || command.locked || loadingPreview || !preview || preview.requiredFieldsUnavailable) return;
      if (model.typeConfirmation) return;
      if (missingTransferRequiredFields(preview.form, { ...preview.fields, ...model.fields }).length) return;
      // F-504：暂存不生效、不终止原合同，不问；提交 / 保存每次都先确认，取消即不发请求、表单不动。
      if (action !== 'draft' && terminatesOriginalContract(model) && !(await confirmTerminate())) return;
      setAction(action);
      restart();
      const record = previewRecord(model.employeeId, preview);
      const outcome = await command.submit({
        values: draftValues(model, record),
        baseline: record.values,
        editableFields: editableKeys(preview),
        revision: record.revision,
        businessId: model.employeeId,
        context: { action },
        send: async (sent) => {
          // 回执按实际发出的 If-Match 核对（#350 第 2 轮 P2-2）。
          const revision = sent.revision ?? record.revision;
          const { employeeId } = model;
          // F-026：非严格控编超编先确认，确认后带 confirmed 以新命令 ID 重提；取消保留输入、不再发请求。
          // 首次请求的幂等键是内核命令 ID（F-110，恢复记录按它查询）；确认重提按 F-026 另起一个 ID。
          const save = (confirmed: boolean) => () =>
            saveTransfer(tenantId, model, action, confirmed ? crypto.randomUUID() : sent.id, revision, confirmed);
          await sendWithEstablishmentConfirm(
            (confirmed) => write.run(save(confirmed), { employeeId, revision }),
            confirmEstablishment,
          );
          // 内核按员工记录核对回执；业务单回执已由 useHrWrite 校验并保存。
          return { id: model.employeeId };
        },
      });
      // 只留冲突给用户重读核对；成功与被拒（提示由 useHrWrite 给出）不留状态，下次按当时预览的版本提交。
      if (outcome.status === 'done' || outcome.status === 'rejected') command.clear();
    },
  };
}
