import { m } from './messages.js';
export type Row = Record<string, unknown>;
export type View = 'expiring' | 'missing' | 'expired_unrenewed' | 'in_review' | 'valid' | 'all';
export const views: { key: View; label: string }[] = [
  { key: 'expiring', label: '即将到期' },
  { key: 'missing', label: '入职缺失' },
  { key: 'expired_unrenewed', label: '过期未续签' },
  { key: 'in_review', label: '审批中合同协议' },
  { key: 'valid', label: '有效合同协议' },
  { key: 'all', label: '全部合同协议' },
];
export const object = 'TenantBase.EmploymentContract';
export const configObjects = {
  types: 'TenantBase.ContractType',
  rules: 'TenantBase.ContractRenewalRule',
  settings: 'TenantBase.ContractSettings',
};
export type Config = keyof typeof configObjects;
export type Filters = Record<string, string | string[] | undefined>;
export function listPath(view: View, page: number, days: number) {
  const query = new URLSearchParams({ view, page: String(page), pageSize: '15' });
  if (view === 'expiring') query.set('days', String(days));
  return `/api/tenant/contracts?${query}`;
}
export function canOpenRecord(row: Row, view: View) {
  return (
    typeof row.id === 'string' &&
    !String(row.id).startsWith('demo-') &&
    view !== 'missing' &&
    view !== 'in_review' &&
    row.rowType !== 'request' &&
    (view !== 'all' || row.rowType === 'contract')
  );
}
export function value(input: unknown, key: string): string {
  if (input === undefined || input === null || input === '') return '--';
  if (typeof input === 'boolean') return input ? '是' : '否';
  if (Array.isArray(input)) return input.length ? input.map((item) => value(item, key)).join('、') : '--';
  if (typeof input === 'object') return '--';
  const labels = Object.hasOwn(m.values, key) ? m.values[key] : undefined;
  return labels && Object.hasOwn(labels, String(input)) ? labels[String(input)]! : String(input);
}
const common = ['name', 'email', 'number', 'companyId', 'typeId', 'termType', 'effectiveDate'];
export function columnKeys(view: View) {
  if (view === 'missing') return ['name', 'email', 'code', 'entryDate', 'department', 'job', 'post'];
  if (view === 'all')
    return [
      ...common,
      'actualTerminationDate',
      'status',
      'approvalStatus',
      'signature',
      'electronicFile',
      'signatureRecords',
      'signingCount',
      'operation',
    ];
  if (view === 'in_review')
    return [
      'name',
      'email',
      'operation',
      ...common.slice(2),
      'endDate',
      'status',
      'approvalStatus',
      'approver',
      'signature',
      'electronicFile',
    ];
  if (view === 'expiring') return [...common, 'endDate', 'signingCount'];
  return [
    ...common,
    'endDate',
    ...(view === 'expired_unrenewed' ? ['actualTerminationDate'] : []),
    'signature',
    'electronicFile',
    ...(view === 'valid' ? ['attachment'] : []),
  ];
}
export function columnTitle(key: string, view: View) {
  if (key === 'companyId' && ['valid', 'expired_unrenewed', 'expiring'].includes(view)) return m.legalCompany;
  return m.columnTitles[view]?.[key] ?? m.fields[key];
}
export function width(key: string, view: View) {
  if (key === 'signatureRecords') return 179;
  if (key === 'email') return view === 'missing' ? 215 : 200;
  if (key.toLowerCase().includes('date')) return view === 'missing' ? 120 : 105;
  if (key === 'electronicFile' || key === 'attachment') return 262;
  if (key === 'signingCount') return 172;
  if (view === 'missing') return key === 'code' ? 171 : 155;
  if (['expired_unrenewed', 'in_review'].includes(view)) return key === 'name' ? 92 : 112;
  return 140;
}
