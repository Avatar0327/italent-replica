import {
  EMPLOYMENT_API,
  TRANSFER_API,
  transferRequest,
  previewInput,
  loadReferences,
  managerReferencePath,
} from '../../transfer/api.js';
import { text } from '../../transfer/messages.js';
import type {
  Choice,
  TransferAction,
  TransferBusiness,
  TransferFormModel,
  TransferPreview,
} from '../../transfer/types.js';

export async function loadPreview(tenantId: string, model: TransferFormModel, signal: AbortSignal) {
  const preview = await transferRequest<TransferPreview>(
    tenantId,
    `${TRANSFER_API}/employees/${model.employeeId}/preview`,
    { method: 'POST', body: JSON.stringify(previewInput(model)), signal },
  );
  const query = new URLSearchParams({ formId: preview.form.id, effectiveDate: model.effectiveDate, pageSize: '100' });
  const [departments, references] = await Promise.all([
    preview.form.fieldModes['preset:departmentId'] &&
    !['hidden', 'absent'].includes(preview.form.fieldModes['preset:departmentId'])
      ? transferRequest<{ items: Choice[] }>(
          tenantId,
          model.initiator === 'manager'
            ? managerReferencePath(model, preview, 'departmentId')
            : `${TRANSFER_API}/departments?${query}`,
          { signal },
        )
      : Promise.resolve({ items: [] }),
    loadReferences(tenantId, preview, model, signal),
  ]);
  return { preview, departments: departments.items, ...references };
}

export async function reloadSavedModel(tenantId: string, model: TransferFormModel, saved: TransferBusiness) {
  const latest = await transferRequest<TransferBusiness>(tenantId, `${EMPLOYMENT_API}/businesses/${saved.id}`);
  if (latest.id !== saved.id || !Number.isInteger(latest.revision) || !latest.fields) throw new Error(text.failed);
  const modelWithDate = {
    ...model,
    effectiveDate: latest.effectiveDate ?? model.effectiveDate,
    fields: {},
    customFields: {},
  };
  const loaded = await loadPreview(tenantId, modelWithDate, new AbortController().signal);
  return {
    latest,
    refreshed: {
      ...modelWithDate,
      ...loaded,
      preview: { ...loaded.preview, fields: latest.fields, customFields: latest.customFields ?? {} },
    },
  };
}

export function savedNotice(result: TransferBusiness, action: TransferAction) {
  if (result.status === 'draft') return text.draftSaved;
  if (action === 'direct') return result.status === 'effective' ? text.effective : text.scheduled;
  return text.submitted;
}
