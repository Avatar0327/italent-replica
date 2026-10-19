import { PART_TIME_BUTTONS } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { canButton, type ObjectPermission } from '../foundation/permission-model.js';
import { projectFields, type Values } from '../foundation/forms/values.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { apiRoot, type Row } from './model.js';
import { r } from './request-messages.js';
export const requests = `${apiRoot}/part-time-requests`;
export type RequestKind = 'add' | 'extend' | 'end';
export type RequestAction = 'edit' | 'submit' | 'withdraw' | 'revoke' | 'delete';
export const kindButton = {
  add: PART_TIME_BUTTONS.application,
  extend: PART_TIME_BUTTONS.extend,
  end: PART_TIME_BUTTONS.end,
};
export const isKind = (kind: unknown): kind is RequestKind => ['add', 'extend', 'end'].includes(String(kind));
export function canCreate(kind: RequestKind, p?: ObjectPermission) {
  return !!p?.dataOperations[kind === 'add' ? 'create' : 'update'] && canButton(p, kindButton[kind], 'detail');
}
/** D2B-01 澄清：状态 × 对象/按钮权；initiator 是渠道，原发起人资格由后端最终判断。 */
export function actionsFor(row: Values, p?: ObjectPermission): RequestAction[] {
  if (!p || !isKind(row.kind)) return [];
  const editable = ['draft', 'rejected'].includes(String(row.status));
  const reviewing = row.status === 'in_review';
  const button = (code: string) => canButton(p, code, 'detail');
  const own = button(kindButton[row.kind]);
  return [
    ...(editable && own && p.dataOperations.update ? ['edit' as const] : []),
    ...(editable && own && p.dataOperations.update && button('Employment.Submit') ? ['submit' as const] : []),
    ...(editable && own && p.dataOperations.delete && button('Employment.Delete') ? ['delete' as const] : []),
    ...(reviewing && own && p.dataOperations.update && button('Employment.Withdraw') ? ['withdraw' as const] : []),
    ...((editable || reviewing) && p.dataOperations.update && button('Employment.Revoke') ? ['revoke' as const] : []),
  ];
}
export const preset = [
  'departmentId',
  'positionId',
  'postId',
  'levelId',
  'sequenceId',
  'directManagerId',
  'dottedManagerId',
  'employmentForm',
  'employmentType',
];
export function requestFields(kind: RequestKind, create: boolean) {
  return kind === 'add'
    ? [...(create ? ['employeeId'] : []), 'serviceType', 'effectiveDate', 'endDate', ...preset, 'requestRemark']
    : ['endDate', 'requestRemark'];
}
export function requestValues(row: Row): Values {
  return { ...row, ...projectFields({ ...row, ...row.fields }, requestFields('add', true)) };
}
export function bodyFor(kind: RequestKind, action: 'create' | RequestAction, values: Values, submit: boolean): Values {
  if (action !== 'create' && action !== 'edit') return {};
  const fields = Object.fromEntries(
    preset.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
  );
  const body: Values = Object.fromEntries(
    ['endDate', 'requestRemark'].filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key] ?? null]),
  );
  if (kind === 'add') {
    if (Object.hasOwn(values, 'serviceType')) body.partTimeType = values.serviceType;
    if (Object.hasOwn(values, 'effectiveDate')) body.startDate = values.effectiveDate;
    if (Object.keys(fields).length) body.fields = fields;
  }
  return action === 'create'
    ? {
        ...body,
        requestType: kind,
        submit,
        ...(kind === 'add' ? { employeeId: values.employeeId } : { recordId: values.recordId }),
      }
    : body;
}
export function acceptRequest(value: unknown, id: string | undefined, revision: number): Row {
  const row = value as Row | undefined;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    (id && row.id !== id) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) <= revision
  )
    throw new Error(kernel.invalidReceipt);
  return row;
}
export function requestError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const message =
    error.serverMessage ??
    (error.status === 403 ? r.denied : error.code === 'PART_TIME_NOT_EXTENDED' ? r.equalDate : error.message);
  // 所有 409 都进入内核重读/差异路径；业务提示另显示，不把冲突作为未知重放。
  if (error.status === 409) return new ApiError(409, 'REVISION_CONFLICT', 'refresh', message);
  error.message = message;
  return error;
}
