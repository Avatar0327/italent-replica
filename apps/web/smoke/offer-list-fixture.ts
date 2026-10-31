import { OFFER_VIEWS } from '@italent/domain';

export const offerRow = {
  id: '40000000-0000-4000-8000-000000000298',
  name: '合成接线候选人',
  personalEmail: 'offer298@example.com',
  status: 'pending',
  approvalStatus: 'unsubmitted',
  offerType: 'social',
  departmentId: '50000000-0000-4000-8000-000000000298',
  departmentName: '合成研发部',
  departmentFullName: '合成集团/合成研发部',
  positionId: '60000000-0000-4000-8000-000000000298',
  positionName: '合成研发职位',
  postId: '70000000-0000-4000-8000-000000000298',
  postName: '合成研发职务',
  sentBy: '80000000-0000-4000-8000-000000000298',
  sentByName: '合成发送人',
  directManagerId: '90000000-0000-4000-8000-000000000298',
  directManagerName: '合成直线经理',
  plannedEntryDate: '2026-11-01',
  rowActions: { primary: ['submitApproval'], menu: ['transfer', 'invalidate', 'view'] },
};
export const offerFields = [
  ...new Set([
    ...Object.keys(offerRow),
    ...OFFER_VIEWS.flatMap((view) => [...view.columns, ...view.filters].flatMap(({ field }) => (field ? [field] : []))),
  ]),
];
export const offerPermission = {
  objectCode: 'TenantBase.Offer',
  dataOperations: { read: true },
  viewableFields: offerFields,
  editableFields: [],
  buttons: [],
};
export const listFixture = (items: object[] = [offerRow]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 15,
  hasDataPermission: true,
  toolbarActions: [],
});
