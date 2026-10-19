import { ApiError, type Command } from '../foundation/client.js';
import { isBlank, projectFields, type Values } from '../foundation/forms/values.js';
import { d } from './direct-messages.js';
import type { Row } from './model.js';
const validObject = (row: { id?: string; revision?: number }) =>
  typeof row.id === 'string' && row.id.length > 0 && Number.isSafeInteger(row.revision) && Number(row.revision) >= 0;
export const recordFields = [
  'departmentId',
  'positionId',
  'postId',
  'sequenceId',
  'levelId',
  'directManagerId',
  'dottedManagerId',
  'employmentForm',
  'employmentType',
];
export const formFields = ['employeeId', 'serviceType', 'effectiveDate', 'endDate', ...recordFields];
export function directValues(row: Values): Values {
  // 缺键保持缺键；控件的空值由共享 projectFields 提供，不能给被裁剪字段造出业务值。
  return { ...row, ...(row.fields as Values | undefined) };
}
export function directBody(values: Values, create: boolean) {
  const keys = recordFields.filter((key) => Object.hasOwn(values, key));
  return {
    ...(create ? { partTimeType: values.serviceType, startDate: values.effectiveDate } : {}),
    ...(Object.hasOwn(values, 'endDate') ? { endDate: values.endDate ?? null } : {}),
    ...(keys.length ? { fields: projectFields(values, keys) } : {}),
  };
}
export function validateDirect(values: Values, create: boolean, baseline: Values) {
  if (create)
    for (const key of ['employeeId', 'serviceType', 'effectiveDate', 'departmentId'])
      if (isBlank(values[key])) throw new ApiError(400, 'VALIDATION_FAILED', 'fields', d.required(d.labels[key]!));
  if (!create && Object.hasOwn(values, 'endDate') && !isBlank(baseline.endDate) && isBlank(values.endDate))
    throw new ApiError(400, 'VALIDATION_FAILED', 'fields', d.cannotClear);
  const start = values.effectiveDate ?? baseline.effectiveDate;
  if (values.endDate && start && String(values.endDate) < String(start))
    throw new ApiError(400, 'VALIDATION_FAILED', 'fields', d.beforeStart);
}
export function validateBatch(rows: Values[], date: unknown) {
  if (
    !rows.length ||
    rows.length > 200 ||
    new Set(rows.map((row) => row.id)).size !== rows.length ||
    rows.some((row) => !validObject({ id: row.id as string, revision: row.revision as number }))
  )
    throw new ApiError(400, 'VALIDATION_FAILED', 'fields', d.invalidBatch);
  if (isBlank(date)) throw new ApiError(400, 'VALIDATION_FAILED', 'fields', d.required(d.labels.endDate!));
}
export function recordReceipt(value: unknown, id: string | undefined, command: Command): Row {
  const row = value as Row | undefined;
  if (
    !row ||
    !validObject({ id: row.id, revision: row.revision as number }) ||
    (id !== undefined && row.id !== id) ||
    Number(row.revision) < (command.revision ?? 1)
  )
    throw new Error(d.invalidReceipt);
  return row;
}
export function batchReceipt(value: unknown, expected: { recordId: string; revision: number }[]) {
  const result = value as Values | undefined;
  const rows = result?.items as Row[] | undefined;
  if (
    !result ||
    result.total !== expected.length ||
    result.succeeded !== expected.length ||
    result.failed !== 0 ||
    !Array.isArray(rows) ||
    rows.length !== expected.length ||
    new Set(rows.map((row) => row.id)).size !== expected.length
  )
    throw new Error(d.invalidReceipt);
  for (const item of expected) {
    const row = rows.find((row) => row.id === item.recordId);
    recordReceipt(row, item.recordId, { id: '', revision: item.revision + 1, body: {} });
  }
  return rows;
}
export function errorLines(details: Values): string[] {
  const items = Array.isArray(details.items) ? (details.items as Values[]) : [];
  return [
    ...items
      .filter((item) => typeof item.recordId === 'string')
      .map((item) =>
        Object.hasOwn(item, 'expected')
          ? d.version(String(item.recordId), item.expected, item.actual)
          : `${item.recordId}：${d.reasons[String(item.reason)] ?? String(item.reason ?? '')}`,
      ),
    ...(typeof details.hiddenCount === 'number' && details.hiddenCount > 0 ? [d.hidden(details.hiddenCount)] : []),
  ];
}
