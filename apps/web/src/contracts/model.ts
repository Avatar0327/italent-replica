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
/**
 * 配置页写入口按对象数据操作判断，不看按钮：后端配置路由只校验数据操作（policy.ts NO_CONFIG_BUTTON / NO_MASTER_BUTTON），
 * 配置类对象的 /me/objects 恒返回空按钮；删除规则后端按 update 校验（配置对象没有 delete）。
 */
export function configAccess(permission?: { summary?: true; dataOperations: Readonly<Record<string, boolean>> }) {
  const operations = permission && !permission.summary ? permission.dataOperations : {};
  return { create: operations.create === true, update: operations.update === true };
}
export type ListQuery = Record<string, string | undefined>;
/** 后端列表参数白名单（list-query.ts）；入职缺失只认员工、关键字、组织、类型与按姓名排序（applicableQuery）。 */
export const filterKeys = [
  'employeeId',
  'keyword',
  'orgId',
  'includeChildren',
  'typeId',
  'companyId',
  'status',
  'termType',
  'effectiveFrom',
  'effectiveTo',
  'endFrom',
  'endTo',
  'sort',
  'order',
];
const missingKeys = ['employeeId', 'keyword', 'orgId', 'includeChildren', 'typeId', 'sort', 'order'];
export const sortFields = ['endDate', 'effectiveDate', 'signingDate', 'name', 'number'];
export function listQuery(view: View, filters: ListQuery): ListQuery {
  const keys = view === 'missing' ? missingKeys : filterKeys;
  const query: ListQuery = Object.fromEntries(keys.filter((key) => filters[key]).map((key) => [key, filters[key]]));
  if (view === 'missing' && query.sort !== 'name') delete query.sort;
  if (!query.orgId) delete query.includeChildren;
  if (!query.sort) delete query.order;
  return query;
}
/** 区间开始晚于截止时不发请求，避免把空结果误当“没有数据”。 */
export function rangeErrors(filters: ListQuery) {
  return (
    [
      ['effectiveFrom', 'effectiveTo'],
      ['endFrom', 'endTo'],
    ] as const
  )
    .filter(([from, to]) => filters[from] && filters[to] && filters[from]! > filters[to]!)
    .map(([from]) => from);
}
/** 合同模块接口路径集中在此（apps/api/src/modules/contracts/routes.ts），各组件不再各写一份。 */
const base = '/api/tenant/contracts';
export const contractApi = {
  list: base,
  records: `${base}/records`,
  commands: `${base}/commands`,
  settings: `${base}/settings`,
  types: `${base}/master-data/types`,
  companies: `${base}/master-data/companies`,
  rules: `${base}/rules`,
} as const;
/** 筛选与排序参数见 apps/api/src/modules/contracts/list-query.ts；空值不发送。 */
export function listPath(view: View, page: number, days: number, filters: ListQuery = {}, pageSize = 15) {
  const query = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
  if (view === 'expiring') query.set('days', String(days));
  for (const [key, input] of Object.entries(filters)) if (input) query.set(key, input);
  return `${contractApi.list}?${query}`;
}
export function canOpenRecord(row: Row, view: View) {
  return (
    typeof row.id === 'string' &&
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
/** 后端尚未提供的列（#316 姓名 / 工号 / 邮箱、电子协议签署）：保留原站列位，内容留空。 */
export const stubColumns = new Set([
  'email',
  'signature',
  'electronicFile',
  'signatureRecords',
  'attachment',
  'approver',
]);
/** 入职缺失行的任职摘要（queries.ts missingContracts）：列键 → employment 字段。 */
export const employmentColumns: Record<string, string> = {
  entryDate: 'entryDate',
  department: 'departmentId',
  job: 'postId',
  post: 'positionId',
};
/** 入职缺失行里不属于 employment 摘要的人员列（姓名、工号）：与 employmentColumns 一起构成七个人员列的另外几列（邮箱是 stubColumns）。 */
export const missingPersonColumns = new Set(['name', 'code']);
/**
 * 列表某列是否显示（唯一的列判定）：后端未提供的占位列与入职缺失的人员列不受合同对象字段清单过滤——
 * 入职缺失的行是人员，不是合同；其余按合同对象的可见字段。
 */
export function isColumnShown(view: View, key: string, allowed: readonly string[]) {
  return (
    stubColumns.has(key) ||
    (view === 'missing' && (key in employmentColumns || missingPersonColumns.has(key))) ||
    allowed.includes(key)
  );
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
