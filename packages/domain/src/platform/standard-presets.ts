/**
 * 平台开通时下发的标准业务身份（REQ-PLT-001 R2；R1-T17）。原站平台层对租户不可见，这里按租户侧痕迹定：
 * 身份名称与描述取自本租户组织员工应用的可授予身份（docs/02_业务建模/06 §3.3），许可类型按“核心人力用户”（06 §4）。
 * 数据范围一律不在身份里预置（硬规则：默认空），唯一例外是 DEC-121：标准 HR 身份对无组织字段的对象（职务字典、
 * 编制方案）预置“看全部”，开箱效果与原站一致（`11` §17）；有组织字段的对象（职位、组织编制等）仍按管理单元裁剪。
 */
import { APPROVAL_OBJECTS, APPROVAL_PROCESS_OBJECT } from '../approval/catalog.js';
import { MODULE_OBJECTS, ORG_EMPLOYEE_APP } from '../permission/module-actions.js';
import type { ObjectDefinition, ObjectPermission } from '../permission/object-permission.js';
import { PERSONNEL_OBJECTS } from '../personnel/catalog.js';
import { SURVEY360_APP, SURVEY360_PROFILES } from '../survey360/catalog.js';

/**
 * 编制方案的“看全部”目标（数据源类）：编制方案与组织编制共用对象 OrganizationEstablishment，对象级看全部会连带放开
 * 有组织字段的组织编制。编制方案的读写接口把它作为身份看全部的附加目标（不改变页面 / 数据源编码与其上的策略），
 * DEC-121 只对它预置看全部。
 */
export const ESTABLISHMENT_SCHEME_DATASOURCE = `${MODULE_OBJECTS.establishment.code}.scheme`;

/** DEC-121：标准 HR 身份预置“看全部”的无组织字段对象（对象级）与数据源。 */
export const NO_ORG_FIELD_SEE_ALL = {
  entities: [
    MODULE_OBJECTS.jobLayer.code,
    MODULE_OBJECTS.jobGrade.code,
    MODULE_OBJECTS.jobLevelType.code,
    MODULE_OBJECTS.jobLevel.code,
    MODULE_OBJECTS.jobSequence.code,
    MODULE_OBJECTS.jobProfessionalLine.code,
    MODULE_OBJECTS.jobPost.code,
  ],
  dataSources: [ESTABLISHMENT_SCHEME_DATASOURCE],
} as const;

export interface StandardProfile {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly licenseType: string | null;
  readonly apps: readonly string[];
  readonly objects: readonly ObjectPermission[];
  /** 是否为标准 HR 身份（DEC-121 预置无组织字段对象的看全部）。 */
  readonly hr: boolean;
}

/** 系统配置类对象由“其他设置”管理员能力控制，不进业务身份（permission/authorizer.ts 的 CONFIG_OBJECTS）。 */
const CONFIG_OBJECTS = new Set<string>([
  MODULE_OBJECTS.employmentSettings.code,
  MODULE_OBJECTS.employmentCustomField.code,
  MODULE_OBJECTS.contractSettings.code,
  MODULE_OBJECTS.contractRules.code,
]);

const BUSINESS_OBJECTS: readonly ObjectDefinition[] = [
  ...Object.values(MODULE_OBJECTS).filter((o) => !CONFIG_OBJECTS.has(o.code)),
  ...APPROVAL_OBJECTS,
  ...PERSONNEL_OBJECTS,
];

/** 全部字段可见、非系统字段可编辑、全部按钮与数据操作。 */
function full(definition: ObjectDefinition): ObjectPermission {
  return {
    objectCode: definition.code,
    dataOperations: { create: true, update: true, delete: true },
    fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: !f.system })),
    buttons: definition.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
  };
}

/** 只读：字段可见，无按钮、无数据操作。 */
function readOnly(definition: ObjectDefinition): ObjectPermission {
  return {
    objectCode: definition.code,
    dataOperations: { create: false, update: false, delete: false },
    fields: definition.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false })),
    buttons: [],
  };
}

const MANAGER_OBJECTS = new Set<string>([
  MODULE_OBJECTS.employee.code,
  MODULE_OBJECTS.employmentRecord.code,
  ...PERSONNEL_OBJECTS.map((o) => o.code),
]);

const CORE_HR = 'core_hr';

export const STANDARD_PROFILES: readonly StandardProfile[] = [
  {
    code: 'standard_org_system_admin',
    name: '标准版系统管理员（组织员工）',
    description: '拥有组织员工的所有业务功能的权限',
    licenseType: CORE_HR,
    apps: [ORG_EMPLOYEE_APP],
    objects: BUSINESS_OBJECTS.map(full),
    hr: true,
  },
  {
    code: 'standard_hr_admin',
    name: '人事管理员（组织员工）',
    description: '人事管理员',
    licenseType: CORE_HR,
    apps: [ORG_EMPLOYEE_APP],
    objects: BUSINESS_OBJECTS.map(full),
    hr: true,
  },
  {
    // 原站描述“相比人事管理员……除去了设置菜单”：不含流程配置对象
    code: 'standard_hr_specialist',
    name: '人事专员（组织员工）',
    description: '相比人事管理员除去了设置菜单',
    licenseType: CORE_HR,
    apps: [ORG_EMPLOYEE_APP],
    objects: BUSINESS_OBJECTS.filter((o) => o.code !== APPROVAL_PROCESS_OBJECT).map(full),
    hr: true,
  },
  {
    // 经理自助须显式授权（C-003 复核，06 §8）；数据范围由汇报关系规则给出，不预置看全部
    code: 'standard_manager',
    name: '经理身份（组织员工）',
    description: '经理若要查看并使用组织人事产品的经理自助端功能，须对此身份配置相应权限',
    licenseType: null,
    apps: [ORG_EMPLOYEE_APP],
    objects: BUSINESS_OBJECTS.filter((o) => MANAGER_OBJECTS.has(o.code)).map(readOnly),
    hr: false,
  },
  // DEC-280①②：三类内置 360 身份，由企业管理员在“用户授权”里授予；不消耗许可，数据范围不预置
  ...SURVEY360_PROFILES.map((p) => ({ ...p, licenseType: null, apps: [SURVEY360_APP], hr: false })),
];

/** 开通时授予首位租户管理员的业务身份，使其能查看与配置出厂流程等业务对象（占一个核心人力名额）。 */
export const FIRST_ADMIN_PROFILE = 'standard_org_system_admin';
