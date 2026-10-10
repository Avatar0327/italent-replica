/**
 * 平台开通时下发的标准业务身份（REQ-PLT-001 R2；R1-T17）。原站平台层对租户不可见，这里按租户侧痕迹定：
 * 身份名称与描述取自本租户组织员工应用的可授予身份（docs/02_业务建模/06 §3.3），许可类型按“核心人力用户”（06 §4）。
 * 数据范围一律不在身份里预置（硬规则：默认空），唯一例外是 DEC-121：标准 HR 身份对无组织字段的对象（职务字典、
 * 编制方案）预置“看全部”，开箱效果与原站一致（`11` §17）；有组织字段的对象（职位、组织编制等）仍按管理单元裁剪。
 * 人才标准管理员（DEC-281⑩）同一口径：只对无组织字段的发展建议类型字典预置看全部，其余按管理单元。
 */
import { APPROVAL_OBJECTS, APPROVAL_PROCESS_OBJECT } from '../approval/catalog.js';
import { MODULE_OBJECTS, ORG_EMPLOYEE_APP } from '../permission/module-actions.js';
import type { ObjectDefinition, ObjectPermission } from '../permission/object-permission.js';
import { EVALUATION_APP, EVALUATION_OBJECTS } from '../evaluation/catalog.js';
import { EVALUATION_FLOW_OBJECTS } from '../evaluation/flow-catalog.js';
import { PERSONNEL_OBJECTS } from '../personnel/catalog.js';
import { QUALIFICATION_APP, QUALIFICATION_OBJECTS } from '../qualification/catalog.js';
import { SURVEY360_APP, SURVEY360_PROFILES } from '../survey360/catalog.js';
import { TALENT_APP, TALENT_OBJECTS } from '../talent/catalog.js';
import {
  TALENT_REVIEW_APP,
  TALENT_REVIEW_CONFIG_OBJECTS,
  TALENT_REVIEW_OBJECTS,
  TALENT_REVIEW_SEE_ALL_UNAPPROVED,
} from '../talent-review/catalog.js';
import {
  SUCCESSION_APP,
  SUCCESSION_CONFIG_OBJECTS,
  SUCCESSION_OBJECTS,
  type SuccessionObject,
} from '../succession/catalog.js';

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

/** 身份上预置“看全部”的目标（应用 × 实体 / 数据源）。 */
export interface PresetSeeAllTarget {
  readonly appCode: string;
  readonly targetKind: 'entity' | 'datasource';
  readonly targetCode: string;
}

export interface StandardProfile {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly licenseType: string | null;
  readonly apps: readonly string[];
  readonly objects: readonly ObjectPermission[];
  /** 是否为标准 HR 身份（DEC-121 预置无组织字段对象的看全部）。 */
  readonly hr: boolean;
  /** 其他应用的身份按同一口径预置看全部的无组织字段对象（如人才标准的发展建议类型字典）。 */
  readonly seeAll?: readonly PresetSeeAllTarget[];
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

/** 指定数据操作与按钮（按钮编码，含全部级别）；字段全部可见、非系统字段可编辑。 */
function partial(
  definition: ObjectDefinition,
  operations: readonly ('create' | 'update' | 'delete')[],
  buttons: readonly string[],
): ObjectPermission {
  return {
    ...full(definition),
    dataOperations: {
      create: operations.includes('create'),
      update: operations.includes('update'),
      delete: operations.includes('delete'),
    },
    buttons: definition.buttons
      .filter((b) => buttons.includes(b.code))
      .map((b) => ({ buttonCode: b.code, level: b.level })),
  };
}

const succession = (object: SuccessionObject) => SUCCESSION_OBJECTS[object];
const ALL_WRITES = ['create', 'update', 'delete'] as const;

/**
 * R3-T05 设计 §8.1 的三个标准身份。数据范围一律不预置（硬规则：默认空），由租户管理员按（用户 ×
 * SuccessionAndDevelopment）授予；唯一例外与人才盘点同口径：没有组织字段的规则配置对象按 DEC-121 给继任管理员预置
 * 看全部，否则无人能维护规则。现有标准 HR 身份不自动获得继任权限；许可归属未取证（🟡），与人才标准管理员同口径不占名额。
 */
const SUCCESSION_PROFILES: readonly StandardProfile[] = [
  {
    code: 'standard_succession_admin',
    name: '继任管理员（继任与发展）',
    description: '拥有继任管理的全部功能，可见数据按数据范围控制',
    licenseType: null,
    apps: [SUCCESSION_APP],
    objects: Object.values(SUCCESSION_OBJECTS).map(full),
    hr: false,
    seeAll: SUCCESSION_CONFIG_OBJECTS.map((key) => ({
      appCode: SUCCESSION_APP,
      targetKind: 'entity' as const,
      targetCode: succession(key).code,
    })),
  },
  {
    // HR：继任记录、地图、结果与任务；不含规则配置（HR 读规则正文一律 403，§8.3）；批次终止只给管理员（§2.2 #17）
    code: 'standard_succession_hr',
    name: '继任 HR（继任与发展）',
    description: '维护继任记录与地图，可见数据按数据范围控制',
    licenseType: null,
    apps: [SUCCESSION_APP],
    objects: [
      ...(['record', 'map', 'riskResult', 'healthResult', 'calcRun'] as const).map((key) => full(succession(key))),
      partial(succession('syncBatch'), ALL_WRITES, ['sync', 'retry']),
    ],
    hr: false,
  },
  {
    // 继任侧系统主体（§4.0，succession.system_principal_user_id 指向的服务账号）：同步与计算的目标写入身份
    code: 'standard_succession_runner',
    name: '继任计算主体（继任与发展）',
    description: '继任同步与计算的系统主体身份，可写范围由租户管理员授予',
    licenseType: null,
    apps: [SUCCESSION_APP],
    objects: [
      partial(succession('record'), ALL_WRITES, ['create', 'update', 'delete']),
      partial(succession('riskResult'), ['update'], ['assign']),
      partial(succession('healthResult'), ['update'], ['assign', 'reset']),
      partial(succession('map'), [], ['computeRisk', 'computeHealth', 'computeStats']),
    ],
    hr: false,
  },
];

/**
 * R3-T02 的三个预置身份（Q-T02-02，DEC-331②，规格 23 §14；设计 §1.3）。数据范围一律不预置（硬规则：默认空）：
 * 与继任 / 盘点不同，这里**不**对没有组织字段的字典（层级、等级方案、编码规则；活动类型、周期、通用评分项）预置看全部，
 * 由租户管理员按（用户 × 应用）授予；原站说明评定管理员授权时人才评定、任职资格两个应用各设管理单元。
 * 各身份的功能明细原站未逐项展开（🟡）。许可归属未取证，与人才标准管理员同口径不占名额。
 * TODO(需取证 #202，C1-2b)：预置员工身份的发展通道查看授权（Q-T02-20 ①，登记项 qualification/employee-profile-grants）——
 * employee_self_service 目前没有预置行，装到哪一行身份待定；确定前不装，也不往租户自定义身份里写授权。
 */
const QUALIFICATION_PROFILES: readonly StandardProfile[] = [
  {
    code: 'standard_qualification_admin',
    name: '任职资格系统管理员（任职资格）',
    description: '拥有任职资格的全部业务功能，可见数据按数据范围控制',
    licenseType: null,
    apps: [QUALIFICATION_APP],
    objects: Object.values(QUALIFICATION_OBJECTS).map(full),
    hr: false,
  },
  {
    // 全部信息，含活动设置 / 基础设置：配置对象 + 流程对象；活动、评价表、发展通道引用类别 / 级别 / 指标 / 标准时被引用
    // 对象须有对象查看权（设计 §5.2，DEC-352），所以在任职资格应用里只读这四个对象（🟡）
    code: 'standard_evaluation_admin',
    name: '评定管理员（人才评定）',
    description: '拥有人才评定的全部信息，含活动设置与基础设置，可见数据按数据范围控制',
    licenseType: null,
    apps: [EVALUATION_APP, QUALIFICATION_APP],
    objects: [
      ...Object.values(EVALUATION_OBJECTS).map(full),
      ...Object.values(EVALUATION_FLOW_OBJECTS).map(full),
      ...(['category', 'level', 'target', 'standard'] as const).map((key) => readOnly(QUALIFICATION_OBJECTS[key])),
    ],
    hr: false,
  },
  {
    // 只含流程对象：评定过程 / 评定记录（不含活动设置与基础设置）
    code: 'standard_evaluation_specialist',
    name: '评定专员（人才评定）',
    description: '维护评定过程与评定记录，可见数据按数据范围控制',
    licenseType: null,
    apps: [EVALUATION_APP],
    objects: Object.values(EVALUATION_FLOW_OBJECTS).map(full),
    hr: false,
  },
];

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
    // DEC-281⑨⑩（`23` §7 ③）：原站预置身份，拥有人才标准全部功能，可见数据按管理单元控制——不预置看全部，
    // 数据范围仍默认空，授予时为用户 × TalentCenter 选管理单元（DEC-043）。唯一例外是没有组织字段的发展建议类型字典，
    // 按 DEC-121 同口径预置看全部，否则管理员无法维护下拉选项。
    // DEC-294④（`23` §8 ④）：不占许可名额（原站许可项里没有人才标准，按计费规则推断）。
    code: 'standard_talent_admin',
    name: '人才标准管理员（人才标准）',
    description: '拥有人才标准的全部功能，可见数据按管理单元控制',
    licenseType: null,
    apps: [TALENT_APP],
    objects: Object.values(TALENT_OBJECTS).map(full),
    hr: false,
    seeAll: [{ appCode: TALENT_APP, targetKind: 'entity', targetCode: TALENT_OBJECTS.descriptionType.code }],
  },
  {
    // R3-T04 设计 §6.1（C-06）：盘点管理员，拥有人才盘点全部功能，可见数据按（用户 × TalentReview）的范围控制，
    // 不预置看全部；只对没有组织字段的设置类对象（准备度等）按 DEC-121 预置看全部，否则管理员无法维护字典。
    // 许可归属未取证（🟡），与人才标准管理员同口径不占名额。
    code: 'standard_talent_review_admin',
    name: '盘点管理员（人才盘点）',
    description: '拥有人才盘点的全部功能，可见数据按数据范围控制',
    licenseType: null,
    apps: [TALENT_REVIEW_APP],
    objects: Object.values(TALENT_REVIEW_OBJECTS).map(full),
    hr: false,
    seeAll: TALENT_REVIEW_CONFIG_OBJECTS.filter((key) => !TALENT_REVIEW_SEE_ALL_UNAPPROVED.includes(key)).map(
      (key) => ({
        appCode: TALENT_REVIEW_APP,
        targetKind: 'entity' as const,
        targetCode: TALENT_REVIEW_OBJECTS[key].code,
      }),
    ),
  },
  ...SUCCESSION_PROFILES,
  ...QUALIFICATION_PROFILES,
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

/** 标准身份开通时预置“看全部”的全部目标：标准 HR 身份的 DEC-121 无组织字段对象，加上身份自己登记的目标。 */
export function presetSeeAllTargets(profile: StandardProfile): PresetSeeAllTarget[] {
  const hr: PresetSeeAllTarget[] = profile.hr
    ? [
        ...NO_ORG_FIELD_SEE_ALL.entities.map((code) => ({
          appCode: ORG_EMPLOYEE_APP,
          targetKind: 'entity' as const,
          targetCode: code,
        })),
        ...NO_ORG_FIELD_SEE_ALL.dataSources.map((code) => ({
          appCode: ORG_EMPLOYEE_APP,
          targetKind: 'datasource' as const,
          targetCode: code,
        })),
      ]
    : [];
  return [...hr, ...(profile.seeAll ?? [])];
}
