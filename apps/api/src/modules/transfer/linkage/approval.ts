/**
 * 联动进入审批快照（PR #74 第二轮 P1-6，DEC-057 / DEC-058）：审批人看到的是生效时将执行的变化；变化字段参与盲审，
 * 任职侧字段编码与任职对象字段权限一致（TRANSFER_LINKAGE_FIELDS）。
 * 第三轮 P1-1：合同变更的内容属于合同对象，逐项展开为 `contractChange.<合同字段>`，作为嵌套的合同字段登记
 * （approval/foreign-fields.ts），披露与盲审按合同对象的查看权、目标合同范围与合同字段权限判断，不以容器整体出现。
 */
import { sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT } from '@italent/domain';
import type { ForeignField } from '../../approval/foreign-fields.js';
import { rowsOf } from '../../employment/record-store.js';
import type { LinkageOptions } from './input.js';
import { latestLinkage } from './store.js';

export interface LinkageApproval {
  readonly values: Readonly<Record<string, unknown>>;
  readonly changedFields: readonly string[];
  readonly foreignFields: readonly ForeignField[];
  /** 联动版本参与审批载荷版本：联动被改动后旧审批一律 409。 */
  readonly version: string | null;
}

const CONTAINER = 'contractChange';

/** 联动选项落在任职对象上的字段值（容器级）：审批载荷、写入授权的新旧差异共用同一口径。 */
export function linkageFieldValues(options: LinkageOptions | null): Record<string, unknown> {
  return {
    isChangeContract: !!options?.contract,
    contractChange: options?.contract ? { targetId: options.contract.targetId, ...options.contract.fields } : null,
    adjustSalary: options?.adjustSalary ?? false,
    onTrialStartDate: options?.onTrial?.startDate ?? null,
    onTrialMonths: options?.onTrial?.months ?? null,
    handoverPersonId: options?.handover?.handoverPersonId ?? null,
    partTimeEnds: options?.partTimes.map((item) => item.recordId) ?? [],
    dutyTransfer: options?.dutyTransfer ?? null,
  };
}

/** 合同变更逐项展开：键为载荷字段编码，值为 [合同对象字段编码, 值]；自定义字段用 `custom:<id>`。 */
export function contractFieldEntries(contract: NonNullable<LinkageOptions['contract']>): [string, string, unknown][] {
  const { customFields, ...standard } = contract.fields;
  return [
    [`${CONTAINER}.targetId`, 'id', contract.targetId],
    ...Object.entries(standard).map(([field, value]): [string, string, unknown] => [
      `${CONTAINER}.${field}`,
      field,
      value,
    ]),
    ...Object.entries(customFields ?? {}).map(([id, value]): [string, string, unknown] => [
      `${CONTAINER}.custom:${id}`,
      `custom:${id}`,
      value,
    ]),
  ];
}

export async function linkageApproval(
  tx: Tx,
  tenantId: string,
  businessId: string,
  kind: string,
): Promise<LinkageApproval> {
  const stored = kind === 'transfer' ? await latestLinkage(tx, tenantId, businessId) : null;
  if (!stored) return { values: {}, changedFields: [], foreignFields: [], version: null };
  const { contractChange: _container, ...own } = linkageFieldValues(stored.options);
  const contract = stored.options.contract;
  const entries = contract ? contractFieldEntries(contract) : [];
  const target = contract ? await contractOwner(tx, tenantId, contract.targetId) : null;
  const foreignFields = target
    ? entries.map(([code, field]) => ({ code, container: CONTAINER, objectCode: CONTRACT_OBJECT, field, ...target }))
    : [];
  const values = { ...own, ...Object.fromEntries(entries.map(([code, , value]) => [code, value])) };
  const changedFields = Object.entries(values)
    .filter(([, value]) => value !== null && value !== false && !(Array.isArray(value) && !value.length))
    .map(([field]) => field);
  return { values, changedFields, foreignFields, version: stored.versionId };
}

async function contractOwner(tx: Tx, tenantId: string, contractId: string) {
  const [row] = rowsOf<{ employeeId: string; creatorId: string | null }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId", created_by AS "creatorId" FROM contract_records
      WHERE tenant_id=${tenantId} AND id=${contractId}::uuid`),
  );
  return row ?? null;
}
