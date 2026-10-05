/** 合同规则：32 §2，CT-R3～18。日期为租户业务日，事件时间由应用层管理。 */
export const CONTRACT_FIELDS = [
  'number',
  'typeId',
  'companyId',
  'termType',
  'termMonths',
  'signingDate',
  'effectiveDate',
  'endDate',
  'actualTerminationDate',
  'probationStartDate',
  'probationEndDate',
  'probationSalary',
  'regularSalary',
  'employmentRecordId',
  'sourceCode',
] as const;
export const CONTRACT_OBJECT = 'TenantBase.EmploymentContract';
export const CONTRACT_FLOW = {
  create: 'AddContractApproval',
  renew: 'RenewContractProcess',
  change: 'ChangeContractProcess',
  terminate: 'TerminateContractProcess',
} as const;
export type ContractOperation = keyof typeof CONTRACT_FLOW;
export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function termEnd(start: string, months: number): string {
  const date = new Date(`${start}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const max = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, max));
  return addDays(date.toISOString().slice(0, 10), -1);
}
export interface RenewalContract {
  readonly id: string;
  readonly employeeId: string;
  readonly typeId: string;
  readonly effectiveDate?: string;
  readonly endDate: string | null;
  readonly status: string;
  readonly approvalStatus: string;
  readonly actualTerminationDate: string | null;
  readonly signingCount: number;
}
export interface RenewalDetail {
  readonly typeId: string;
  readonly months: number;
  readonly initiatorId: string;
  readonly daysBefore: number;
  readonly skipTypeIds: readonly string[];
}
export interface RenewalRule {
  readonly id: string;
  readonly priority: number;
  readonly orgIds: readonly string[];
  readonly personIds: readonly string[];
  readonly details: readonly RenewalDetail[];
}
export function automaticRenewalPlans(
  contracts: readonly RenewalContract[],
  rules: readonly RenewalRule[],
  employeeId: string,
  orgId: string | null,
  today: string,
) {
  // CT-R5：先选整个人的一条规则，再匹配明细，绝不按合同类型回退到低优先级规则。
  const rule = [...rules]
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .find((r) => (orgId !== null && r.orgIds.includes(orgId)) || r.personIds.includes(employeeId));
  if (!rule) return [];
  const own = contracts.filter((c) => c.employeeId === employeeId && c.status !== 'void');
  return rule.details.flatMap((detail) => {
    const latest = own
      .filter((c) => c.typeId === detail.typeId)
      .sort(
        (a, b) => (b.endDate ?? '9999-12-31').localeCompare(a.endDate ?? '9999-12-31') || a.id.localeCompare(b.id),
      )[0];
    if (
      !latest ||
      !latest.endDate ||
      latest.status !== 'valid' ||
      latest.approvalStatus !== 'effective' ||
      latest.actualTerminationDate ||
      addDays(latest.endDate, -detail.daysBefore) > today
    )
      return [];
    if (
      own.some(
        (c) =>
          c.effectiveDate &&
          c.effectiveDate > latest.endDate! &&
          (detail.skipTypeIds.includes(c.typeId) || c.typeId === latest.typeId),
      )
    )
      return [];
    const signingCount = latest.signingCount + 1;
    const effectiveDate = addDays(latest.endDate, 1);
    const termType = signingCount > 2 ? 'indefinite' : 'fixed';
    return [
      {
        targetId: latest.id,
        ruleId: rule.id,
        initiatorId: detail.initiatorId,
        signingCount,
        effectiveDate,
        termType,
        termMonths: termType === 'fixed' ? detail.months : null,
        endDate: termType === 'fixed' ? termEnd(effectiveDate, detail.months) : null,
      },
    ];
  });
}
export function isRenewed(contract: RenewalContract, contracts: readonly RenewalContract[], types: readonly string[]) {
  return (
    !!contract.endDate &&
    contracts.some(
      (next) =>
        next.id !== contract.id &&
        next.employeeId === contract.employeeId &&
        next.status !== 'void' &&
        next.approvalStatus === 'effective' &&
        next.effectiveDate === addDays(contract.endDate!, 1) &&
        (next.typeId === contract.typeId || (types.includes(next.typeId) && types.includes(contract.typeId))),
    )
  );
}
