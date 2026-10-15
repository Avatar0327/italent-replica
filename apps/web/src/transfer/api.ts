import { linkagePayload, sourceDepartment } from './linkage-api.js';
import { jobReferences, text } from './messages.js';
import type { Choice, TransferAction, TransferBusiness, TransferFormModel, TransferPreview } from './types.js';
import { ApiError, createApiClient, rejectionMessage } from '../foundation/client.js';

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
  const api = createApiClient(() => ({ tenantId, identityKey: '' }));
  const headers = new Headers(options.headers);
  const method = (options.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  const revision = headers.get('if-match');
  try {
    return await api.request<T>(path, {
      method,
      signal: options.signal ?? undefined,
      ...(method !== 'GET'
        ? {
            command: {
              id: headers.get('idempotency-key') ?? crypto.randomUUID(),
              ...(revision === null ? {} : { revision: Number(revision) }),
              body: typeof options.body === 'string' ? (JSON.parse(options.body) as unknown) : {},
            },
          }
        : {}),
    });
  } catch (cause) {
    // 兼容现有表单的未知结果判定（>=500 锁住命令）；网络中断同样不能直接重提。
    if (cause instanceof ApiError)
      throw new TransferApiError(cause.code, transferErrorMessage(cause), cause.status || 503);
    throw cause;
  }
}
function transferErrorMessage(error: ApiError) {
  // DEC-464 / DEC-473：无字段明细的业务拒绝保留原因；刷新与其他错误仍使用底座文案（统一走底座的 rejectionMessage）。
  return rejectionMessage(error);
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
    const result = await transferRequest<{ items: Choice[] }>(
      tenantId,
      model.initiator === 'manager'
        ? managerReferencePath(model, preview, code, '', 1)
        : `/api/tenant/job/${kind}?${query}`,
      { signal },
    );
    const originalId = preview.before?.fields[code];
    let originals = result.items;
    if (
      model.initiator !== 'manager' &&
      typeof originalId === 'string' &&
      !originals.some((item) => item.id === originalId)
    ) {
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
/** 保存载荷：HR 入口带联动（R1-T10），本人申请不带（`12` 附录）。 */
export function transferBody(model: TransferFormModel, action: TransferAction) {
  const linkage = model.initiator === 'employee' ? undefined : linkagePayload(model.linkage, sourceDepartment(model));
  return {
    ...previewInput(model),
    formId: model.preview!.form.id,
    mode: action === 'direct' ? 'direct' : 'application',
    submit: action === 'submit',
    ...(!model.catalog.editableFields || model.catalog.editableFields.includes('withEstablishment')
      ? { withEstablishment: model.withEstablishment === true }
      : {}),
    ...(linkage ? { linkage } : {}),
  };
}
export function saveTransfer(tenantId: string, model: TransferFormModel, action: TransferAction, commandId: string) {
  const body = transferBody(model, action);
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
  if (model.initiator === 'manager')
    return transferRequest<{ items: Choice[] }>(
      tenantId,
      managerReferencePath(model, model.preview!, code, name, page),
    );
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

export function managerReferencePath(
  model: TransferFormModel,
  preview: TransferPreview,
  code: string,
  name = '',
  page = 1,
) {
  const query = new URLSearchParams({
    employeeId: model.employeeId,
    formId: preview.form.id,
    effectiveDate: model.effectiveDate,
    name,
    page: String(page),
    pageSize: '100',
  });
  // 部门列表不应被表单中的旧部门 / 职务值锁定；职务选择也不能依赖原职务仍可选。
  if (code !== 'departmentId') {
    const department = model.fields.departmentId ?? preview.fields.departmentId;
    if (typeof department === 'string') query.set('departmentId', department);
  }
  if (['levelId', 'gradeId', 'sequenceId', 'professionalLineId'].includes(code)) {
    const post = model.fields.postId;
    if (typeof post === 'string') query.set('postId', post);
  }
  return `${TRANSFER_API}/manager/references/${code}?${query}`;
}
