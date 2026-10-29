/**
 * 组织调整的审批字段目录（R2-T08 设计 §4.5 编码契约）。
 * 本文件只是编码与类型 formFields：本对象字段用静态命名空间编码（权限编码 = 披露编码），合同变更等外部对象字段的编码
 * 带明细身份（逐行判可见）。**不注册到权限对象**：对象编码与按钮清单待 A-14 取证（DEC-644，F273A），由 BE-10a2 挂接。
 */

/**
 * 权限对象编码。待 F-273（F273A）取证，BE-10a2 定稿；现取设计值 TenantBase.OrgAdjustment（§9.2）。
 * 全仓只在这里写一次，审批类型、适配器与后续授权都引用这个常量，取证后改一处即可。
 */
export const ORG_ADJUSTMENT_OBJECT_CODE = 'TenantBase.OrgAdjustment';

/** 标准流程编码（规格 33 OA-R1，预置的发起条件）。 */
export const ORG_ADJUSTMENT_PROCESS_CODE = 'OrganizationProcess';

/** 头字段：调整范围（scopeNote）语义未取证，字段关闭，不进审批表单（A-9，DEC-645）。 */
export const ORG_ADJUSTMENT_HEADER_FIELDS = ['subject', 'effectiveDate', 'approvalSubjectOrgId', 'content'] as const;

/** 五个明细分区的静态编码：节点勾了某分区的哪些字段，审批人就能看哪些（§4.5 第二行）。 */
export const ORG_ADJUSTMENT_SECTION_FIELDS = {
  orgItems: [
    'orgItems.adjustType',
    'orgItems.targetOrgId',
    'orgItems.name',
    'orgItems.code',
    'orgItems.shortName',
    'orgItems.parentOrgId',
    'orgItems.displayOrder',
    'orgItems.level',
    'orgItems.halfLevel',
    'orgItems.updateDescendantLevels',
    'orgItems.personInChargeId',
    'orgItems.hrbpId',
    'orgItems.addEmployment',
    'orgItems.transferOldHeadSubordinates',
    'orgItems.adjustNewHeadManager',
    'orgItems.newHeadManagerId',
    'orgItems.syncEstablishment',
    'orgItems.deactivationEstablishmentMode',
    'orgItems.establishmentTransferAmount',
    'orgItems.batchTransfer',
    'orgItems.transferToOrgId',
    'orgItems.isStaged',
  ],
  transferItems: [
    'transferItems.employeeId',
    'transferItems.departmentId',
    'transferItems.positionId',
    'transferItems.postId',
    'transferItems.levelId',
    'transferItems.directManagerId',
    'transferItems.dutyTransfer',
    'transferItems.trial',
    'transferItems.adjustSalary',
    'transferItems.withEstablishment',
  ],
  positionItems: [
    'positionItems.adjustType',
    'positionItems.targetPositionId',
    'positionItems.sourcePositionId',
    'positionItems.orgId',
    'positionItems.name',
    'positionItems.postId',
    'positionItems.parentPositionId',
  ],
  establishmentItems: [
    'establishmentItems.operation',
    'establishmentItems.orgId',
    'establishmentItems.delta',
    'establishmentItems.targetOrgId',
  ],
  partTimeItems: [
    'partTimeItems.operation',
    'partTimeItems.employeeId',
    'partTimeItems.partTimeRecordId',
    'partTimeItems.departmentId',
    'partTimeItems.positionId',
    'partTimeItems.endDate',
  ],
} as const;
export type OrgAdjustmentSection = keyof typeof ORG_ADJUSTMENT_SECTION_FIELDS;

/** 合同变更的容器编码：节点勾它，就展开为本单全部带明细身份的合同字段编码（§4.5 第三行）。 */
export const ORG_ADJUSTMENT_CONTRACT_CONTAINER = 'transferItems.contractChange';

/** 审批类型的 formFields：头字段 + 五个分区的静态字段 + 合同变更容器。 */
export const ORG_ADJUSTMENT_FORM_FIELDS: readonly string[] = [
  ...ORG_ADJUSTMENT_HEADER_FIELDS,
  ...Object.values(ORG_ADJUSTMENT_SECTION_FIELDS).flat(),
  ORG_ADJUSTMENT_CONTRACT_CONTAINER,
];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CONTRACT_CHANGE_CODE = new RegExp(`^transferItems\\.(${UUID})\\.contractChange\\.([A-Za-z][A-Za-z0-9]*)$`);

/** 带明细身份的合同变更编码：transferItems.<itemId>.contractChange.<field>（编码按 itemId，与行序无关）。 */
export function contractChangeFieldCode(itemId: string, field: string): string {
  const code = `transferItems.${itemId}.contractChange.${field}`;
  if (!parseContractChangeFieldCode(code)) throw new Error(`合同变更字段编码不合法：${code}`);
  return code;
}

export function parseContractChangeFieldCode(code: string): { itemId: string; field: string } | null {
  const match = CONTRACT_CHANGE_CODE.exec(code);
  return match ? { itemId: match[1]!, field: match[2]! } : null;
}
