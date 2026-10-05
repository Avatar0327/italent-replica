/** 本租户标准配置（13 §3/6），演示 YG 类型与语义待定类型不作为出厂字典。 */
export type TransferFieldMode = 'editable' | 'readonly' | 'hidden' | 'absent';
export interface TransferTypeDefinition {
  readonly code: string;
  readonly name: string;
  readonly effectiveDate: string;
  readonly enabled: boolean;
  readonly displayOrder: number | null;
  readonly formId: string;
}
export interface TransferReasonDefinition {
  readonly code: string;
  readonly name: string;
  readonly effectiveDate: string;
  readonly enabled: boolean;
  readonly displayOrder: number | null;
  readonly transferTypeCode: string | null;
}
export interface TransferFormDefinition {
  readonly id: string;
  readonly name: string;
  readonly isStandard: boolean;
  readonly processCode: string;
  readonly excludedAutofillFields: readonly string[];
}
const view = (name: string) => `TenantBase.${name}TransferMultiFormView`;
const type = (code: string, name: string, effectiveDate: string, displayOrder: number | null, form = '') => ({
  code,
  name,
  effectiveDate,
  displayOrder,
  enabled: true,
  formId: view(form),
});
export const TRANSFER_TYPES: readonly TransferTypeDefinition[] = [
  type('cross_department', '跨部门调动', '1900-01-01', 1, 'CrossDepartment'),
  type('job_post', '职务职位调整', '1900-01-01', 2, 'JobPost'),
  type('job_level', '职级调整', '1900-01-01', 3, 'JobLevel'),
  type('in_department', '部门内调岗', '2010-01-01', 4),
  type('workplace', '工作地调整', '2010-01-01', 5),
  type('reporting_line', '汇报关系调整', '2010-01-01', 6),
  type('cross_unit', '跨单位调动', '2010-06-26', 7, 'InterOrg'),
  type('promotion_level', '晋级', '2000-01-01', null),
  type('lateral', '平调', '2000-01-01', null),
  type('demotion', '降职', '2000-01-01', null),
  type('demotion_level', '降级', '2000-01-01', null),
  type('promotion', '晋升', '2000-01-01', null),
];
const reason = (
  code: string,
  name: string,
  effectiveDate: string,
  displayOrder = 0,
  transferTypeCode: string | null = null,
) => ({ code, name, effectiveDate, displayOrder, transferTypeCode, enabled: true });
export const TRANSFER_REASONS: readonly TransferReasonDefinition[] = [
  reason('demotion', '降职', '2023-01-01'),
  reason('promotion', '升职', '2023-01-01'),
  reason('expatriation', '外派', '2005-08-19'),
  reason('salary_adjustment', '薪资调整', '2025-07-22'),
  reason('department_closure', '部门撤销转移', '2025-07-01', 0, 'cross_department'),
  reason('secondment', '借调', '2026-02-08', 0, 'job_post'),
  reason('lateral', '平调', '2010-01-01', 1),
];
const transferExclusions = ['departmentId', 'positionId', 'directManagerId', 'dottedManagerId'];
const interOrgExclusions = [...transferExclusions, 'levelId', 'gradeId'];
const form = (name: string, label: string, excluded: readonly string[], processCode = 'TransferProcessNew') => ({
  id: view(name),
  name: label,
  isStandard: true,
  processCode,
  excludedAutofillFields: excluded,
});

// TODO(需取证 #62)：业务单元待明确引用模型后接入；不得以部门字段冒充。
export const TRANSFER_FORMS: readonly TransferFormDefinition[] = [
  form('', '调动', transferExclusions),
  form('CrossDepartment', '跨部门调动', transferExclusions),
  form('Industry', '调动（门店首页）', transferExclusions),
  form('Emp', '机构内调动申请', transferExclusions),
  { ...form('InterOrg', '机构间调入申请', interOrgExclusions) },
  {
    ...form('InterOrg', '机构间调入申请（门店首页）', interOrgExclusions),
    id: 'TenantBase.IndustryOrgApplyForTransferFormView',
  },
  form('JobLevel', '职级调整', ['levelId', 'gradeId']),
  form('JobPost', '职务职位调整', ['positionId', 'postId', 'levelId', 'gradeId', 'sequenceId']),
  ...Array.from({ length: 7 }, (_, index) =>
    form(`Customized${index + 1}`, `调动类型${index + 1}`, transferExclusions, `Customized${index + 1}TransferFlow`),
  ),
  ...['CrossDepartment', 'JobLevel', 'JobPost'].map((name) => {
    const source =
      name === 'JobLevel'
        ? ['levelId', 'gradeId']
        : name === 'JobPost'
          ? ['positionId', 'postId', 'levelId', 'gradeId', 'sequenceId']
          : transferExclusions;
    const label = name === 'JobLevel' ? '职级调整' : name === 'JobPost' ? '职务职位调整' : '跨部门调动';
    return form(`Personal${name}`, `${label}（人事申请）`, source);
  }),
  ...Array.from({ length: 7 }, (_, index) =>
    form(
      `PersonalCustomized${index + 1}`,
      `调动类型${index + 1}（人事申请）`,
      transferExclusions,
      `Customized${index + 1}TransferFlow`,
    ),
  ),
];

export function sortTransferDictionary<T extends { code: string; displayOrder: number | null }>(items: T[]): T[] {
  // DEC-038：顺序空值最后、并列按编码。
  return items.sort(
    (a, b) =>
      (a.displayOrder ?? Number.MAX_SAFE_INTEGER) - (b.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
      a.code.localeCompare(b.code),
  );
}
