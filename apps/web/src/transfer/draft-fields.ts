import { linkageText as l, presetLabels, text as m } from './messages.js';
import type { TransferBusiness } from './types.js';

export interface SavedDraft extends TransferBusiness {
  withEstablishment?: boolean;
  transferTypeCode?: string;
  employeeId?: string;
}
export type DraftOptions = Readonly<Record<string, unknown>>;
export interface DraftRow {
  key: string;
  label: string;
  value: string;
}
const labels: Readonly<Record<string, string>> = {
  ...presetLabels,
  contract: l.changeContract,
  targetId: l.contractTarget,
  startDate: l.trialStartDate,
  endDate: l.contractEndDate,
  termMonths: l.contractTermMonths,
  signingDate: l.contractSigningDate,
  months: l.trialMonths,
  adjustSalary: l.adjustSalary,
  onTrial: l.trial,
  handover: l.handoverPerson,
  handoverPersonId: l.handoverPerson,
  dutyTransfer: l.dutyTransfer,
  subordinates: l.dutySubordinates,
  orgRoles: l.dutyDepartmentHead,
  partTimes: l.partTimes,
  employeeId: m.employeeId,
  receiverId: m.receiver,
  relation: m.relation,
  orgId: presetLabels.departmentId!,
  role: m.orgRole,
  recordId: m.recordId,
};
function valueText(value: unknown): string {
  if (value === undefined) return m.unread;
  if (value === null || value === '') return m.none;
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  return String(value);
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function draftRows(business: SavedDraft, options: DraftOptions): DraftRow[] {
  const rows: DraftRow[] = [];
  const add = (key: string, label: string, value: unknown) => rows.push({ key, label, value: valueText(value) });
  const visit = (key: string, label: string, value: unknown) => {
    if (Array.isArray(value)) {
      if (!value.length) add(key, label, null);
      value.forEach((item: unknown, index: number) => visit(`${key}.${index}`, `${label} ${index + 1}`, item));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([child, item]) =>
        visit(`${key}.${child}`, `${label} · ${labels[child] ?? child}`, item),
      );
    } else add(key, label, value);
  };
  add('employeeId', m.employeeId, business.employeeId);
  add('effectiveDate', m.date, business.effectiveDate);
  add('transferTypeCode', m.type, business.transferTypeCode);
  add('withEstablishment', m.withEstablishment, business.withEstablishment);
  // 缺失字段绝不从新建表单的默认值或旧缓存补齐（DEC-464）。
  for (const code of new Set([...Object.keys(presetLabels), ...Object.keys(business.fields ?? {})])) {
    visit(`fields.${code}`, presetLabels[code] ?? code, business.fields?.[code]);
  }
  if (business.customFields === undefined) add('customFields', m.custom, undefined);
  else Object.entries(business.customFields).forEach(([key, value]) => visit(`customFields.${key}`, key, value));
  add('contract', l.changeContract, options.contract === undefined ? undefined : options.contract !== null);
  if (options.contract) {
    const contract = object(options.contract);
    add('contract.targetId', l.contractTarget, contract.targetId);
    const fields = object(contract.fields);
    const contractLabels = {
      startDate: m.contractStartDate,
      endDate: l.contractEndDate,
      termMonths: l.contractTermMonths,
      signingDate: l.contractSigningDate,
    };
    for (const key of new Set([...Object.keys(contractLabels), ...Object.keys(fields)])) {
      visit(`contract.fields.${key}`, contractLabels[key as keyof typeof contractLabels] ?? key, fields[key]);
    }
  }
  add('adjustSalary', l.adjustSalary, options.adjustSalary);
  const trial = object(options.onTrial);
  add('onTrial.startDate', l.trialStartDate, options.onTrial === null ? null : trial.startDate);
  add('onTrial.months', l.trialMonths, options.onTrial === null ? null : trial.months);
  add('handover', l.handoverPerson, options.handover === null ? null : object(options.handover).handoverPersonId);
  visit(
    'dutyTransfer',
    l.dutyTransfer,
    options.dutyTransfer && {
      subordinates: undefined,
      orgRoles: undefined,
      ...object(options.dutyTransfer),
    },
  );
  visit('partTimes', l.partTimes, options.partTimes);
  return rows;
}
