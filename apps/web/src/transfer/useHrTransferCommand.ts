import { useRef, useState } from 'react';
import { createFormStore } from '../foundation/forms/store.js';
import { useCommandForm, type CommandForm } from '../foundation/forms/useCommandForm.js';
import { loadPreview, savedNotice } from '../self-service/shared/transfer-loading.js';
import { text } from './messages.js';
import { missingTransferRequiredFields } from '@italent/domain';
import { saveTransfer } from './api.js';
import { draftValues, editableKeys, previewRecord, withReread } from './hr-conflict.js';
import type { TransferAction, TransferFormModel } from './types.js';
import { useHrWrite } from './useHrWrite.js';

type SetModel = React.Dispatch<React.SetStateAction<TransferFormModel>>;
type Reread = Awaited<ReturnType<typeof loadPreview>>;

/**
 * HR 调动写入。版本冲突走 F-142 内核（#350 第 1 轮 P2-2）：冲突后表单锁定，重读最新预览、核对“变更前”差异，
 * 确认后保留仍可编辑的已改字段、换上最新预览，由用户主动重提；重提的 If-Match 取内核记下的最新版本。
 */
export function useHrTransferCommand(
  tenantId: string,
  model: TransferFormModel,
  loadingPreview: boolean,
  setModel: SetModel,
  scope?: string,
) {
  const write = useHrWrite(scope);
  const [action, setAction] = useState<TransferAction>('draft');
  // 冲突状态随本表单存在：关掉表单即放弃本次尝试，重开按新预览的版本提交；结果未知另由会话处理标记锁定（DEC-464）。
  const [store] = useState(createFormStore);
  const command = useCommandForm(`transfer/employees/${model.employeeId}`, store);
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
    reload: () => command.reread(read),
    confirm: () => {
      const latest = reread.current;
      reread.current = undefined;
      command.confirm();
      if (latest) setModel((current) => withReread(current, latest.employeeId, latest.loaded));
    },
  };
  return {
    saved: write.result,
    processing: write.processing,
    commandError: write.error,
    commandNotice,
    busy: write.processing || command.locked,
    conflict,
    needsReload: false,
    unknownCommand: '',
    reloadSaved: async () => {},
    submit: async (action: TransferAction) => {
      const { preview } = model;
      if (write.result || command.locked || loadingPreview || !preview || preview.requiredFieldsUnavailable) return;
      if (model.typeConfirmation) return;
      if (missingTransferRequiredFields(preview.form, { ...preview.fields, ...model.fields }).length) return;
      setAction(action);
      restart();
      const record = previewRecord(model.employeeId, preview);
      const outcome = await command.submit({
        values: draftValues(model, record),
        baseline: record.values,
        editableFields: editableKeys(preview),
        revision: record.revision,
        businessId: model.employeeId,
        send: async (sent) => {
          // 回执按实际发出的 If-Match 核对（#350 第 2 轮 P2-2）。
          const revision = sent.revision ?? record.revision;
          const save = (id: string) => saveTransfer(tenantId, model, action, id, revision);
          const { employeeId, transferTypeCode } = model;
          await write.run(save, { employeeId, transferTypeCode, revision });
          // 内核按员工记录核对回执；业务单回执已由 useHrWrite 校验并保存。
          return { id: model.employeeId };
        },
      });
      // 只留冲突给用户重读核对；成功与被拒（提示由 useHrWrite 给出）不留状态，下次按当时预览的版本提交。
      if (outcome.status === 'done' || outcome.status === 'rejected') command.clear();
    },
  };
}
