import { jobReferences, text } from './messages.js';
import type { Choice, TransferAction, TransferBusiness, TransferFormModel, TransferPreview } from './types.js';

export const EMPLOYMENT_API = '/api/tenant/employment';
export const TRANSFER_API = `${EMPLOYMENT_API}/transfers`;
export class TransferApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function transferRequest<T>(tenantId: string, path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, ...options.headers },
  });
  const body = (await response.json()) as T & { error?: { code: string; message: string } };
  if (!response.ok)
    throw new TransferApiError(
      body.error?.code ?? 'REQUEST_FAILED',
      body.error?.message ?? text.failed,
      response.status,
    );
  return body;
}
export function previewInput(model: TransferFormModel) {
  return {
    initiator: model.initiator ?? 'hr',
    mode: 'application',
    effectiveDate: model.effectiveDate,
    transferTypeCode: model.transferTypeCode,
    ...(model.reasonCode ? { reasonCode: model.reasonCode } : {}),
    fields: model.fields,
    customFields: model.customFields,
  };
}
export async function loadReferences(
  tenantId: string,
  preview: TransferPreview,
  model: TransferFormModel,
  signal: AbortSignal,
) {
  const entries = Object.entries(jobReferences).filter(([code]) =>
    ['editable', 'readonly'].includes(preview.form.fieldModes[`preset:${code}`] ?? 'absent'),
  );
  const requests = entries.map(async ([code, kind]) => {
    const query = new URLSearchParams({ asOf: model.effectiveDate, enabled: 'true', pageSize: '100' });
    const department = model.fields.departmentId ?? preview.fields.departmentId;
    if (kind === 'positions' && typeof department === 'string') query.set('orgId', department);
    const result = await transferRequest<{ items: Choice[] }>(tenantId, `/api/tenant/job/${kind}?${query}`, { signal });
    const originalId = preview.before?.fields[code];
    let originals = result.items;
    if (typeof originalId === 'string' && !originals.some((item) => item.id === originalId)) {
      try {
        const original = await transferRequest<Choice>(
          tenantId,
          `/api/tenant/job/${kind}/${encodeURIComponent(originalId)}?asOf=${encodeURIComponent(model.effectiveDate)}`,
          { signal },
        );
        originals = [original];
      } catch {
        originals = [];
      }
    }
    return [code, result.items, originals] as const;
  });
  const results = await Promise.allSettled(requests);
  return {
    references: Object.fromEntries(
      results.map((result, index) =>
        result.status === 'fulfilled' ? [result.value[0], result.value[1]] : [entries[index]![0], []],
      ),
    ),
    beforeReferences: Object.fromEntries(
      results.map((result, index) =>
        result.status === 'fulfilled' ? [result.value[0], result.value[2]] : [entries[index]![0], []],
      ),
    ),
    unavailable: results.some((result) => result.status === 'rejected'),
  };
}
export function saveTransfer(tenantId: string, model: TransferFormModel, action: TransferAction, commandId: string) {
  const body = {
    ...previewInput(model),
    formId: model.preview!.form.id,
    mode: action === 'direct' ? 'direct' : 'application',
    submit: action === 'submit',
  };
  return transferRequest<TransferBusiness>(tenantId, `${TRANSFER_API}/employees/${model.employeeId}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'if-match': String(model.preview!.employeeRevision), 'idempotency-key': commandId },
  });
}
export function submitSavedTransfer(tenantId: string, business: TransferBusiness, commandId: string) {
  return transferRequest<TransferBusiness>(tenantId, `${EMPLOYMENT_API}/businesses/${business.id}/submit`, {
    method: 'POST',
    body: '{}',
    headers: { 'if-match': String(business.revision), 'idempotency-key': commandId },
  });
}
export function requestError(error: unknown) {
  if (error instanceof TransferApiError) return error.code === 'REVISION_CONFLICT' ? text.conflict : error.message;
  return text.failed;
}

export function queryReferences(tenantId: string, model: TransferFormModel, code: string, name: string, page: number) {
  const query = new URLSearchParams({ page: String(page), pageSize: '100' });
  if (code === 'departmentId') {
    query.set('formId', model.preview!.form.id);
    query.set('effectiveDate', model.effectiveDate);
    return transferRequest<{ items: Choice[] }>(tenantId, `${TRANSFER_API}/departments?${query}`);
  }
  query.set('name', name);
  query.set('asOf', model.effectiveDate);
  if (code === 'directManagerId' || code === 'dottedManagerId' || code === 'addedSubordinateIds') {
    query.set('status', 'employed');
    return transferRequest<{ items: Choice[] }>(tenantId, `${EMPLOYMENT_API}/employees?${query}`);
  }
  const kind = jobReferences[code];
  query.set('enabled', 'true');
  const department = model.fields.departmentId ?? model.preview!.fields.departmentId;
  if (kind === 'positions' && typeof department === 'string') query.set('orgId', department);
  return transferRequest<{ items: Choice[] }>(tenantId, `/api/tenant/job/${kind}?${query}`);
}
