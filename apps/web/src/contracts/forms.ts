// F-127b：合同表单纯逻辑。规则以后端 contracts/service.ts prepare 为准，前端只提前提示，不替代服务端校验。
import { addDays, contractAction, termEnd } from '@italent/domain';
import { m } from './messages.js';
import type { Row } from './model.js';

export type Operation = 'create' | 'change' | 'renew' | 'terminate';
export type Mode = 'direct' | 'application';
export const operations: Operation[] = ['create', 'change', 'renew', 'terminate'];
const contractFields = [
  'number',
  'companyId',
  'typeId',
  'termType',
  'signingDate',
  'effectiveDate',
  'termMonths',
  'endDate',
];
/** 不能为 null 的字段：缺值时不发送，由后端沿用原合同或报必填。 */
const required = new Set(['number', 'companyId', 'typeId', 'termType', 'effectiveDate']);

export const buttonLevel = (op: Operation) => (op === 'create' ? 'list' : 'detail');
export function availableModes(can: (button: string, level: string) => boolean, op: Operation): Mode[] {
  return (['direct', 'application'] as const).filter((mode) => can(contractAction(op, mode), buttonLevel(op)));
}
/**
 * 详情上三种入口各按自己的状态规则（规格 32 CT-R3；后端 service.ts assertOperationState）：都要求审批状态为生效；
 * 变更 / 终止只对有效合同，续签对有效或已终止合同。最终以服务端拒绝为准。
 */
const sourceStatuses: Record<Exclude<Operation, 'create'>, string[]> = {
  change: ['valid'],
  renew: ['valid', 'terminated'],
  terminate: ['valid'],
};
export function sourceOperations(source: Row): Operation[] {
  if (source.approvalStatus !== 'effective') return [];
  return (['change', 'renew', 'terminate'] as const).filter((op) => sourceStatuses[op].includes(String(source.status)));
}
export function formFieldNames(op: Operation) {
  return op === 'terminate' ? ['actualTerminationDate'] : contractFields;
}
/** 续签不能改合同类型（service.ts prepare）；只读字段不进提交集合。 */
export function editableFormFields(op: Operation, editable: (field: string) => boolean) {
  return formFieldNames(op).filter((field) => editable(field) && !(op === 'renew' && field === 'typeId'));
}
const pick = (source: Row | undefined, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, source?.[key] ?? null]));
export function initialValues(op: Operation, source?: Row): Row {
  if (op === 'terminate') return { actualTerminationDate: null };
  if (op === 'create') return { ...pick(undefined, contractFields), termType: 'fixed' };
  const copied = pick(source, contractFields);
  if (op === 'change') return { ...copied, effectiveDate: null };
  // 续签沿用原合同主体，编号、签订日期、终止日期重新确定；生效日期与后端默认一致（原终止日次日）。
  const end = typeof source?.endDate === 'string' ? source.endDate : null;
  return { ...copied, number: null, signingDate: null, endDate: null, effectiveDate: end ? addDays(end, 1) : null };
}
/** 用户改了 changed 字段后需要联动设置的值；只在人工输入时调用，冲突重读回填不触发。 */
export function linkTerm(changed: string, values: Row): Row {
  if (changed === 'termType' && values.termType === 'indefinite') return { endDate: null, termMonths: null };
  if (!['effectiveDate', 'termMonths', 'termType'].includes(changed) || values.termType === 'indefinite') return {};
  const { effectiveDate, termMonths } = values;
  return typeof effectiveDate === 'string' && effectiveDate && Number.isInteger(termMonths) && Number(termMonths) > 0
    ? { endDate: termEnd(effectiveDate, Number(termMonths)) }
    : {};
}
const empty = (input: unknown) => input === undefined || input === null || input === '';
export function validateContract(
  op: Operation,
  values: Row,
  context: { source?: Row; autoNumber?: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const need = (field: string) => {
    if (empty(values[field])) errors[field] = m.required;
  };
  if (op === 'terminate') {
    need('actualTerminationDate');
    const start = context.source?.effectiveDate;
    if (!errors.actualTerminationDate && typeof start === 'string' && String(values.actualTerminationDate) < start)
      errors.actualTerminationDate = m.terminateBeforeStart;
    return errors;
  }
  if (op === 'renew') {
    if (empty(context.source?.endDate)) need('effectiveDate');
  } else {
    // 自动编号只在设置明确开启时放行；读不到设置按必填处理。
    if (op === 'create' && context.autoNumber !== true) need('number');
    for (const field of ['companyId', 'typeId', 'termType', 'effectiveDate']) need(field);
    if (values.termType === 'fixed') need('endDate');
  }
  if (!empty(values.endDate) && !empty(values.effectiveDate) && String(values.endDate) <= String(values.effectiveDate))
    errors.endDate = m.endAfterStart;
  const months = values.termMonths;
  if (!empty(months) && !(Number.isInteger(months) && Number(months) >= 1 && Number(months) <= 1200))
    errors.termMonths = m.termMonthsRange;
  return errors;
}
export function normalize(values: Row): Row {
  return Object.fromEntries(Object.entries(values).map(([key, input]) => [key, input === '' ? null : input]));
}
export function commandFields(body: Row): Row {
  return Object.fromEntries(
    Object.entries(normalize(body)).filter(
      ([key, input]) => input !== undefined && !(input === null && required.has(key)),
    ),
  );
}

export interface ContractReceipt {
  kind: 'contract' | 'request';
  id: string;
  status: string;
}
const invalid = () => new Error(m.invalidReceipt);
const record = (raw: unknown): Row => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  return raw as Row;
};
const validRevision = (input: unknown) => Number.isSafeInteger(input) && Number(input) >= 1;
/** 申请 / 合同按回执实际形态区分（F-123 §F-127b），不按提交方式推断。 */
export function parseContractReceipt(
  raw: unknown,
  expected: { employeeId: string; operation: Operation; sourceId?: string },
): ContractReceipt {
  const row = record(raw);
  if (typeof row.id !== 'string' || !row.id || row.employeeId !== expected.employeeId || !validRevision(row.revision))
    throw invalid();
  const status = String(row.status);
  if ('operation' in row || 'mode' in row) {
    if (row.operation !== expected.operation || !['in_review', 'approved'].includes(status)) throw invalid();
    if (expected.sourceId && row.targetId !== expected.sourceId) throw invalid();
    return { kind: 'request', id: row.id, status };
  }
  if (row.approvalStatus !== 'effective') throw invalid();
  const terminate = expected.operation === 'terminate';
  if (terminate ? status !== 'terminated' || row.id !== expected.sourceId : status !== 'valid') throw invalid();
  if (!terminate && expected.sourceId && row.id === expected.sourceId) throw invalid();
  return { kind: 'contract', id: row.id, status };
}
/** 类型 / 规则保存回执：revision = 提交值 + 1；删除回执为 {id, deleted:true}。 */
export function parseSavedReceipt(raw: unknown, expected: { id?: string; revision: number; deleted?: boolean }) {
  const row = record(raw);
  if (typeof row.id !== 'string' || !row.id || (expected.id && row.id !== expected.id)) throw invalid();
  if (expected.deleted ? row.deleted !== true : row.revision !== expected.revision + 1) throw invalid();
  return { id: row.id };
}
/** 催办成功返回流程详情：须是本流程，版本不低于提交时的版本（催办只记日志，可能不升版）。 */
export function parseUrgeReceipt(raw: unknown, expected: { instanceId: string; revision: number }) {
  const row = record(raw);
  if (row.id !== expected.instanceId || !validRevision(row.revision) || Number(row.revision) < expected.revision)
    throw invalid();
  return { id: expected.instanceId };
}
export function parseSettingsReceipt(raw: unknown, expected: { tenantId: string; revision: number }) {
  const row = record(raw);
  if (!expected.tenantId || row.tenantId !== expected.tenantId || row.revision !== expected.revision + 1)
    throw invalid();
  return { id: expected.tenantId };
}
export function myPendingTask(
  detail: { tasks: { id: string; status: string; assigneeUserId?: string | null }[] },
  userId: string | undefined,
) {
  return userId
    ? detail.tasks.find((task) => task.status === 'pending' && task.assigneeUserId === userId)?.id
    : undefined;
}
