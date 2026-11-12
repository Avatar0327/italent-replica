import { projectFields, type Values } from '../../foundation/forms/values.js';
import type { ObjectPermission } from '../../foundation/permission-model.js';
import { messages as kernel } from '../../foundation/forms/messages.js';
export type RequestKind = 'exit' | 'partTime';
export interface RequestFormData {
  employee: { id: string; name: string; code: string | null; revision: number };
  dataOperations: { create: boolean; update: boolean };
  fieldModes: Record<string, string>;
  updateFieldModes: Record<string, string>;
  values: Values;
}
export const requestPaths = {
  exit: '/api/tenant/self-service/exit-requests',
  partTime: '/api/tenant/self-service/part-time-requests',
};
export const requestFields = {
  // attachmentRefs：手写离职申请附件的 ID 数组（F-479 设计 §2.2、§5.2）
  exit: ['lastWorkDate', 'reasonCode', 'whereaboutsCode', 'attachmentRefs'],
  partTime: [
    'serviceType',
    'effectiveDate',
    'endDate',
    'departmentId',
    'directManagerId',
    'postId',
    'levelId',
    'sequenceId',
    'requestRemark',
  ],
};
export const requiredRequestFields = {
  exit: ['lastWorkDate'],
  partTime: ['serviceType', 'effectiveDate', 'departmentId'],
};
export function selfRequestAllowed(buttons: readonly { buttonCode: string; level: string }[], kind: RequestKind) {
  return buttons.some(
    (b) => b.buttonCode === (kind === 'exit' ? 'Exit.Self' : 'PartTime.Self') && b.level === 'detail',
  );
}
export function selfRequestAccess(form: RequestFormData, editing: boolean): ObjectPermission {
  const modes = form[editing ? 'updateFieldModes' : 'fieldModes'];
  const keys = Object.keys(modes).filter((key) => ['editable', 'readonly'].includes(modes[key]!));
  const map = (key: string) => (key === 'partTimeType' ? 'serviceType' : key);
  return {
    objectCode: '',
    dataOperations: form.dataOperations,
    buttons: [],
    viewableFields: keys.map(map),
    editableFields: keys
      .filter((key) => form.dataOperations[editing ? 'update' : 'create'] && modes[key] === 'editable')
      .map(map),
  };
}
export function selfRequestValues(kind: RequestKind, source: Values): Values {
  const values = { ...source, ...(source.fields as Values | undefined) };
  return { ...source, ...Object.fromEntries(requestFields[kind].map((key) => [key, values[key]])) };
}
export function selfRequestBody(kind: RequestKind, values: Values, editable: readonly string[]): Values {
  const body = projectFields(
    values,
    editable.filter((key) => requestFields[kind].includes(key) && Object.hasOwn(values, key)),
  );
  if (kind === 'exit') {
    if ('whereaboutsCode' in body) body.whereaboutsCode ??= '';
    // 后端只收 ID 数组（null 判 400）；清空即 []（F-479 设计 §2.2）
    if ('attachmentRefs' in body) body.attachmentRefs ??= [];
    return body;
  }
  const fields = projectFields(
    body,
    ['departmentId', 'directManagerId'].filter((key) => Object.hasOwn(body, key)),
  );
  return {
    ...projectFields(
      body,
      ['endDate', 'requestRemark'].filter((key) => Object.hasOwn(body, key)),
    ),
    ...('serviceType' in body ? { partTimeType: body.serviceType } : {}),
    ...('effectiveDate' in body ? { startDate: body.effectiveDate } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  };
}
export function selfRequestErrors(kind: RequestKind, values: Values) {
  const errors = requiredRequestFields[kind].filter((key) => !values[key]);
  const date = (value: unknown) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  for (const key of kind === 'exit' ? ['lastWorkDate'] : ['effectiveDate', 'endDate'])
    if (values[key] && !date(values[key])) errors.push(key);
  if (
    kind === 'partTime' &&
    values.serviceType &&
    !['part_time', 'secondment', 'expatriate'].includes(String(values.serviceType))
  )
    errors.push('serviceType');
  if (values.endDate && String(values.endDate) < String(values.effectiveDate)) errors.push('endDate');
  return [...new Set(errors)];
}
export function acceptSelfRequest(
  raw: unknown,
  employeeId: string,
  sent: number,
  id?: string,
): Values & { id: string; revision: number } {
  const row = raw as Values | undefined;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    row.employeeId !== employeeId ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0 ||
    typeof row.status !== 'string' ||
    (id && (row.id !== id || Number(row.revision) <= sent))
  )
    throw new Error(kernel.invalidReceipt);
  return row as Values & { id: string; revision: number };
}
