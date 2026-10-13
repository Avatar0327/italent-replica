import { missingTransferRequiredFields } from '@italent/domain';
import { saveTransfer } from './api.js';
import type { TransferAction, TransferFormModel } from './types.js';
import { useHrWrite } from './useHrWrite.js';

export function useHrTransferCommand(
  tenantId: string,
  model: TransferFormModel,
  loadingPreview: boolean,
  scope?: string,
) {
  const write = useHrWrite(scope);
  return {
    saved: write.result,
    processing: write.processing,
    commandError: write.error,
    busy: write.processing,
    needsReload: false,
    unknownCommand: '',
    reloadSaved: async () => {},
    submit: async (action: TransferAction) => {
      if (write.result || loadingPreview || !model.preview || model.preview.requiredFieldsUnavailable) return;
      if (missingTransferRequiredFields(model.preview.form, { ...model.preview.fields, ...model.fields }).length)
        return;
      await write.run((id) => saveTransfer(tenantId, model, action, id));
    },
  };
}
