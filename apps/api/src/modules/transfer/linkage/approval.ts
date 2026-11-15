/**
 * 联动进入审批快照（PR #74 第二轮 P1-6，DEC-057 / DEC-058）：审批人看到的是生效时将执行的变化；变化字段参与盲审，
 * 任职侧字段编码与任职对象字段权限一致（TRANSFER_LINKAGE_FIELDS）。
 * 第三轮 P1-1：合同变更的内容属于合同对象，逐项展开为 `contractChange.<合同字段>`，作为嵌套的合同字段登记
 * （approval/foreign-fields.ts），披露与盲审按合同对象的查看权、目标合同范围与合同字段权限判断，不以容器整体出现。
 */
import { sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import type { ForeignField } from '../../approval/foreign-fields.js';
import { rowsOf } from '../../employment/record-store.js';
import { foldInsuranceOrigin, insurancePosition } from '../../insurance/archive-fold.js';
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
    // F-474-8c-2c：社保调整值属于任职记录对象字段，与上面各项同一口径进载荷、变化检测与字段权限。
    adjustedInsuranceRegionCode: options?.adjustedInsuranceRegionCode ?? null,
    adjustedInsurancePlanId: options?.adjustedInsurancePlanId ?? null,
    adjustedInsuranceCompanyId: options?.adjustedInsuranceCompanyId ?? null,
  };
}

/**
 * 社保原值（设计 §3.4 / §4.3，DEC-896④）：只对本单真正填写的调整项披露，作为社保档案对象的嵌套字段，
 * 容器为对应的调整字段；可见性只看社保档案对象的查看权与字段查看权（approval/foreign-fields.ts），
 * 原值不进变化字段，所以看不到原值不影响审批，看不到调整字段才触发盲审。
 */
const INSURANCE_ORIGINS = [
  {
    adjusted: 'adjustedInsuranceRegionCode',
    code: 'insuranceOrigin.regionCode',
    field: 'insuranceRegionCode',
    key: 'regionCode',
  },
  { adjusted: 'adjustedInsurancePlanId', code: 'insuranceOrigin.planId', field: 'insurancePlanId', key: 'planId' },
  {
    adjusted: 'adjustedInsuranceCompanyId',
    code: 'insuranceOrigin.companyId',
    field: 'insuranceCompanyId',
    key: 'companyId',
  },
] as const;

async function insuranceOrigins(
  tx: Tx,
  tenantId: string,
  subject: LinkageSubject,
  businessId: string,
  own: Readonly<Record<string, unknown>>,
) {
  const used = INSURANCE_ORIGINS.filter((item) => own[item.adjusted] != null);
  if (!used.length) return { entries: [], foreignFields: [] as ForeignField[] };
  const position = await insurancePosition(tx, tenantId, subject.employeeId, subject.effectiveDate, businessId);
  const origin = await foldInsuranceOrigin(tx, tenantId, subject.employeeId, position);
  return {
    entries: used.map((item) => [item.code, origin[item.key]] as const),
    foreignFields: used.map((item): ForeignField => ({
      code: item.code,
      container: item.adjusted,
      objectCode: MODULE_OBJECTS.socialSecurityProfile.code,
      field: item.field,
      employeeId: subject.employeeId,
      creatorId: null,
    })),
  };
}

export interface LinkageSubject {
  readonly employeeId: string;
  readonly effectiveDate: string;
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
  subject?: LinkageSubject,
): Promise<LinkageApproval> {
  const stored = kind === 'transfer' ? await latestLinkage(tx, tenantId, businessId) : null;
  if (!stored) return { values: {}, changedFields: [], foreignFields: [], version: null };
  const { contractChange: _container, ...own } = linkageFieldValues(stored.options);
  const contract = stored.options.contract;
  const entries = contract ? contractFieldEntries(contract) : [];
  const target = contract ? await contractOwner(tx, tenantId, contract.targetId) : null;
  const contractForeign = target
    ? entries.map(([code, field]) => ({ code, container: CONTAINER, objectCode: CONTRACT_OBJECT, field, ...target }))
    : [];
  const insurance = subject
    ? await insuranceOrigins(tx, tenantId, subject, businessId, own)
    : { entries: [], foreignFields: [] as ForeignField[] };
  const foreignFields = [...contractForeign, ...insurance.foreignFields];
  // 没填的社保调整项整项不进载荷，详情里不出现空的社保组。
  const present = Object.fromEntries(
    Object.entries(own).filter(([code, value]) => !code.startsWith('adjustedInsurance') || value !== null),
  );
  const values = {
    ...present,
    ...Object.fromEntries(entries.map(([code, , value]) => [code, value])),
    ...Object.fromEntries(insurance.entries),
  };
  // 任职侧联动字段为空 / false 即“未设置该联动”，不改变任何对象；合同变更里明确给出的字段一律是变化，
  // 显式 null / false 是清空或置否，同样改写合同（第四轮 P1，DEC-057 / 058）。
  const changedFields = [
    ...Object.entries(own)
      .filter(([, value]) => value !== null && value !== false && !(Array.isArray(value) && !value.length))
      .map(([field]) => field),
    ...entries.map(([code]) => code),
  ];
  return { values, changedFields, foreignFields, version: stored.versionId };
}

async function contractOwner(tx: Tx, tenantId: string, contractId: string) {
  const [row] = rowsOf<{ employeeId: string; creatorId: string | null }>(
    await tx.execute(sql`SELECT employee_id AS "employeeId", created_by AS "creatorId" FROM contract_records
      WHERE tenant_id=${tenantId} AND id=${contractId}::uuid`),
  );
  return row ?? null;
}
