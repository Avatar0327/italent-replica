// R2-T03 FE2b 离职三个字典设置页的冒烟夹具：权限与字典行的形态与真实接口一致（AC-DM-31-exit-settings 用真实接口核对）。
// 本文件不引用 playwright，供 vitest 直接读取；数据全部为合成值。
const system = [
  'createdAt',
  'createdBy',
  'id',
  // R2 BE-15a / BE-15b2：自动转正、自动考核规则的最后保存人，系统写入、只可查看
  'operatorUserId',
  'previousVersionId',
  'revision',
  'tenantId',
  'updatedAt',
  'versionId',
  'versionNo',
];
// R2 BE-8a：离职自动加黑规则也挂在任职设置对象上（规则写入按这些字段授权，同离职字典 / 入职邮箱规则）；
// R2 BE-15a：自动转正规则同样挂在这里（includeSubordinates / mode / daysBefore / initiatorType / probationResult）；
// R2 BE-15b2：自动发起考核规则同样（assessmentType / daysAfterEntry）；
// R2 BE-8b1：离职交接事项同样（category / sequenceNo / todoType / title / formRef / remark）
const settingsFields = [
  'allowDirectTransfer',
  'assessmentType',
  'autoPopulate',
  'category',
  'code',
  'conditions',
  'daysAfterEntry',
  'daysBefore',
  'description',
  'displayOrder',
  'enabled',
  'entryEmailRules',
  'formRef',
  'includeSubordinates',
  'initiatorType',
  'mode',
  'name',
  'note',
  'orgIds',
  'priority',
  'probationResult',
  'reason',
  'remark',
  'sequenceNo',
  'term',
  'title',
  'todoType',
  'unrestrictTargetDepartment',
];

/** 租户管理员读任职设置配置对象（字典写入按它授权）：可新增 / 编辑非系统字段，不可删除，没有按钮。 */
export const settingsPermission = {
  objectCode: 'TenantBase.EmploymentSettings',
  dataOperations: { create: true, update: true, delete: false },
  viewableFields: [...settingsFields, ...system].sort(),
  editableFields: [...settingsFields].sort(),
  buttons: [] as { buttonCode: string; level: string }[],
};

/** 字典行：GET exits/dictionaries/:dict 的 items 项固定六个键（exit-dictionaries.ts columns）。 */
export const presets = {
  types: [
    { code: 'voluntary', name: '主动离职' },
    { code: 'involuntary', name: '被动离职' },
  ],
  reasons: [
    { code: 'personal', name: '个人原因' },
    { code: 'family', name: '家庭原因' },
  ],
  whereabouts: [
    { code: 'other_industry', name: '离职去其他行业' },
    { code: 'same_industry', name: '离职去同行业' },
    { code: 'startup', name: '自主创业' },
  ],
} as const;
export type Kind = keyof typeof presets;
export interface EntryRow {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  displayOrder: number;
  revision: number;
}
let sequence = 0;
export const rowId = () => `60000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
export function presetRows(kind: Kind): EntryRow[] {
  return presets[kind].map((preset, index) => ({
    id: rowId(),
    ...preset,
    enabled: true,
    displayOrder: (index + 1) * 10,
    revision: 1,
  }));
}
