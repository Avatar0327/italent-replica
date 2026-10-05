/**
 * 联动进入审批快照（PR #74 第二轮 P1-6，DEC-057 / DEC-058）：审批人看到的是生效时将执行的变化；变化字段参与盲审，
 * 字段编码与任职对象字段权限一致（TRANSFER_LINKAGE_FIELDS）。没有联动时不出现任何联动字段。
 */
import type { Tx } from '@italent/db';
import { latestLinkage } from './store.js';

export interface LinkageApproval {
  readonly values: Readonly<Record<string, unknown>>;
  readonly changedFields: readonly string[];
  /** 联动版本参与审批载荷版本：联动被改动后旧审批一律 409。 */
  readonly version: string | null;
}

export async function linkageApproval(
  tx: Tx,
  tenantId: string,
  businessId: string,
  kind: string,
): Promise<LinkageApproval> {
  const stored = kind === 'transfer' ? await latestLinkage(tx, tenantId, businessId) : null;
  if (!stored) return { values: {}, changedFields: [], version: null };
  const { options } = stored;
  const values: Record<string, unknown> = {
    isChangeContract: !!options.contract,
    contractChange: options.contract ? { targetId: options.contract.targetId, ...options.contract.fields } : null,
    adjustSalary: options.adjustSalary,
    onTrialStartDate: options.onTrial?.startDate ?? null,
    onTrialMonths: options.onTrial?.months ?? null,
    handoverPersonId: options.handover?.handoverPersonId ?? null,
    partTimeEnds: options.partTimes.map((item) => item.recordId),
    dutyTransfer: options.dutyTransfer,
  };
  const changedFields = Object.entries(values)
    .filter(([, value]) => value !== null && value !== false && !(Array.isArray(value) && !value.length))
    .map(([field]) => field);
  return { values, changedFields, version: stored.versionId };
}
