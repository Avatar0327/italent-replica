import { OFFER_VIEWS, type OfferRowAction } from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { actions as a, m, readEnums } from './messages.js';

export const apiRoot = '/api/tenant/offers';
export const object = 'TenantBase.Offer';
export type View = string;
export interface OfferRow {
  id: string;
  rowActions?: { primary: OfferRowAction[]; menu: OfferRowAction[] };
  [field: string]: unknown;
}
export interface OfferListResult {
  items: OfferRow[];
  total: number;
  hasDataPermission: boolean;
}
export type Filters = Record<string, { value: string; label: string }>;
export const pendingViews = ['pending', 'unsubmitted', 'approving', 'approved'];
const fields: Record<string, string> = {
  ...Object.fromEntries(
    OFFER_VIEWS.flatMap((v) => [...v.columns, ...v.filters]).flatMap((c) => (c.field ? [[c.label, c.field]] : [])),
  ),
  同步状态: 'syncStatus',
  录用人员: 'name',
  参加工作日期: 'workStartDate',
  计划入职日期: 'plannedEntryDate',
  招聘需求: 'recruitmentDemand',
  最后投递渠道: 'channelName',
  职务: 'postId',
  是否有试用期: 'hasProbation',
  转正前基本工资: 'salaryBeforeRegular',
  转正后基本工资: 'salaryAfterRegular',
  社保缴交基数: 'socialInsuranceBase',
  公积金缴交基数: 'housingFundBase',
  成本中心: 'costCenter',
  期限类型: 'contractTermType',
  '合同期限（月）': 'contractMonths',
  终止日期: 'contractEndDate',
};
export const filterFieldOf = (view: string, label: string) =>
  OFFER_VIEWS.find((v) => v.key === view)?.filters.find((f) => f.label === label)?.field;
export const fieldOf = (label: string) => fields[label];
const names: Record<string, string> = {
  录用部门: 'departmentName',
  部门: 'departmentName',
  组织全称: 'departmentFullName',
  职位: 'positionName',
  录用职位: 'positionName',
  职务: 'postName',
  Offer发送人: 'sentByName',
  直线经理: 'directManagerName',
};
/** 名称只沿对应 ID 的可见性展示；缺键或 null 不回落到 UUID，也不拼接部门全称。 */
export function displayValue(row: OfferRow, label: string): string {
  const field = fieldOf(label);
  if (!field || !Object.hasOwn(row, field)) return m.empty;
  const value = row[names[label] ?? field];
  if (value === null || value === undefined || value === '') return m.empty;
  if (Array.isArray(value)) return value.join('、') || m.empty;
  const dictionary = readEnums[field];
  if (dictionary) return Object.hasOwn(dictionary, String(value)) ? dictionary[String(value)]! : m.empty;
  return String(value);
}
export function visibleColumn(label: string, visible: (field: string) => boolean, rows: OfferRow[]) {
  const field = fieldOf(label);
  return !field || (visible(field) && (!rows.length || rows.some((row) => Object.hasOwn(row, field))));
}
export function listPath(view: View, page: number, filters: Filters = {}, pageSize = 15) {
  const query = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
  for (const [field, entry] of Object.entries(filters)) if (entry.value.trim()) query.set(field, entry.value.trim());
  return `${apiRoot}?${query}`;
}
export function filterOptions(rows: OfferRow[], label: string) {
  const field = fieldOf(label);
  if (!field) return [];
  return [
    ...new Map(
      rows.flatMap((row) => {
        const value = row[field];
        return typeof value === 'string' && value ? [[value, { value, label: displayValue(row, label) }] as const] : [];
      }),
    ).values(),
  ];
}
export const actionLabels: Record<OfferRowAction, string> = {
  submitApproval: a.approve,
  edit: a.edit,
  send: a.send,
  transfer: m.transfer,
  invalidate: m.invalidate,
  linkIntern: a.associate,
  view: a.view,
  delete: a.remove,
  resend: a.resend,
  editSync: a.sync,
  viewMail: a.mail,
  sign: a.sign,
  copy: a.copy,
  urge: a.remind,
  delegate: a.delegate,
  revoke: a.revoke,
};
/** F-234 邮件读权同 Offer 查看权；后端 rowActions 尚未登记 viewMail，按已取证状态显示只读入口。 */
export const canReadMail = (row: OfferRow) =>
  ['sent', 'accepted', 'rejected', 'onboarded', 'invalid'].includes(String(row.status));
export function readActions(row: OfferRow) {
  const primary = row.rowActions?.primary.filter((key) => key in actionLabels) ?? [];
  const menu = row.rowActions?.menu.filter((key) => key in actionLabels) ?? [];
  if (canReadMail(row) && ![...primary, ...menu].includes('viewMail'))
    (row.status === 'onboarded' ? primary : menu).push('viewMail');
  return { primary, menu };
}
export const openMail = (id: string) => window.open(`/offers/${encodeURIComponent(id)}/mail`, '_blank', 'noopener');
export function errorKind(error: unknown) {
  return error instanceof ApiError && ['login', 'forbidden', 'not-found'].includes(error.kind)
    ? (error.kind as 'login' | 'forbidden' | 'not-found')
    : 'error';
}
