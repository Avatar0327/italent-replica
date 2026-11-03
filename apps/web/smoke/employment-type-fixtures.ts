// F-323b 人员类别设置页与下拉的夹具：权限、列表行、选项的形态与真实接口一致（AC-EMP-F323b-labels 用真实接口核对）。
// 本文件不引用 playwright，供 vitest 直接读取；数据全部为合成值。
const system = [
  'createdAt',
  'createdBy',
  'enabled',
  'id',
  'previousVersionId',
  'revision',
  'tenantId',
  'updatedAt',
  'versionId',
  'versionNo',
];
const fields = ['displayOrder', 'effectiveDate', 'expiryDate', 'name'];

/** 租户管理员读人员类别对象：增删改与启停按钮齐全。 */
export const employmentTypePermission = {
  objectCode: 'TenantBase.EmploymentType',
  dataOperations: { create: true, update: true, delete: true },
  viewableFields: [...fields, ...system].sort(),
  editableFields: [...fields].sort(),
  buttons: [
    { buttonCode: 'create', level: 'list' },
    { buttonCode: 'update', level: 'detail' },
    { buttonCode: 'delete', level: 'detail' },
    { buttonCode: 'disable', level: 'detail' },
    { buttonCode: 'enable', level: 'detail' },
  ],
};

/** GET /employment/employment-types?view= 的 items 项（employment-types.ts columns）。 */
export const employmentTypeRow = (overrides: Partial<EmploymentTypeRow> = {}): EmploymentTypeRow => ({
  id: '30000000-0000-4000-8000-000000000001',
  name: '合成类别甲',
  displayOrder: 10,
  effectiveDate: '2018-01-01',
  expiryDate: '9999-12-31',
  enabled: true,
  revision: 1,
  ...overrides,
});
export interface EmploymentTypeRow {
  id: string;
  name: string;
  displayOrder: number;
  effectiveDate: string;
  expiryDate: string;
  enabled: boolean;
  revision: number;
}

/** GET /employment/employment-types/options 的 items 项：只给启用项的 ID、名称、顺序号。 */
export const employmentTypeOption = (row: EmploymentTypeRow = employmentTypeRow()) => ({
  id: row.id,
  name: row.name,
  displayOrder: row.displayOrder,
});
