import type { OfferExample, OfferState } from '../demo-stubs/offers.js';
import { actions as a, approvals, m, states, viewSpecs } from './messages.js';
export type View = (typeof viewSpecs)[number]['key'];
export type DemoAction = 'transfer' | 'invalidate';
export const pendingViews: View[] = ['pending', 'unsubmitted', 'approving', 'approved'];
export function inView(row: OfferExample, view: View) {
  if (view === 'all') return true;
  if (['unsubmitted', 'approving', 'approved'].includes(view)) return row.state === 'pending' && row.approval === view;
  return row.state === view;
}
export const canInvalidate = (r: OfferExample) =>
  r.state === 'sent' || r.state === 'accepted' || (r.state === 'pending' && r.kind !== '实习');
// 待发 / 已接受候选未实测：仅按规格34表展示；不执行转移，也不增加未验证的已入职候选。
export const targets: Record<OfferState, OfferState[]> = {
  pending: ['accepted', 'rejected'],
  sent: ['pending', 'accepted', 'rejected'],
  accepted: ['rejected'],
  rejected: ['pending', 'accepted'],
  onboarded: [],
  invalid: [],
};
export function rowActions(row: OfferExample, view: View): { primary: string[]; menu: string[] } {
  // R2e3 12：全部视图不固定操作列；已接受样本显示邮件，其余未验证状态仅保留查看。
  if (view === 'all') {
    if (row.state === 'pending')
      return { primary: row.approval === 'approving' ? [a.view] : [a.edit, a.view], menu: [] };
    return { primary: [row.state === 'accepted' ? a.mail : a.view], menu: [] };
  }
  if (row.state === 'pending') {
    const menu = [
      a.edit,
      a.send,
      m.transfer,
      ...(canInvalidate(row) ? [m.invalidate] : []),
      a.associate,
      a.view,
      a.remove,
    ];
    // DEC-533 / 派发B5：非实习待发失效不受审批状态限制，其余未验证子菜单不补造。
    const invalidation = canInvalidate(row) ? [m.invalidate] : [];
    if (row.approval === 'approving') return { primary: [a.remind, a.delegate, a.revoke], menu: invalidation };
    if (row.approval === 'approved') return { primary: [a.edit], menu: invalidation };
    return { primary: [a.approve], menu };
  }
  switch (row.state) {
    case 'sent':
      return { primary: [a.resend], menu: [a.sync, m.transfer, a.mail, m.invalidate, a.view] };
    case 'accepted':
      return { primary: [a.sync], menu: [m.transfer, a.mail, m.invalidate, a.sign, a.view] };
    case 'rejected':
      return { primary: [m.transfer], menu: [a.mail, a.view] };
    case 'onboarded':
      return { primary: [a.mail], menu: [a.sign, a.view] };
    case 'invalid':
      return { primary: [a.copy], menu: [a.mail, a.view] };
  }
}
export function displayValue(row: OfferExample, field: string): string {
  const values: Record<string, string | undefined> = {
    姓名: row.name,
    录用人员: row.name,
    个人邮箱: row.email,
    邮箱: row.email,
    Offer类型: row.kind,
    录用部门: row.department,
    部门: row.department,
    组织全称: row.department,
    职位: row.post,
    录用职位: row.post,
    应聘职位: row.post,
    职务: row.job,
    预计入职日期: row.date,
    拟入职日期: row.date,
    入职日期: row.date,
    计划入职日期: row.date,
    offer状态: states[row.state],
    审批状态: approvals[row.approval],
    接受offer日期: row.acceptedDate,
    拒绝offer日期: row.state === 'rejected' ? row.refusal?.date : undefined,
    拒绝原因备注: row.state === 'rejected' ? row.refusal?.remark : undefined,
    失效时间: row.invalidAt,
  };
  return values[field] ?? m.empty;
}
export function filterOffers(rows: OfferExample[], view: View, filters: Record<string, string>) {
  const fields = viewSpecs.find((v) => v.key === view)!.filters as readonly string[];
  return rows.filter(
    (r) => inView(r, view) && fields.every((f) => !filters[f] || displayValue(r, f).includes(filters[f]!)),
  );
}
