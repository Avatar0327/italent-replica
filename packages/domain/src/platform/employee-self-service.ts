/**
 * 自动员工身份 employee_self_service 的出厂默认值（DEC-205 / DEC-209 / DEC-399 / DEC-402；契约
 * docs/08_设计/R3-T02_C1-2b_员工身份_契约.md §2.1）。这是这些默认值的**唯一来源**：标准身份定义（standard-presets.ts）与
 * 本人入口在租户里没有身份行时的兜底值（employee-self-service/policy.ts）都由这里推出，不能各写一份。
 */
import type { ButtonGrant, ObjectDefinition } from '../permission/object-permission.js';

/** 身份编码：沿用旧编码，租户手工建过同编码身份时按 CODE_TAKEN 处理（DEC-402⑤）。 */
export const EMPLOYEE_SELF_SERVICE_CODE = 'employee_self_service';

/** DEC-205：员工本人发起调动时可见且可编辑的任职字段。 */
export const EMPLOYEE_DEFAULT_EDIT_FIELDS: readonly string[] = [
  'effectiveDate',
  'reasonCode',
  'departmentId',
  'directManagerId',
];

/** DEC-209：员工发起业务的只读上限（可见、不可编辑），不因入口或额外身份的编辑权放开。 */
export const EMPLOYEE_READONLY_FIELDS: readonly string[] = ['postId', 'levelId', 'sequenceId'];

/** DEC-205：员工可新建（发起）任职业务；不可修改、删除。 */
export const EMPLOYEE_DEFAULT_CREATE = true;

/**
 * 本人调动的三个功能按钮（DEC-402②）：默认允许，管理员可在“员工”身份里逐个关闭。叠加授权器只认这三个按钮，
 * 管理员给员工身份勾上其他任职按钮（如 Employment.Delete）不会经本人入口生效。
 */
export const EMPLOYEE_TRANSFER_BUTTONS: readonly ButtonGrant[] = [
  { buttonCode: 'Transfer.Self', level: 'detail' },
  { buttonCode: 'Employment.Create', level: 'detail' },
  { buttonCode: 'Employment.Submit', level: 'detail' },
];

/** 任职资格应用里员工可见的页面（DEC-399②，载体对象 Qualification.Pages 上的 app_page 按钮，契约 §3）。 */
export const EMPLOYEE_PAGES = ['EmployeeDevelopmentChannel'] as const;
export type EmployeePage = (typeof EMPLOYEE_PAGES)[number];

/** DEC-790：专属字段载体不并入任职默认字段，管理员仍通过身份对象权限配置。 */
export const SELF_APPLICATION_FIELDS = {
  exit: ['lastWorkDate', 'reasonCode', 'whereaboutsCode'],
  partTime: ['partTimeType', 'effectiveDate', 'endDate', 'departmentId', 'directManagerId', 'requestRemark'],
} as const;
export type SelfApplicationKind = keyof typeof SELF_APPLICATION_FIELDS;
export const SELF_APPLICATION_BUTTONS = { exit: 'Exit.Self', partTime: 'PartTime.Self' } as const;
export const EMPLOYEE_SELF_SERVICE_BUTTONS: readonly ButtonGrant[] = [
  ...EMPLOYEE_TRANSFER_BUTTONS,
  ...Object.values(SELF_APPLICATION_BUTTONS).map((buttonCode) => ({ buttonCode, level: 'detail' as const })),
];
function applicationObject(kind: SelfApplicationKind): ObjectDefinition {
  return {
    code: kind === 'exit' ? 'TenantBase.SelfExit' : 'TenantBase.SelfPartTime',
    application: 'TenantBase',
    fields: [
      ...SELF_APPLICATION_FIELDS[kind].map((code) => ({ code, system: false })),
      ...EMPLOYEE_READONLY_FIELDS.map((code) => ({ code, system: true })),
    ],
    buttons: [],
  };
}
export const SELF_APPLICATION_OBJECTS = {
  exit: applicationObject('exit'),
  partTime: applicationObject('partTime'),
};
