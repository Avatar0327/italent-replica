/** 调动联动的提交载荷与接口（R1-T10）。 */
import { contractApi } from '../contracts/model.js';
import { TRANSFER_API, transferRequest } from './api.js';
import type {
  ContractChoice,
  InsuranceAdjustKey,
  LinkageDraft,
  LinkageItemView,
  LinkageView,
  TransferFormModel,
} from './types.js';

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

export const INSURANCE_ADJUST_KEYS: readonly InsuranceAdjustKey[] = [
  'adjustedInsuranceRegionCode',
  'adjustedInsurancePlanId',
  'adjustedInsuranceCompanyId',
];
/** 只带填了的调整值：未带的键服务端记为空（linkage/input.ts），与“不调整”同义。 */
function insurancePayload(draft: LinkageDraft) {
  return Object.fromEntries(INSURANCE_ADJUST_KEYS.filter((key) => draft[key]).map((key) => [key, draft[key]]));
}

/**
 * F-481 §3.1：变更合同且选“是”并选了模板时带 esign；选“否”或未选不带键（服务端记为否）。
 * 没选变更的合同也照带，由服务端拒绝并给出原因（电子签署须同时变更合同），不在前端静默丢掉。
 */
function esignPayload(draft: LinkageDraft) {
  const templateIds = draft.esignTemplateIds ?? [];
  const signing = draft.changeContract && draft.electronicSignature === true;
  return signing && templateIds.length ? { esign: { templateIds: [...templateIds] } } : {};
}

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
    ...insurancePayload(draft),
    ...esignPayload(draft),
  };
  return Object.keys(linkage).length ? linkage : undefined;
}

export function sourceDepartment(model: TransferFormModel): string | null {
  const value = model.preview?.before?.fields.departmentId;
  return typeof value === 'string' ? value : null;
}

/**
 * 可变更的合同，并补上原合同生效日期（F-504）：调动候选只回 id 与编号，生效日取合同模块的员工合同摘要
 * （apps/api/src/modules/contracts/routes.ts `/employees/:id/contracts`，同一对象权限与数据范围）。
 * 摘要读不到（无权、超上限）、生效日被字段裁剪或没有这份合同时不补，保存时不弹确认框，候选照常可选。
 */
export async function loadContractChoices(tenantId: string, employeeId: string, signal?: AbortSignal) {
  const options = signal ? { signal } : {};
  const path = `${TRANSFER_API}/employees/${employeeId}/contracts`;
  const [choices, dates] = await Promise.all([
    transferRequest<{ items: ContractChoice[] }>(tenantId, path, options),
    contractEffectiveDates(tenantId, employeeId, options),
  ]);
  const withDate = (item: ContractChoice) => {
    const effectiveDate = dates.get(item.id);
    return effectiveDate ? { ...item, effectiveDate } : item;
  };
  return { items: choices.items.map(withDate) };
}

async function contractEffectiveDates(tenantId: string, employeeId: string, options: RequestInit) {
  const dates = new Map<string, string>();
  try {
    const path = `${contractApi.list}/employees/${employeeId}/contracts`;
    const { items } = await transferRequest<{ items?: unknown }>(tenantId, path, options);
    for (const row of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
      if (typeof row?.id === 'string' && typeof row.effectiveDate === 'string') dates.set(row.id, row.effectiveDate);
    }
  } catch {
    // 生效日只用于提示，读不到不影响选择合同与保存。
  }
  return dates;
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
