import { transferRequest } from '../transfer/api.js';
import type { Choice, FieldValues, TransferBusiness, TransferFormModel } from '../transfer/types.js';
import type { TransferFormAdapter } from '../self-service/shared/transfer-adapter.js';
import type { OwnPreview, Profile } from './types.js';

const BASE = '/api/tenant/self-service/transfer';
const referenceCodes = [
  'departmentId',
  'directManagerId',
  'dottedManagerId',
  'addedSubordinateIds',
  'postId',
  'positionId',
  'levelId',
  'gradeId',
  'sequenceId',
  'professionalLineId',
];

/** DEC-209：只适配本人接口，不向 HR/经理的全租户字典接口回退。 */
export function employeeTransferAdapter(profile: Profile): TransferFormAdapter {
  return {
    initialModel: {
      initiator: 'employee',
      employees: [profile.employee],
      employeeId: profile.employee.id,
      effectiveDate: profile.today,
      reasonCode: '',
      transferTypeCode: 'in_department',
      fields: {},
      customFields: {},
      preview: null,
      departments: [],
      catalog: { types: [], reasons: [] },
    },
    loadPreview,
    queryReferences,
    save: (tenantId, model, _action, commandId) =>
      transferRequest<TransferBusiness>(tenantId, BASE, {
        method: 'POST',
        body: JSON.stringify(input(model)),
        headers: { 'if-match': String(model.preview!.employeeRevision), 'idempotency-key': commandId },
      }),
  };
}
function input(model: TransferFormModel) {
  return {
    effectiveDate: model.effectiveDate,
    ...(model.reasonCode ? { reasonCode: model.reasonCode } : {}),
    fields: model.fields,
    customFields: model.customFields,
  };
}
async function loadPreview(tenantId: string, model: TransferFormModel, signal: AbortSignal) {
  const preview = await transferRequest<OwnPreview>(tenantId, `${BASE}/preview`, {
    method: 'POST',
    body: JSON.stringify(input(model)),
    signal,
  });
  const entries = await Promise.all(
    referenceCodes
      .filter((code) => preview.form.fieldModes[`preset:${code}`] === 'editable')
      .map(async (code) => {
        const { items } = await choices(
          tenantId,
          model.effectiveDate,
          preview.fields.departmentId,
          code,
          '',
          1,
          signal,
        );
        return [code, items] as const;
      }),
  );
  const references: Record<string, Choice[]> = Object.fromEntries(entries);
  const beforeReferences: Record<string, Choice[]> = {};
  appendLabels(beforeReferences, preview.before?.fields ?? {}, preview.beforeLabels);
  appendLabels(references, preview.fields, preview.valueLabels);
  return {
    preview,
    references,
    beforeReferences,
    departments: references.departmentId ?? [],
    catalog: { ...model.catalog, reasons: preview.reasons },
  };
}
function appendLabels(references: Record<string, Choice[]>, fields: FieldValues, labels: Record<string, string>) {
  for (const [code, name] of Object.entries(labels)) {
    const id = fields[code];
    if (typeof id === 'string' && !references[code]?.some((item) => item.id === id))
      references[code] = [{ id, name }, ...(references[code] ?? [])];
  }
}
function queryReferences(tenantId: string, model: TransferFormModel, code: string, name: string, page: number) {
  return choices(tenantId, model.effectiveDate, model.preview?.fields.departmentId, code, name, page);
}
async function choices(
  tenantId: string,
  date: string,
  departmentId: unknown,
  code: string,
  name: string,
  page: number,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({
    asOf: date,
    name,
    page: String(page),
    pageSize: '100',
    ...(typeof departmentId === 'string' ? { departmentId } : {}),
  });
  const result = await transferRequest<{ items: (Choice & { orgPath?: string })[] }>(
    tenantId,
    `${BASE}/references/${code}?${query}`,
    signal ? { signal } : {},
  );
  return {
    items: result.items.map(({ id, name: label, orgPath }) => ({
      id,
      name: orgPath ? `${label} · ${orgPath}` : label,
    })),
  };
}
