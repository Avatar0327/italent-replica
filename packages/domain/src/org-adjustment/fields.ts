/** 组织调整审批字段目录（R2-T08 v1.6 §4.5；权限编码 = 披露编码）。 */

/** F273A §2：原站视图 TenantBase.IntegrationOrgApprovalAdjustNavView 对应这两个业务对象。 */
export const ORG_ADJUSTMENT_OBJECT_CODE = 'TenantBase.OrganizationApproval';
export const ORG_ADJUSTMENT_DETAIL_OBJECT_CODE = 'TenantBase.OrganizationApprovalDetail';

/** 标准流程编码（规格 33 OA-R1，预置的发起条件）。 */
export const ORG_ADJUSTMENT_PROCESS_CODE = 'OrganizationProcess';

/** 头字段：调整范围为组织多选（F273A §4、设计 §2.1A）。 */
export const ORG_ADJUSTMENT_HEADER_FIELDS = [
  'subject',
  'effectiveDate',
  'approvalSubjectOrgId',
  'adjustmentRange',
  'content',
] as const;

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
