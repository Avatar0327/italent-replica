// F-127b 合同协议冒烟的对象权限夹具：形态与 GET /api/tenant/permission/me/objects/:code 的真实返回一致，
// 不虚构按钮（AC-FE-R2a-permissions 用真实接口与领域定义核对）。本文件不引用 playwright，供 vitest 直接读取。
const system = [
  'createdAt',
  'createdBy',
  'id',
  'previousVersionId',
  'revision',
  'tenantId',
  'updatedAt',
  'versionId',
  'versionNo',
];
const operations = (create: boolean, update: boolean, remove: boolean) => ({ create, update, delete: remove });

/** 配置类对象（合同设置、续签规则）：按管理员能力放行，可新增 / 编辑非系统字段，不可删除，没有按钮。 */
function config(objectCode: string, fields: string[]) {
  return {
    objectCode,
    dataOperations: operations(true, true, false),
    viewableFields: [...fields, ...system].sort(),
    editableFields: [...fields].sort(),
    buttons: [] as { buttonCode: string; level: string }[],
  };
}
const contractEditable = [
  'employeeId',
  'number',
  'companyId',
  'typeId',
  'termType',
  'termMonths',
  'signingDate',
  'effectiveDate',
  'endDate',
  'actualTerminationDate',
];
const contractButtons = [
  ...['create', 'createApplication'].map((buttonCode) => ({ buttonCode, level: 'list' })),
  ...['update', 'delete', 'renew', 'change', 'terminate', 'withdraw', 'changeApplication'].map((buttonCode) => ({
    buttonCode,
    level: 'detail',
  })),
];

export const objectPermissions = {
  contract: {
    objectCode: 'TenantBase.EmploymentContract',
    dataOperations: operations(true, true, true),
    viewableFields: [
      ...contractEditable,
      ...['id', 'revision', 'versionNo', 'status', 'approvalStatus', 'signingCount', 'rootContractId', 'operation'],
    ].sort(),
    editableFields: [...contractEditable].sort(),
    buttons: contractButtons,
  },
  /** 合同类型是普通对象：后端写接口只看数据操作（policy masterSave），按钮按数据操作过滤。 */
  type: {
    objectCode: 'TenantBase.ContractType',
    dataOperations: operations(true, true, false),
    viewableFields: ['code', 'enabled', 'id', 'name', 'revision'],
    editableFields: ['code', 'enabled', 'name'],
    buttons: [
      { buttonCode: 'create', level: 'list' },
      { buttonCode: 'update', level: 'detail' },
    ],
  },
  rules: config('TenantBase.ContractRenewalRule', ['name', 'priority', 'orgIds', 'personIds', 'enabled', 'details']),
  settings: config('TenantBase.ContractSettings', [
    'autoRenew',
    'autoTerminate',
    'autoNumber',
    'accumulateRehire',
    'postExitTypeIds',
    'renewalTypeIds',
    'indefiniteTypeIds',
    'uniqueFields',
  ]),
};
export type ObjectPermissionFixture = (typeof objectPermissions)[keyof typeof objectPermissions];
