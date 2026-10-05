/** 调动联动的提交载荷与接口（R1-T10）。 */
import { TRANSFER_API, transferRequest } from './api.js';
import type { Choice, LinkageDraft, LinkageItemView, LinkageView, TransferFormModel } from './types.js';

export const emptyLinkage: LinkageDraft = {
  changeContract: false,
  contractTargetId: '',
  contractFields: {},
  adjustSalary: false,
  onTrialMonths: null,
  onTrialStartDate: '',
  handoverPersonId: '',
  dutyReceiverId: '',
  dutySubordinateIds: [],
  transferDepartmentHead: false,
};

/** 草稿 → 服务端 linkage；没有任何联动时返回 undefined（不提交该键）。 */
export function linkagePayload(draft: LinkageDraft | undefined, sourceDepartmentId: string | null) {
  if (!draft) return undefined;
  const contractFields = Object.fromEntries(
    Object.entries(draft.contractFields).filter(([, value]) => value !== null && value !== ''),
  );
  const receiverId = draft.dutyReceiverId;
  const subordinates = receiverId
    ? draft.dutySubordinateIds.map((employeeId) => ({ employeeId, receiverId, relation: 'direct' as const }))
    : [];
  const orgRoles =
    receiverId && draft.transferDepartmentHead && sourceDepartmentId
      ? [{ orgId: sourceDepartmentId, role: 'person_in_charge' as const, receiverId }]
      : [];
  const linkage = {
    ...(draft.changeContract && draft.contractTargetId
      ? { contract: { targetId: draft.contractTargetId, fields: contractFields } }
      : {}),
    ...(draft.adjustSalary ? { adjustSalary: true } : {}),
    ...(draft.onTrialMonths
      ? {
          onTrial: {
            months: draft.onTrialMonths,
            ...(draft.onTrialStartDate ? { startDate: draft.onTrialStartDate } : {}),
          },
        }
      : {}),
    ...(draft.handoverPersonId ? { handover: { handoverPersonId: draft.handoverPersonId } } : {}),
    ...(subordinates.length || orgRoles.length ? { dutyTransfer: { subordinates, orgRoles } } : {}),
  };
  return Object.keys(linkage).length ? linkage : undefined;
}

export function sourceDepartment(model: TransferFormModel): string | null {
  const value = model.preview?.before?.fields.departmentId;
  return typeof value === 'string' ? value : null;
}

export function loadContractChoices(tenantId: string, employeeId: string, signal?: AbortSignal) {
  return transferRequest<{ items: Choice[] }>(tenantId, `${TRANSFER_API}/employees/${employeeId}/contracts`, {
    ...(signal ? { signal } : {}),
  });
}

export function loadLinkage(tenantId: string, businessId: string) {
  return transferRequest<LinkageView>(tenantId, `${TRANSFER_API}/${businessId}/linkage`);
}

export function retryLinkageItem(tenantId: string, item: LinkageItemView, commandId: string) {
  return transferRequest<LinkageItemView>(tenantId, `${TRANSFER_API}/linkage-items/${item.id}/retry`, {
    method: 'POST',
    body: '{}',
    headers: { 'if-match': String(item.revision), 'idempotency-key': commandId },
  });
}
