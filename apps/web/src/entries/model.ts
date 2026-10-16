import dayjs from 'dayjs';
import { ApiError, type ApiClient, type Command } from '../foundation/client.js';
import { messages as kernel } from '../foundation/forms/messages.js';
import { projectFields, isBlank, type Values } from '../foundation/forms/values.js';
import type { EntryViewItem } from '../../../api/src/modules/employment/entry-views.js';
export type Row = Partial<EntryViewItem> & { id: string; probation?: boolean | null };
export type View = 'all' | 'today' | 'cancelled' | 'hired';
export const base = '/api/tenant/employment';
export const collection = `${base}/pending-entries`;
export const object = 'TenantBase.EmploymentRecord';
export const contractObject = 'TenantBase.EmploymentContract';
export const contractFields = ['companyId', 'typeId', 'termType', 'termMonths', 'endDate'];
export const editable = ['probation', 'probationMonths', 'probationEndDate', ...contractFields];
export const endOfTerm = (date: string, months: number) =>
  dayjs(date).add(months, 'month').subtract(1, 'day').format('YYYY-MM-DD');
export const hasContract = (values: Values) => contractFields.some((field) => !isBlank(values[field]));
export function completeBody(values: Values, date: string, fields: readonly string[]) {
  const selected = projectFields(
    values,
    fields.filter((field) => contractFields.includes(field)),
  );
  const contract = Object.fromEntries(Object.entries(selected).filter(([, value]) => !isBlank(value)));
  if (values.probation === true && fields.includes('probationEndDate') && fields.includes('probationStartDate')) {
    contract.probationStartDate = date;
    contract.probationEndDate = values.probationEndDate;
  }
  return { probation: values.probation, ...(hasContract(selected) ? { contract } : {}) };
}
/** 保留服务端 message；共享客户端按其他模块要求保留了通用 403 文案，本模块按派发原样展示。 */
export async function request<T>(api: ApiClient, path: string, options?: Parameters<ApiClient['request']>[1]) {
  try {
    return await api.request<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.serverMessage) error.message = error.serverMessage;
    throw error;
  }
}
export async function readEntry(api: ApiClient, row: Row): Promise<Values> {
  const [business, record, employee] = await Promise.all([
    request<Values>(api, `${base}/businesses/${row.id}`),
    request<Values>(api, `${base}/records/${row.id}`),
    request<Values>(api, `${base}/employees/${row.employeeId}`),
  ]);
  return {
    ...business,
    ...(record.fields as Values),
    name: employee.name,
    code: employee.code,
    probation: business.probation ?? row.probation ?? null,
  };
}
export function receipt(value: unknown, row: Row, command: Command, action: string): Values {
  const result = value as Values | null;
  const valid = result && typeof result.id === 'string' && result.id && Number.isSafeInteger(result.revision);
  const identity = ['postpone', 'replace'].includes(action) ? result?.id !== row.id : result?.id === row.id;
  const revision = ['postpone', 'replace'].includes(action)
    ? Number(result?.revision) >= 1
    : Number(result?.revision) > Number(command.revision);
  if (!valid || !identity || !revision || result.employeeId !== row.employeeId) throw new Error(kernel.unknown);
  return result;
}
export function emailText(value: unknown): string {
  const result = value as Values | null;
  const rule = typeof result?.ruleId === 'string' && typeof result?.ruleName === 'string';
  if (result?.status === 'generated' && typeof result.email === 'string' && rule)
    return `${result.email}（${result.ruleName}）`;
  if (result?.status === 'no_rule') return 'no_rule';
  if (result?.status === 'skipped' && result.reason === 'REHIRE_NOT_GENERATED') return result.reason;
  if (result?.status === 'failed' && rule && ['PREFIX_EMPTY', 'PREFIX_ILLEGAL'].includes(String(result.reason)))
    return String(result.reason);
  throw new Error(kernel.unknown);
}
