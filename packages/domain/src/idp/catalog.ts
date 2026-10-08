/**
 * 个人发展计划 IDP 的权限对象目录与枚举（docs/02_业务建模/28 §1、§2 与 Q-M0-115 补充；DEC-080 真实字段与按钮）。
 * IDP 是独立应用 `IDP`（`28` 边界，挂在「继任与发展」菜单下）：对象只能配置进、也只在登记了该应用的身份里生效，
 * 数据范围按（用户 × IDP）存一份（DEC-043），缺省为空。
 * 库内存英文代码；原站数字编号写在注释里，供导入映射（Q-M0-115 ①②④）。
 */
import type { ButtonDefinition, ObjectDefinition } from '../permission/object-permission.js';

export const IDP_APP = 'IDP';

/** 子流程类别（SubProcess.类别）：制定计划 1 / 回顾 2 / 总结评价 3。名称与类别不必一致（Q-M0-115 样本）。 */
export const SUB_PROCESS_CATEGORIES = ['plan', 'review', 'evaluation'] as const;
export type SubProcessCategory = (typeof SUB_PROCESS_CATEGORIES)[number];

/**
 * 子流程关联的审批流程类别（SubProcess.名称 / 关联审批流程）：制定计划 1 / 中期回顾 2 / 末期回顾 3。
 * 对应审批中心的三个 IDP 审批类型（DEC-017 按类型隔离），子流程另指定该类型下一条已发布流程（口径 K-08）。
 */
export const IDP_APPROVAL_TYPES = ['idp_plan', 'idp_mid_review', 'idp_final_review'] as const;
export type IdpApprovalType = (typeof IDP_APPROVAL_TYPES)[number];

/** 开启方式：自动 1 / 手动 100。 */
export const START_MODES = ['auto', 'manual'] as const;
export type StartMode = (typeof START_MODES)[number];

/** 发起时间类型：固定时间 0 / 相对时间 1；自动开启不设规则时为空（= 上一阶段结束即开启，K-06）。 */
export const START_TIME_TYPES = ['fixed', 'relative'] as const;
export type StartTimeType = (typeof START_TIME_TYPES)[number];

/** 参照时间点：发展计划开始时间、发展计划结束时间、上一阶段结束时间、任职记录.生效时间。 */
export const REFERENCE_POINTS = ['plan_start', 'plan_end', 'previous_end', 'employment_effective'] as const;
export type ReferencePoint = (typeof REFERENCE_POINTS)[number];

/** 始于：当天 0 / 前 N 天 1 / 后 N 天 2。 */
export const START_FROM = ['same_day', 'before', 'after'] as const;
export type StartFrom = (typeof START_FROM)[number];

/**
 * 模板模块类型（moduleType）：基本信息 0、发展目标 2、回顾 3、总结 4、综述 6（Q-M0-115④）；
 * 关键信息、盘点结果的原站编号未取到，复刻记作 1 / 5（🟡 K-10）。
 */
export const MODULE_TYPES = ['basic', 'key_info', 'goal', 'review', 'summary', 'talent_review', 'analysis'] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** 胜任力来源五选（IDP-R8）；“所属人才池”取出池标准（G-056 ✅）。原站编号未取到（🟡 K-13）。 */
export const COMPETENCY_SOURCES = [
  'current_position',
  'succession_position',
  'rotation_position',
  'promotion_position',
  'talent_pool',
] as const;
export type CompetencySource = (typeof COMPETENCY_SOURCES)[number];

/** 关键信息来源（IDP-R7）：职业发展、轮岗、带教、储备人才（人才池）。 */
export const KEY_INFO_SOURCES = ['career', 'work_shift', 'tutorship', 'talent_pool'] as const;
export type KeyInfoSource = (typeof KEY_INFO_SOURCES)[number];

/** 盘点结果模块：时间基准取盘点项目开始 / 结束时间，计划基准取计划开始 / 结束时间（IDP-R11）。 */
export const REVIEW_TIME_BASES = ['project_start', 'project_end'] as const;
export const PLAN_TIME_BASES = ['plan_start', 'plan_end'] as const;

/**
 * 按流程节点配置的可用按钮（DEC-296④，Q-M0-115④ activitySettings.buttonList）。学习计划的“编辑 / 发布学习计划”
 * 不做（派发“不做”）。综述 / 回顾 / 总结模块原站另有节点设置但结构未取证，复刻用“填写本模块”（🟡 K-12）。
 */
export const GOAL_NODE_BUTTONS = ['RowAddIdpGoal', 'RowEditIdpGoal', 'RowDeleteIdpGoal'] as const;
export const CONTENT_NODE_BUTTONS = ['EditModuleContent'] as const;
export type NodeButton = (typeof GOAL_NODE_BUTTONS)[number] | (typeof CONTENT_NODE_BUTTONS)[number];

/** 自动开启统一在凌晨 2 点（租户时区，DEC-296⑤ / DEC-056）。 */
export const AUTO_START_HOUR = 2;

const SYSTEM_FIELDS = ['id', 'revision', 'createdBy', 'createdAt', 'updatedAt'];
const crud: readonly ButtonDefinition[] = [
  { code: 'create', level: 'list', requires: 'create' },
  { code: 'update', level: 'detail', requires: 'update' },
  { code: 'delete', level: 'detail', requires: 'delete' },
];

function object(
  code: string,
  fields: readonly string[],
  system: readonly string[] = [],
  buttons: readonly ButtonDefinition[] = crud,
): ObjectDefinition {
  return {
    code: `${IDP_APP}.${code}`,
    application: IDP_APP,
    fields: [
      ...fields.map((field) => ({ code: field, system: false })),
      ...[...SYSTEM_FIELDS, ...system].map((field) => ({ code: field, system: true })),
    ],
    buttons,
  };
}

/** 子流程的可写字段（嵌套在流程里整组提交）。 */
export const SUB_PROCESS_FIELDS = [
  'name',
  'category',
  'approvalType',
  'approvalProcessId',
  'startMode',
  'startTimeType',
  'fixedDate',
  'referencePoint',
  'startFrom',
  'days',
] as const;

/** 模板模块的可写字段（各模块类型只用其中一部分，其余为空）。 */
export const TEMPLATE_MODULE_FIELDS = [
  'moduleType',
  'name',
  'description',
  'displayOrder',
  'allowCustomGoal',
  'allowLibraryGoal',
  'competencySource',
  'goalReviewEnabled',
  'taskEnabled',
  'checkNoneGoal',
  'keyInfoSources',
  'reviewTimeBasis',
  'planTimeBasis',
  'reviewCategoryIds',
  'nodeSettings',
] as const;

export const IDP_OBJECTS = {
  /** 发展计划流程 IDPProcess：名称、所属组织、是否向下公开、是否启用；子流程是它的组成部分。 */
  process: object('IDPProcess', ['name', 'orgId', 'publicDown', 'enabled', 'subProcesses'], ['referenced']),
  /** 子流程 SubProcess（顺序由流程内位置决定，seq 只读；开启规则说明文本 ruleText 只读）。 */
  subProcess: object('SubProcess', SUB_PROCESS_FIELDS, ['seq', 'ruleText'], []),
  /** 发展计划模板 IDPTemplate。 */
  template: object(
    'IDPTemplate',
    ['name', 'description', 'orgId', 'publicDown', 'processId', 'modules', 'commonGoals'],
    ['status', 'referenced'],
    [
      ...crud,
      { code: 'copy', level: 'detail', requires: 'create' },
      { code: 'publish', level: 'detail', requires: 'update' },
      { code: 'unpublish', level: 'detail', requires: 'update' },
    ],
  ),
  /** 发展计划模块 IDPTemplateModule（模块配置 + 按流程节点的可用按钮，DEC-296④）。 */
  templateModule: object('IDPTemplateModule', TEMPLATE_MODULE_FIELDS),
  /** 模板通用目标 IDPTemplateCommonGoal（只对之后新发起的计划生效，IDP-R9）。 */
  commonGoal: object('IDPTemplateCommonGoal', ['moduleId', 'name', 'measure', 'suggestion', 'displayOrder']),
} as const satisfies Record<string, ObjectDefinition>;

export type IdpObject = keyof typeof IDP_OBJECTS;
